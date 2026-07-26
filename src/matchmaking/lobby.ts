// src/matchmaking/lobby.ts
// =============================================================================
// PROJECT NOVA — Phase 2: Lobby advertisement, discovery, fill, churn.
//
// A lobby lives as a CRDT-converging node in the Gun graph at
//   nova/lobby/<region>/<lobbyId>
// Every peer reads/writes the SAME node; Gun's last-write-wins + set semantics
// give us eventually-consistent roster convergence with no server. The roster
// is modelled as a Gun *set* of presence leaves (one leaf per peer) so that two
// peers joining concurrently don't clobber each other (which a single `players`
// array field would). We project that set into the typed LobbyAdvert.players.
//
// SBMM: we approximate skill-based matchmaking by reading each candidate's
// EloRecord from the identity graph (nova/identity/<pubkey>/elo, Phase 4) and
// only auto-joining lobbies whose mean rating is within a widening band. There
// is no central matchmaker, so "SBMM" is a client-side *filter*, not a solver.
//
// NOTE ON HONESTY: maxPlayers aspires to 100 (protocol ceiling) but a single
// browser authority on a home uplink realistically sustains ~24 (PROTOCOL
// .REALISTIC_AUTHORITY_CAP). lobby fill still targets the configured size; the
// netcode layer (Phase 3) is where the real cap bites.
// =============================================================================

import type {
  PeerId,
  PubKeyHex,
  Region,
  LobbyAdvert,
  LobbyState,
  Signed,
  EpochMs,
} from '../shared/types.js';
import { PROTOCOL } from '../shared/types.js';
import type { LatencyReport } from './election.js';
import { electAuthorityChain } from './election.js';

// Gun has no first-class ESM types; we treat the chain as `any` at the boundary
// and keep all OUR logic typed. Import the singleton from the signalling layer
// so the whole app shares ONE Gun instance / relay pool.
import type IGun from 'gun';

/** Minimal shape of a roster leaf written into the Gun set. */
interface RosterLeaf {
  peerId: PeerId;
  pubkey: PubKeyHex;
  displayName: string;
  joinedAt: EpochMs;
  /** Heartbeat; leaves older than PRESENCE_TTL_MS are evicted from the roster. */
  lastSeen: EpochMs;
}

export interface LobbyParams {
  region: Region;
  maxPlayers: number;          // requested size (<=100); honest cap applies later
  /** Seconds to wait for fill before force-starting once minPlayers reached. */
  countdownSecs: number;
  minPlayers: number;          // floor to start the countdown at all
}

export interface LobbyHandle {
  lobbyId: string;
  advert(): LobbyAdvert | undefined;
  /** Live updates as the roster/state converge. */
  onUpdate(cb: (a: LobbyAdvert) => void): () => void;
  /** Join with our identity; idempotent (re-join refreshes heartbeat). */
  join(self: RosterLeaf): Promise<void>;
  /** Graceful leave (removes our roster leaf). */
  leave(self: PeerId): Promise<void>;
  /** Push a latency self-report (feeds election). */
  reportLatency(report: LatencyReport): Promise<void>;
  /** Start countdown bookkeeping; resolves with final roster when it fires. */
  watchCountdown(p: LobbyParams, onTick: (secsLeft: number) => void): void;
  close(): void;
}

const gunPath = (region: Region, lobbyId: string) =>
  `nova/lobby/${region}/${lobbyId}`;

/**
 * Open (or create) a lobby handle backed by the shared Gun instance.
 *
 * Sequence of events:
 *   1. Resolve the lobby root node `nova/lobby/<region>/<lobbyId>`.
 *   2. Subscribe to the `roster` set + scalar fields (.map().on()).
 *   3. On every change, re-project the live roster (TTL-evicting stale leaves),
 *      recompute the authorityChain locally, and emit a typed LobbyAdvert.
 *   4. join()/leave() mutate only OUR leaf — never the whole roster array.
 */
