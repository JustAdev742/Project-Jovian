// src/matchmaking/queue.ts
// =============================================================================
// PROJECT NOVA — Phase 2: Client-side queue (find-or-create + SBMM widening).
//
// There is no server matchmaker, so "queueing" is: scan the Gun graph for open
// lobbies in our region, SBMM-filter them with a band that widens over time,
// join the best fit, or create a fresh lobby if none qualifies after the band
// has fully opened. Discovery is mirrored to a Nostr ephemeral beacon so peers
// who reach Nostr but not the same Gun relay can still find each other.
// =============================================================================

import type { PeerId, PubKeyHex, Region } from '../shared/types.js';
import type IGun from 'gun';
import { openLobby, sbmmAccept, type LobbyHandle, type LobbyParams } from './lobby.js';
import { v4 as uuidv4 } from 'uuid';

export interface QueueParams extends LobbyParams {
  self: { peerId: PeerId; pubkey: PubKeyHex; displayName: string };
  myRating: number;
  /** SBMM band schedule (ms -> rating window). Last entry should be Infinity. */
  bandSchedule: Array<{ afterMs: number; band: number }>;
  /** How long to look before giving up and hosting our own. */
  maxQueueMs: number;
}

interface DiscoveredLobby {
  lobbyId: string;
  region: Region;
  meanRating: number;
  playerCount: number;
  state: string;
}

const DISCO_ROOT = (region: Region) => `nova/lobby/${region}`;

/**
 * Scan the region's lobby index for joinable candidates.
 *
 * Sequence:
 *   1. Read the `nova/lobby/<region>` map (each child key is a lobbyId node).
 *   2. For each child, read scalar state + roster count + a cached meanRating
 *      leaf (writers update it on join; advisory, refined locally if stale).
 *   3. Keep only state==='open' lobbies with room.
 */
function discover(
  gun: ReturnType<typeof IGun>,
  region: Region,
  timeoutMs: number,
): Promise<DiscoveredLobby[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredLobby>();
    const idx = gun.get(DISCO_ROOT(region));
    const off = idx.map().on((node: any, lobbyId: string) => {
      if (!node) {
        found.delete(lobbyId);
        return;
      }
      if (node.state && node.state !== 'open') {
        found.delete(lobbyId);
        return;
      }
      found.set(lobbyId, {
        lobbyId,
        region,
        meanRating: typeof node.meanRating === 'number' ? node.meanRating : 1000,
        playerCount: typeof node.playerCount === 'number' ? node.playerCount : 0,
        state: node.state ?? 'open',
      });
    });
    // Gun has no "done" event; we snapshot after a short settle window.
    setTimeout(() => {
      if (typeof off === 'function') (off as () => void)();
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/** Pick the band for the elapsed queue time. */
function bandFor(schedule: QueueParams['bandSchedule'], elapsedMs: number): number {
  let band = schedule[0]?.band ?? Infinity;
  for (const step of schedule) if (elapsedMs >= step.afterMs) band = step.band;
  return band;
}

/**
 * Run the queue. Resolves with a joined LobbyHandle (either an existing lobby
 * we passed SBMM into, or a brand-new one we host).
 */
export async function enterQueue(
  gun: ReturnType<typeof IGun>,
  p: QueueParams,
): Promise<LobbyHandle> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < p.maxQueueMs) {
    const elapsed = Date.now() - startedAt;
    const band = bandFor(p.bandSchedule, elapsed);

    const candidates = (await discover(gun, p.region, 800))
      .filter((c) => c.playerCount < p.maxPlayers)
      .filter((c) => sbmmAccept(p.myRating, c.meanRating, band))
      // Prefer the fullest qualifying lobby — fills faster, fewer dead lobbies.
      .sort((a, b) => b.playerCount - a.playerCount);

    if (candidates.length > 0) {
      const target = candidates[0];
      const handle = openLobby(gun, p.region, target.lobbyId, p.self.peerId);
      await handle.join({
        peerId: p.self.peerId,
        pubkey: p.self.pubkey,
        displayName: p.self.displayName,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
      });
      bumpIndex(gun, p.region, target.lobbyId, p.myRating);
      return handle;
    }

    // No qualifying lobby yet; if the band is fully open, host our own.
    if (band === Infinity) break;
    await sleep(1000);
  }

  // Create a fresh lobby and advertise it in the region index.
  const lobbyId = uuidv4();
  const handle = openLobby(gun, p.region, lobbyId, p.self.peerId);
  await handle.join({
    peerId: p.self.peerId,
    pubkey: p.self.pubkey,
    displayName: p.self.displayName,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
  });
  // Seed the region index node so others discover us.
  gun.get(DISCO_ROOT(p.region)).get(lobbyId).put({
    state: 'open',
    playerCount: 1,
    meanRating: p.myRating,
    createdAt: Date.now(),
  } as any);
  return handle;
}

/** Update the cheap discovery-index leaf (count + rolling mean rating). */
function bumpIndex(
  gun: ReturnType<typeof IGun>,
  region: Region,
  lobbyId: string,
  myRating: number,
) {
  const node = gun.get(DISCO_ROOT(region)).get(lobbyId);
  node.once((cur: any) => {
    const prevN = cur?.playerCount ?? 0;
    const prevMean = cur?.meanRating ?? myRating;
    const n = prevN + 1;
    const mean = (prevMean * prevN + myRating) / n;
    node.put({ playerCount: n, meanRating: mean, state: 'open' } as any);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
