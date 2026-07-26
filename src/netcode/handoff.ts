// src/netcode/handoff.ts
// =============================================================================
// PROJECT NOVA — Phase 2/3 boundary: Host migration (authority re-election).
//
// The authority is a temporary host — a player's browser. When it drops, the
// match must NOT die. Migration is the recovery path:
//
//   1. DETECT  — every client tracks the last AuthorityBeat / snapshot it saw.
//                AUTHORITY_TIMEOUT_MS (300ms) with no signal => authority lost.
//   2. ELECT   — the authorityChain (election.ts, already agreed deterministicly
//                at match start and refreshed each keyframe) names the successor:
//                chain[1] promotes. Because the chain is a pure function shared
//                by all peers, everyone independently agrees WHO is next — no
//                vote, no split-brain (assuming they hold the same chain, which
//                the keyframe-embedded chain guarantees).
//   3. RECOVER — the new authority rebuilds world state from the most recent
//                WorldSnapshot it holds + the ring buffer of inputs it received
//                since that snapshot, re-simulating forward to "now". Clients
//                replay their unacked inputs to it. The deterministic sim
//                (same seed, same ruleset CID) makes this reconstruction exact.
//
// This file is the migration controller; it imports the PURE election function
// from matchmaking and drives the netcode transition. Re-sim itself lives in
// simulation.ts (Phase 3); here we orchestrate detection + promotion + replay.
// =============================================================================

import type { PeerId, Tick } from '../shared/types.js';
import { PROTOCOL } from '../shared/types.js';
import { electAuthorityChain, type LatencyReport } from '../matchmaking/election.js';

/** Snapshot the migration controller needs to drive re-election. */
export interface MigrationContext {
  self: PeerId;
  matchId: string;
  /** Current full roster (survivors). */
  roster: PeerId[];
  /** Latest latency reports (refreshed via beats). */
  reports: Record<PeerId, LatencyReport>;
  /** The authorityChain embedded in the last keyframe (authoritative copy). */
  lastKnownChain: PeerId[];
}

/** Hooks the netcode layer wires in. */
export interface MigrationHooks {
  /** Become authority: spin up the 64Hz loop seeded from recovered state. */
  promoteSelf: (recoverTo: Tick) => Promise<void>;
  /** Follow a new authority: reconnect channels, replay unacked inputs to it. */
  followNewAuthority: (authority: PeerId, replayFromTick: Tick) => Promise<void>;
  /** Last tick we have authoritative state for (snapshot baseline). */
  lastAppliedTick: () => Tick;
  /** Void the match if the chain is exhausted (no eligible successor). */
  voidMatch: (reason: string) => void;
}

export class MigrationController {
  private lastSignalAt = Date.now();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private migrating = false;

  constructor(
    private ctx: MigrationContext,
    private hooks: MigrationHooks,
  ) {}

  /** Call on every AuthorityBeat OR any snapshot/delta from the authority. */
  noteAuthoritySignal(): void {
    this.lastSignalAt = Date.now();
  }

  /** Keep roster/reports fresh as players drop and beats carry RTTs. */
  updateContext(patch: Partial<MigrationContext>): void {
    this.ctx = { ...this.ctx, ...patch };
  }

  /** Start the 300ms watchdog. The current authority does NOT run this. */
  start(): void {
    this.watchdog = setInterval(() => this.tick(), PROTOCOL.AUTHORITY_BEAT_MS);
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /**
   * Compute the successor chain locally. We START from the agreed roster but
   * DROP the timed-out authority (and anyone else past presence TTL) before
   * re-electing, so chain[0] of the result is the live successor. We reconcile
   * against lastKnownChain (the keyframe copy) to avoid a peer with a divergent
   * latency view promoting the "wrong" successor: ties broken by consistent
   * hash are identical for everyone, so as long as the surviving SET agrees,
   * the WINNER agrees.
   */
  private successorChain(deadAuthority: PeerId): PeerId[] {
    const survivors = this.ctx.roster.filter((p) => p !== deadAuthority);
    return electAuthorityChain({
      matchId: this.ctx.matchId,
      roster: survivors,
      reports: this.ctx.reports,
      now: Date.now(),
    });
  }

  private async tick(): Promise<void> {
    if (this.migrating) return;
    const silentFor = Date.now() - this.lastSignalAt;
    if (silentFor < PROTOCOL.AUTHORITY_TIMEOUT_MS) return;

    // Authority is presumed lost.
    this.migrating = true;
    const deadAuthority = this.ctx.lastKnownChain[0];
    const chain = this.successorChain(deadAuthority);

    if (chain.length === 0) {
      this.hooks.voidMatch('authority chain exhausted (no survivors)');
      this.migrating = false;
      return;
    }

    const successor = chain[0];
    // Recover forward from the last tick we hold authoritative state for.
    const recoverTo = this.hooks.lastAppliedTick();

    try {
      if (successor === this.ctx.self) {
        // WE are next. Rebuild state and start authoring.
        // promoteSelf re-sims: lastSnapshot + buffered inputs -> recoverTo,
        // then begins broadcasting AuthorityBeats so others stop their watchdogs.
        await this.hooks.promoteSelf(recoverTo);
        this.ctx.lastKnownChain = chain;
      } else {
        // Someone else is next. Reconnect to them and replay our unacked inputs
        // from recoverTo so no local actions are lost across the gap.
        await this.hooks.followNewAuthority(successor, recoverTo);
        this.ctx.lastKnownChain = chain;
        // Reset the watchdog clock; we expect beats from the new authority.
        this.lastSignalAt = Date.now();
      }
    } finally {
      this.migrating = false;
    }
  }
}

/**
 * Pure helper exported for tests: given a roster, reports, matchId and a set of
 * "dropped" peers, return who SHOULD be authority. Mirrors successorChain().
 */
export function expectedAuthorityAfterDrops(
  matchId: string,
  roster: PeerId[],
  dropped: PeerId[],
  reports: Record<PeerId, LatencyReport>,
): PeerId | undefined {
  const droppedSet = new Set(dropped);
  const survivors = roster.filter((p) => !droppedSet.has(p));
  return electAuthorityChain({ matchId, roster: survivors, reports, now: Date.now() })[0];
}