export function openLobby(
  gun: ReturnType<typeof IGun>,
  region: Region,
  lobbyId: string,
  createdBy: PeerId,
): LobbyHandle {
  const root = gun.get(gunPath(region, lobbyId));
  const rosterSet = root.get('roster');
  const latencySet = root.get('latency');

  // Local materialised view; Gun streams updates into these maps.
  const leaves = new Map<PeerId, RosterLeaf>();
  const reports = new Map<PeerId, LatencyReport>();
  let scalar: Partial<LobbyAdvert> = {};
  let matchIdSalt = lobbyId; // pre-seed salt; replaced by MatchConfig.matchId later
  const updateCbs = new Set<(a: LobbyAdvert) => void>();
  const unsubs: Array<() => void> = [];

  function liveRoster(now: EpochMs): RosterLeaf[] {
    const out: RosterLeaf[] = [];
    for (const [pid, leaf] of leaves) {
      if (now - leaf.lastSeen > PROTOCOL.PRESENCE_TTL_MS) {
        leaves.delete(pid);               // TTL eviction handles silent dropouts
        continue;
      }
      out.push(leaf);
    }
    // Deterministic order so the projected `players` array is stable everywhere.
    out.sort((a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0));
    return out;
  }

  function project(): LobbyAdvert {
    const now = Date.now();
    const roster = liveRoster(now);
    const players = roster.map((l) => l.peerId);

    // Re-derive authorityChain locally from replicated latency reports — we
    // never trust a chain that came over the wire (election.ts is pure).
    const authorityChain = electAuthorityChain({
      matchId: matchIdSalt,
      roster: players,
      reports: Object.fromEntries(reports),
      now,
    });

    return {
      lobbyId,
      region,
      createdBy,
      createdAt: scalar.createdAt ?? now,
      state: (scalar.state as LobbyState) ?? 'open',
      maxPlayers: scalar.maxPlayers ?? PROTOCOL.REALISTIC_AUTHORITY_CAP,
      players,
      authorityChain,
      seedCommitments: scalar.seedCommitments ?? {},
      matchConfig: scalar.matchConfig,
    };
  }

  function emit() {
    const a = project();
    for (const cb of updateCbs) cb(a);
  }

  // --- subscriptions ---------------------------------------------------------
  // roster set: each leaf is a node keyed by peerId.
  rosterSet.map().on((data: RosterLeaf | null, key: string) => {
    if (!data || !data.peerId) {
      leaves.delete(key as PeerId);
    } else {
      leaves.set(data.peerId, data);
    }
    emit();
  });

  latencySet.map().on((data: LatencyReport | null) => {
    if (data && data.peerId) reports.set(data.peerId, data);
    emit();
  });

  // scalar fields (state, createdAt, seedCommitments, matchConfig).
  root.on((data: Partial<LobbyAdvert> | null) => {
    if (!data) return;
    scalar = { ...scalar, ...data };
    if (data.matchConfig?.matchId) matchIdSalt = data.matchConfig.matchId;
    emit();
  });

  // Periodic local TTL sweep so dropouts vanish even without new writes.
  const sweep = setInterval(emit, PROTOCOL.PRESENCE_HEARTBEAT_MS);
  unsubs.push(() => clearInterval(sweep));

  let lastAdvert = project();
  updateCbs.add((a) => (lastAdvert = a));

  return {
    lobbyId,
    advert: () => lastAdvert,

    onUpdate(cb) {
      updateCbs.add(cb);
      cb(project());
      return () => updateCbs.delete(cb);
    },

    async join(self) {
      // Write ONLY our leaf into the set, keyed by peerId. Concurrent joins by
      // other peers touch different keys, so Gun merges them without conflict.
      const leaf: RosterLeaf = { ...self, lastSeen: Date.now() };
      rosterSet.get(self.peerId).put(leaf as any);
      // Ensure scalar createdAt exists (first writer wins under LWW; harmless).
      root.put({ createdAt: scalar.createdAt ?? Date.now(), state: 'open' } as any);
    },

    async leave(selfId) {
      // Tombstone our leaf by nulling it; Gun propagates the delete.
      rosterSet.get(selfId).put(null as any);
      leaves.delete(selfId);
      emit();
    },

    async reportLatency(report) {
      reports.set(report.peerId, report);
      latencySet.get(report.peerId).put(report as any);
    },

    watchCountdown(p, onTick) {
      // Countdown is LOCAL bookkeeping that becomes globally consistent because
      // every peer applies the same rule against the same converged roster:
      //   - start a timer once players >= minPlayers
      //   - if players reaches maxPlayers, collapse remaining time to a short
      //     lock window so a full lobby starts fast
      //   - the authority (chain[0]) is the one that actually flips state to
      //     'locked' -> 'signalling'; others just mirror the countdown for UX.
      let deadline: EpochMs | null = null;
      const tick = setInterval(() => {
        const a = project();
        const n = a.players.length;
        const now = Date.now();

        if (n >= p.minPlayers && deadline === null) {
          deadline = now + p.countdownSecs * 1000;
        }
        if (n >= p.maxPlayers && deadline !== null) {
          // Full: shrink to a 3s lock window if more time remained.
          deadline = Math.min(deadline, now + 3000);
        }
        if (n < p.minPlayers) {
          deadline = null;                 // dropped below floor -> pause timer
          onTick(p.countdownSecs);
          return;
        }
        if (deadline !== null) {
          const secsLeft = Math.max(0, Math.ceil((deadline - now) / 1000));
          onTick(secsLeft);
          if (secsLeft === 0) {
            clearInterval(tick);
            // Only the active authority writes the state transition; everyone
            // else observes it via the scalar subscription above.
            if (a.authorityChain[0] === createdBy) {
              root.put({ state: 'locked' } as any);
            }
          }
        }
      }, 1000);
      unsubs.push(() => clearInterval(tick));
    },

    close() {
      for (const u of unsubs) u();
      updateCbs.clear();
    },
  };
}

/**
 * SBMM filter. Given candidate lobbies and OUR rating, accept a lobby if its
 * mean roster rating is within `band`. Callers widen `band` over time (e.g.
 * 75 -> 150 -> 300 -> Infinity) so queue time stays bounded — exactly the
 * tradeoff a central SBMM solver makes, but evaluated client-side.
 */
export function sbmmAccept(
  myRating: number,
  lobbyMeanRating: number,
  band: number,
): boolean {
  return Math.abs(myRating - lobbyMeanRating) <= band;
}
