// src/matchmaking/election.ts
// =============================================================================
// PROJECT NOVA — Phase 2: Deterministic Authority (temporary-host) election.
//
// Every peer in a lobby runs this SAME pure function over the SAME inputs and
// arrives at the SAME ordered authorityChain — no coordinator, no voting round.
// That determinism is the whole point: if peers disagree on who the authority
// is, the mesh forks. So election MUST be a pure function of public, replicated
// state (the LobbyAdvert roster + each peer's self-reported RTT samples).
//
// Heuristic: lowest median latency wins (a low-latency host minimises the worst
// p95 fan-out delay for the star topology). Latency is self-reported and thus
// game-able, so it is ONLY a *sort key*, never a trust boundary — the consistent
// -hash tiebreak guarantees a deterministic, un-grindable order whenever latency
// is missing, equal, or implausible. Anti-cheat (Phase 5) re-validates the host.
// =============================================================================

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { PeerId, LobbyAdvert, EpochMs } from '../shared/types.js';

/**
 * A peer's advertised liveness/latency, replicated in the Gun graph at
 * `nova/lobby/<region>/<lobbyId>/latency/<peerId>`. Self-reported; advisory.
 */
export interface LatencyReport {
  peerId: PeerId;
  /** Median RTT (ms) this peer measured to the rest of the roster. */
  medianRttMs: number;
  /** Continuous connected time (ms) — favours stable peers on a tie band. */
  uptimeMs: number;
  /** When measured (TTL — stale reports are ignored). */
  measuredAt: EpochMs;
}

/** Inputs to election: the roster + whatever latency reports we have. */
export interface ElectionInput {
  matchId: string;                         // ties election to ONE match's salt
  roster: PeerId[];                        // sorted-or-not; we sort internally
  reports: Record<PeerId, LatencyReport>;  // may be partial / empty
  now: EpochMs;
}

/** Reports older than this are treated as "no sample" (peer may have stalled). */
const LATENCY_TTL_MS = 10_000;

/**
 * Latency is bucketed before it becomes a sort key. Two peers at 41ms and 43ms
 * are "the same" for host purposes; bucketing stops a peer from winning by
 * shaving 1ms off a self-reported number, and makes the consistent-hash the
 * REAL decider inside a band. 25ms buckets => 0–24, 25–49, 50–74 ...
 */
const LATENCY_BUCKET_MS = 25;

/**
 * Consistent-hash score for tiebreaks. EXACT algorithm (every peer computes
 * this identically, so the order is global):
 *
 *   h(peerId)   = sha256( utf8( matchId + "|" + peerId ) )      // 32 bytes
 *   score(peer) = big-endian uint64 of h[0..8]                  // first 8 bytes
 *
 * Lower score sorts earlier. matchId salts the hash so the SAME peer is not
 * permanently "always host" across matches (anti-grinding) and so an attacker
 * cannot precompute a vanity PeerId that always wins — they'd have to grind per
 * match against a matchId that itself depends on a commit-reveal seed (Phase 2
 * seed.ts), which is not known until after rosters lock.
 */
export function consistentHashScore(matchId: string, peerId: PeerId): bigint {
  const h = sha256(utf8ToBytes(`${matchId}|${peerId}`));
  let score = 0n;
  for (let i = 0; i < 8; i++) score = (score << 8n) | BigInt(h[i]);
  return score;
}

/** Bucket a (possibly missing/stale) latency report into a comparable integer. */
function latencyBucket(rep: LatencyReport | undefined, now: EpochMs): number {
  if (!rep) return Number.MAX_SAFE_INTEGER;                 // no sample => worst
  if (now - rep.measuredAt > LATENCY_TTL_MS) return Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(rep.medianRttMs) || rep.medianRttMs < 0) {
    return Number.MAX_SAFE_INTEGER;                         // implausible => worst
  }
  // Clamp absurd-but-finite values so one peer can't claim "0ms" to always win;
  // <8ms is treated as the floor bucket and the hash decides among the fast set.
  const clamped = Math.max(rep.medianRttMs, 8);
  return Math.floor(clamped / LATENCY_BUCKET_MS);
}

/**
 * Produce the FULL ordered authorityChain. Index 0 is the active authority;
 * on its loss, handoff.ts promotes index 1, and so on. Because this is a total
 * order over the whole roster, the chain doubles as the migration fallback list.
 *
 * Sort key (ascending), applied in order:
 *   1. latency bucket          (lower = better host)
 *   2. consistent-hash score   (deterministic, salted by matchId)
 *   3. peerId lexicographic    (final, impossible-to-tie backstop)
 */
export function electAuthorityChain(input: ElectionInput): PeerId[] {
  const { matchId, roster, reports, now } = input;

  // Dedupe + stabilise the input set so the sort is order-independent.
  const peers = Array.from(new Set(roster));

  // Precompute keys once (sha256 per peer is cheap, but avoid recompute in sort).
  const keyed = peers.map((peerId) => ({
    peerId,
    bucket: latencyBucket(reports[peerId], now),
    hash: consistentHashScore(matchId, peerId),
  }));

  keyed.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;          // 1. latency
    if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;         // 2. hash
    return a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0;  // 3. lexico
  });

  return keyed.map((k) => k.peerId);
}

/** Convenience: who is the active authority right now. */
export function electAuthority(input: ElectionInput): PeerId {
  return electAuthorityChain(input)[0];
}

/**
 * Verify that an advert's claimed authorityChain matches what WE independently
 * compute. Used by every peer on each LobbyAdvert update: if the chain we'd
 * derive differs, the advert is stale or the writer is lying — we recompute
 * locally and never trust the replicated chain blindly.
 */
export function chainIsConsistent(
  advert: Pick<LobbyAdvert, 'authorityChain'>,
  input: ElectionInput,
): boolean {
  const expected = electAuthorityChain(input);
  const got = advert.authorityChain;
  if (expected.length !== got.length) return false;
  return expected.every((p, i) => p === got[i]);
}

/** Debug helper: expose the hash as hex (handy in tests/logs). */
export function hashScoreHex(matchId: string, peerId: PeerId): string {
  return bytesToHex(sha256(utf8ToBytes(`${matchId}|${peerId}`))).slice(0, 16);
}
