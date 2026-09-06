/**
 * Structured diagnostics — the "what failed, where, why, in which version" store.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this module the backend had exactly one diagnostic surface: `console.log` lines captured
 * into an 800-entry ring buffer (see logStore.ts). Three measured properties made that unable to
 * answer any real question:
 *
 *  1. IT WRAPS IN UNDER THREE MINUTES. The busiest single minute in the retained `cobalt.log` is
 *     289 client requests (2026-08-15 sessions, 3,533 URL lines total), and index.ts logs one line
 *     per request. 800 / 289 ~= 2.8 minutes of history. Measured, not estimated: firing the observed
 *     289 req/min at a scratch backend and then continuing to 889 requests evicted a deliberately
 *     planted marker line entirely.
 *  2. READING IT DESTROYS IT. The launcher's Logs tab polls GET /nova/api/logs every 2500 ms
 *     (Logs.tsx:46) and that request is itself logged, so the act of looking accelerates the
 *     eviction of whatever is being looked for.
 *  3. IT HAS NO CATEGORIES. A missing endpoint, a failed auth and an internal crash are all just
 *     strings, so none of them can be counted, ranked or trended.
 *
 * This store is the opposite on each point: it AGGREGATES rather than appends (one row per distinct
 * problem, with an occurrence counter, so 706 repeats of the same call cannot evict anything), it is
 * never written to by the act of reading it, and every entry carries an explicit failure category.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not change a single response. The not-found handler still returns `200 {}` / `204` exactly
 * as before — that shape is load-bearing for a client that treats a 404 as a hard error, and this
 * module's job is to make the silence VISIBLE, not to break it. Everything here is observation.
 */

/**
 * Failure taxonomy and source, now defined once in diagnostics.schema.ts because three processes
 * emit these — the backend, Cobalt inside the game, and Reboot inside the gameserver.
 *
 * Re-exported here so the many existing importers of this module do not have to change.
 */
export type { DiagnosticCategory, DiagnosticSource } from './diagnostics.schema';
import type { DiagnosticCategory, DiagnosticSource } from './diagnostics.schema';
import { noteOccurrence } from './incidents';
import {
  initDiagnosticStore, loadPersisted, persist, clearPersisted, persistedCount, storeReady,
  type PersistedDiagnostic,
} from './diagnostics.store';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';

export interface DiagnosticInput {
  category: DiagnosticCategory;
  /**
   * Which component OBSERVED the failure. Defaults to BACKEND so every pre-existing call site keeps
   * its exact meaning — this field was added when clients and hosts started reporting, and the
   * dashboard must never confuse "the client could not reach us" with "we returned a 500".
   */
  source?: DiagnosticSource;
  /** Emitting component: `cobalt`, `reboot`, `launcher`, `backend`. */
  component?: string;
  /**
   * Ties one player action across Cobalt → backend → host, so the FIRST point of failure is
   * answerable rather than just the last symptom.
   */
  correlationId?: string;
  /** Occurrences already aggregated by the emitter before it sent this. Defaults to 1. */
  count?: number;
  method: string;
  /** Raw request URL. Normalised and redacted in here — callers must not pre-clean it. */
  url: string;
  /**
   * The build id — `"7.40"`, or `"unknown"`. NOT the raw User-Agent.
   *
   * This dimension is part of the aggregation key, so feeding it a whole User-Agent was a real
   * defect: every browser that opened the dashboard became its own "build", rows were keyed on
   * 200-character strings, and the incident model started reporting VERSION_SPECIFIC because it
   * could see several distinct "versions" that were actually Chrome. Found by looking at the live
   * dashboard, not by a test. `identifyVersion` produces the short id; use that.
   */
  version?: string;
  /** Opaque per-caller identifier used ONLY to count distinct affected users. Never stored raw. */
  accountId?: string | null;
  /** HTTP status actually sent. */
  status?: number;
  /** Short free-text detail. Redacted before storage. */
  detail?: string;
}

export interface DiagnosticEntry {
  category: DiagnosticCategory;
  source: DiagnosticSource;
  component: string;
  method: string;
  /** Path with volatile segments replaced by placeholders, so repeats aggregate. */
  route: string;
  subsystem: string;
  version: string;
  status?: number;
  detail?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Distinct callers affected. Counted via bounded short hashes — no account id is retained. */
  affectedUsers: number;
  severity: Severity;
  score: number;
  /** Sample correlation ids, newest first. Bounded — the entry point for tracing one failure. */
  correlationIds: string[];
}

/** Cap on DISTINCT problems retained. Aggregation means this is a count of *kinds* of failure, not
 *  of events, so a few hundred is a lot. Bounded because this map is reachable from request data. */
const MAX_KEYS = 400;
/** Per-entry cap on the distinct-caller set, so one endpoint cannot grow unboundedly. */
const MAX_TRACKED_USERS = 64;

interface InternalEntry extends Omit<DiagnosticEntry, 'severity' | 'score' | 'affectedUsers' | 'correlationIds'> {
  users: Set<string>;
  overflowUsers: number;
  /** Bounded ring of recent correlation ids — enough to trace, not enough to be a log. */
  correlations: string[];
  /** Event timestamps (ms) inside the trend window, for the "is this getting worse" term. */
  recent: number[];
}

const entries = new Map<string, InternalEntry>();
/** Window over which "recent growth" is measured, in ms. */
const TREND_WINDOW_MS = 5 * 60 * 1000;

/**
 * Strip secret material from a URL or message.
 *
 * This is not cosmetic. Fortnite 7.40 puts a live bearer token in the URL PATH — every session ends
 * with `DELETE /account/api/oauth/sessions/kill/eg1~<jwt>` (76 such calls in the retained
 * cobalt.log). index.ts logged `request.url` verbatim into a buffer that GET /nova/api/logs then
 * served to anyone who asked, with no Authorization header required. Verified against a scratch
 * backend: a planted `eg1~` canary came back in the unauthenticated log response.
 *
 * Exported because the plain request logger must use it too — redacting only here would leave the
 * original leak wide open.
 */
export function redactSecrets(s: string): string {
  if (!s) return s;
  return s
    // Epic session tokens, in a path or a query value. Keep the prefix so the shape stays readable.
    .replace(/eg1~[A-Za-z0-9._~+/-]+=*/g, 'eg1~<redacted>')
    // Bare JWTs (three base64url segments) that do not carry the eg1~ prefix.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    // Common secret-bearing query parameters.
    .replace(/([?&](?:access_token|refresh_token|token|password|secret|code|authkey|auth_key)=)[^&\s]+/gi, '$1<redacted>')
    // Basic/Bearer credentials if they ever reach a message body.
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 <redacted>');
}

/**
 * Collapse volatile path segments to placeholders so that N occurrences of the same problem become
 * one row with count=N instead of N rows that evict each other.
 */
export function normaliseRoute(url: string): string {
  const path = redactSecrets((url || '/').split('?')[0]);
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (seg === 'eg1~<redacted>' || seg === '<redacted-jwt>') return '{token}';
      if (/^[0-9a-fA-F]{32}$/.test(seg)) return '{accountId}';
      if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(seg)) return '{uuid}';
      if (/^\d+$/.test(seg)) return '{n}';
      if (/^[0-9a-fA-F]{16,}$/.test(seg)) return '{id}';
      return seg;
    })
    .join('/');
}

/**
 * Which part of the system a path belongs to. Used both for grouping and for severity weighting —
 * a broken matchmaking call matters more than a broken telemetry beacon even if it happens less.
 */
export function subsystemFor(route: string): string {
  const p = route.toLowerCase();
  if (p.startsWith('/account/') || p.startsWith('/auth/') || p.startsWith('/epic/oauth')) return 'auth';
  if (p.includes('/matchmaking') || p.includes('/matchmakingservice')) return 'matchmaking';
  if (p.includes('/profile/') || p.startsWith('/fortnite/api/game/v2/profile')) return 'mcp';
  if (p.startsWith('/friends/') || p.startsWith('/epic/friends') || p.includes('/party')) return 'social';
  if (p.startsWith('/fortnite/api/cloudstorage')) return 'cloudstorage';
  if (p.startsWith('/fortnite/api/storefront') || p.startsWith('/catalog/')) return 'storefront';
  if (p.startsWith('/datarouter/')) return 'telemetry';
  if (p.startsWith('/lightswitch/')) return 'lightswitch';
  if (p.startsWith('/fortnite/api/calendar')) return 'calendar';
  if (p.startsWith('/nova/')) return 'nova';
  if (p.startsWith('/anticheat/') || p.startsWith('/api/v1/eac-policy')) return 'anticheat';
  return 'other';
}

/**
 * SEVERITY MODEL — documented and adjustable, per the engineering brief's requirement that severity
 * NOT be a raw occurrence count. A cosmetic endpoint failing 500 times is less serious than
 * matchmaking failing 5 times, and the weights below are what encode that.
 *
 *   score = subsystemWeight x categoryWeight x (1 + log10(count)) x userFactor x growthFactor
 *
 * Every term is deliberately bounded so no single term can dominate:
 *   - count contributes logarithmically (10 occurrences ~= 2x, 100 ~= 3x), so volume matters but
 *     cannot outrank importance.
 *   - userFactor rises with distinct affected callers — one player hitting a wall repeatedly is a
 *     bug report, twenty players hitting it is an incident.
 *   - growthFactor rises when most occurrences are inside the trend window, which is what
 *     distinguishes "happening right now" from "happened once last week".
 *
 * Tune these tables rather than the formula.
 */
export const SUBSYSTEM_WEIGHT: Record<string, number> = {
  matchmaking: 5, auth: 5, mcp: 4, social: 3, cloudstorage: 3,
  calendar: 2, storefront: 2, anticheat: 2, lightswitch: 1, nova: 1, telemetry: 0.5, other: 1,
};

export const CATEGORY_WEIGHT: Record<DiagnosticCategory, number> = {
  // A dead gameserver ends the match for everyone in it, so CRASH outranks everything.
  CRASH: 6,
  INTERNAL_ERROR: 5,
  // These three mean the player cannot play. That is the definition of CRITICAL in the incident
  // model, so they are weighted above the generic transport failures that merely might mean it.
  MATCHMAKING_FAILURE: 5, SESSION_FAILURE: 5,
  UNEXPECTED_STATE: 4, AUTH_FAILURE: 4, VERSION_MISMATCH: 4, PARTY_FAILURE: 4,
  MISSING: 3, INVALID_RESPONSE: 3, NETWORK_FAILURE: 3, TIMEOUT: 3, FAILED: 2, UNKNOWN: 2,
};

/**
 * Thresholds, calibrated against the score range the weights above can actually produce
 * (about 1 at the floor to about 600 at the ceiling) rather than picked round numbers.
 *
 * The first cut of these was 40/20/8/3, and a test caught that it made the ranking useless: at
 * those levels almost anything in matchmaking or auth lands on CRITICAL the moment it happens
 * twice, so CRITICAL stops meaning anything. These are set from worked cases instead:
 *
 *   telemetry MISSING     x1000 events, 20 users   ->  36  MEDIUM   (loud, but nobody is blocked)
 *   storefront MISSING    x1  event,   1 user      ->  13  LOW
 *   mcp MISSING           x5  events,  1 user      ->  45  HIGH
 *   matchmaking 500       x3  events,  3 users     ->  96  HIGH     (players cannot get into games)
 *   matchmaking 500       x100 events, 20 users    -> 450  CRITICAL (widespread and growing)
 *
 * Adjust these boundaries, or the weight tables above, rather than the formula.
 */
function severityFor(score: number): Severity {
  if (score >= 100) return 'CRITICAL';
  if (score >= 40) return 'HIGH';
  if (score >= 15) return 'MEDIUM';
  if (score >= 5) return 'LOW';
  return 'INFORMATIONAL';
}

function scoreOf(e: InternalEntry, now: number): { score: number; severity: Severity } {
  const recent = e.recent.filter((t) => now - t <= TREND_WINDOW_MS).length;
  const users = e.users.size + e.overflowUsers;

  const subsystem = SUBSYSTEM_WEIGHT[e.subsystem] ?? 1;
  const category = CATEGORY_WEIGHT[e.category] ?? 1;
  const volume = 1 + Math.log10(Math.max(1, e.count));
  const userFactor = 1 + Math.min(users, 20) / 10;                     // caps at 3x
  const growthFactor = 1 + Math.min(recent / Math.max(1, e.count), 1); // caps at 2x

  const score = subsystem * category * volume * userFactor * growthFactor;

  // CRITICAL REQUIRES BREADTH. Observed on the dashboard with real data: a single player retrying
  // matchmaking 480 times scored 103 and rendered as CRITICAL beside the caption "one machine —
  // probably local to that player". Both were true, and together they were absurd.
  //
  // The volume term is logarithmic precisely so repetition cannot outrank importance, but with one
  // affected user the userFactor only contributes 1.1x, which is not enough to hold a very loud
  // single-machine problem below the top band. The brief defines CRITICAL as "cannot connect /
  // cannot play / WIDESPREAD failure", so breadth is part of the definition rather than a tuning
  // knob: one player blocked is HIGH, however many times they retry.
  //
  // The score itself is left untouched so ranking within HIGH still reflects how loud it is.
  const severity = users <= 1 && severityFor(score) === 'CRITICAL' ? 'HIGH' : severityFor(score);
  return { score: Math.round(score * 100) / 100, severity };
}

/** Short non-reversible tag for distinct-user counting. Never stored alongside anything that could
 *  re-identify the account, and never returned by the API — only its cardinality is. */
function userTag(accountId: string): string {
  let h = 0;
  for (let i = 0; i < accountId.length; i++) h = (Math.imul(31, h) + accountId.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Record one diagnostic event. Cheap and non-throwing: this sits on the request path, so it must
 * never be the reason a request fails.
 */
// ── LIVE SUBSCRIBERS ─────────────────────────────────────────────────────────────────────────────
//
// The dashboard was a static snapshot: an administrator watching for a problem had to keep hitting
// reload, and anything that happened between reloads was only visible as a number that had moved.
// Subscribers get told the moment a diagnostic lands, so the page can show the event itself.
//
// THREE THINGS THIS DELIBERATELY IS NOT:
//
//   * It is not a queue. There is no buffering, no replay and no delivery guarantee. A subscriber
//     that is slow or gone simply misses events; the authoritative state is still `entries`, which
//     the page can re-read at any time. Buffering per-subscriber is how a telemetry channel turns
//     into a memory leak.
//   * It is not allowed to fail a request. Every callback runs inside its own try/catch, so a
//     broken subscriber cannot propagate an exception back into `recordDiagnostic` — which is
//     called from error paths, where throwing would replace the error being recorded.
//   * It is not unbounded. MAX_SUBSCRIBERS caps how many can attach at once; past that, new
//     connections are refused rather than accepted and quietly starved.

type DiagnosticListener = (event: LiveDiagnosticEvent) => void;

/** What a subscriber is told. Deliberately small — the dashboard re-reads full state separately. */
export interface LiveDiagnosticEvent {
  category: string;
  source: string;
  method: string;
  route: string;
  version: string;
  subsystem: string;
  status?: number;
  /** The running total for this key AFTER this occurrence, not the delta. */
  count: number;
  at: string;
  /** True the first time a key is seen, so the UI can distinguish "new problem" from "again". */
  isNew: boolean;
}

const MAX_SUBSCRIBERS = 16;
const listeners = new Set<DiagnosticListener>();

// ── THE REPLAY RING, AND WHY IT HAD TO EXIST ─────────────────────────────────────────────────────
//
// SSE is the right transport and it works: measured 445 bytes of `hello` + `diagnostic` frames
// direct from the backend and through the path-allowlist proxy. It delivers ZERO bytes through
// Cloudflare's free `trycloudflare` tunnel, which buffers the response body — so on the one route an
// operator actually uses from a phone, the live tail is dead.
//
// The brief permits polling "only if justified". This is the justification, and it is measured
// rather than assumed. So: SSE stays primary, and a page that gets no `hello` falls back to reading
// this ring by sequence number. Same event model, same data, different carrier — not a page that
// blindly reloads itself and calls that live.
//
// Bounded and lossy on purpose. A poller that has been away longer than the ring is told so via
// `missed`, rather than being handed a false impression of continuity.
const REPLAY_SIZE = 200;
const replay: Array<LiveDiagnosticEvent & { seq: number }> = [];
let nextSeq = 1;

/**
 * Events after `sinceSeq`, newest last, plus the current head.
 *
 * `missed` is the count this ring has already discarded past the caller's position — the honest
 * answer to "did I lose anything", which a plain array of results cannot express.
 */
export function diagnosticsSince(sinceSeq: number): {
  events: Array<LiveDiagnosticEvent & { seq: number }>;
  head: number;
  missed: number;
} {
  const head = nextSeq - 1;
  if (replay.length === 0) return { events: [], head, missed: 0 };
  const oldest = replay[0].seq;
  // A caller asking from before the ring's oldest entry has a gap. Report its size instead of
  // pretending the window it can see is everything that happened.
  const missed = sinceSeq > 0 && sinceSeq < oldest - 1 ? oldest - 1 - sinceSeq : 0;
  return { events: replay.filter((e) => e.seq > sinceSeq), head, missed };
}

/**
 * Attach a live listener. Returns an unsubscribe function, or null when at capacity.
 *
 * Returning null rather than throwing keeps the decision with the caller: the SSE route turns it
 * into a 503 the administrator can see, instead of a connection that silently receives nothing.
 */
export function subscribeDiagnostics(fn: DiagnosticListener): (() => void) | null {
  if (listeners.size >= MAX_SUBSCRIBERS) return null;
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** How many live subscribers are attached. Exposed so the dashboard can show its own plumbing. */
export function diagnosticSubscriberCount(): number {
  return listeners.size;
}

function emitLive(event: LiveDiagnosticEvent): void {
  // Ring first, listeners second. A poller must be able to see an event even if every SSE
  // subscriber is broken, and the ring write cannot throw.
  replay.push({ ...event, seq: nextSeq++ });
  if (replay.length > REPLAY_SIZE) replay.splice(0, replay.length - REPLAY_SIZE);

  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // A broken subscriber is the subscriber's problem. Swallowed on purpose and ONLY here:
      // recordDiagnostic is called from error handlers, so an exception escaping this loop would
      // destroy the very record it was reporting.
    }
  }
}

export function recordDiagnostic(input: DiagnosticInput): void {
  try {
    const route = normaliseRoute(input.url);
    const subsystem = subsystemFor(route);
    const version = input.version || 'unknown';
    const source = input.source || 'BACKEND';
    const component = input.component || 'backend';
    // Source is part of the key on purpose. The client failing to reach a route and the backend
    // returning 500 on it are different problems with different fixes, and merging them would hide
    // exactly the distinction the dashboard exists to draw.
    const key = `${source}|${input.category}|${input.method}|${route}|${version}`;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    let e = entries.get(key);
    const isNew = !e;
    if (!e) {
      if (entries.size >= MAX_KEYS) evictOne(nowMs);
      e = {
        category: input.category, source, component, method: input.method, route, subsystem, version,
        status: input.status, detail: input.detail ? redactSecrets(input.detail).slice(0, 300) : undefined,
        count: 0, firstSeen: nowIso, lastSeen: nowIso,
        users: new Set<string>(), overflowUsers: 0, recent: [], correlations: [],
      };
      entries.set(key, e);
    }

    // An emitter may have aggregated locally before sending, so it reports how many. Bounded by the
    // schema's MAX_CLAIMED_COUNT at the ingest boundary — a client cannot inflate a ranking.
    e.count += Math.max(1, Math.min(input.count ?? 1, 1000));
    e.lastSeen = nowIso;
    if (input.correlationId) {
      e.correlations.unshift(input.correlationId.slice(0, 64));
      if (e.correlations.length > 5) e.correlations.length = 5;
    }
    if (input.status !== undefined) e.status = input.status;
    if (input.detail) e.detail = redactSecrets(input.detail).slice(0, 300);

    if (input.accountId) {
      const tag = userTag(input.accountId);
      if (!e.users.has(tag)) {
        if (e.users.size < MAX_TRACKED_USERS) e.users.add(tag);
        else e.overflowUsers++;
      }
    }

    // Keep only the trend window, and cap the array so a hot endpoint cannot grow it without bound.
    e.recent.push(nowMs);
    if (e.recent.length > 200) e.recent = e.recent.slice(-200);

    // Longer, coarser history for spike detection. `recent` is a 5-minute window capped at 200
    // entries, which is enough for the severity model's growth term but far too short to establish
    // a BASELINE — and without a baseline "is this getting worse" is unanswerable. See incidents.ts.
    noteOccurrence(key, input.count ?? 1, nowMs);

    // Mark for the next flush rather than writing now. `recordDiagnostic` runs on error paths and
    // inside the crash handler; a synchronous disk write per event would put I/O on the hot path of
    // a process that is already failing, and an error storm would become a write storm.
    dirty.add(key);

    // LAST, on purpose. Everything above has already been committed to `entries`, so a subscriber
    // reacting to this event and re-reading state sees it — and a listener that misbehaves cannot
    // leave the store half-updated, because there is nothing left to update.
    emitLive({
      category: input.category, source, method: input.method, route, version, subsystem,
      status: input.status, count: e.count, at: nowIso, isNew,
    });
  } catch {
    /* diagnostics must never break a request */
  }
}

/** Drop the least useful entry when at capacity: lowest score first, oldest last-seen as tiebreak.
 *  Never silently drops a high-severity entry in favour of a noisy low-severity one. */
function evictOne(now: number): void {
  let worstKey: string | null = null;
  let worstScore = Infinity;
  let worstSeen = Infinity;
  for (const [k, e] of entries) {
    const { score } = scoreOf(e, now);
    const seen = Date.parse(e.lastSeen);
    if (score < worstScore || (score === worstScore && seen < worstSeen)) {
      worstKey = k; worstScore = score; worstSeen = seen;
    }
  }
  if (worstKey) entries.delete(worstKey);
}

/** Snapshot for the launcher / dashboard, most severe first. */
export function getDiagnostics(opts: { category?: DiagnosticCategory; source?: DiagnosticSource; subsystem?: string; limit?: number } = {}): DiagnosticEntry[] {
  const now = Date.now();
  const out: DiagnosticEntry[] = [];
  for (const e of entries.values()) {
    if (opts.category && e.category !== opts.category) continue;
    if (opts.source && e.source !== opts.source) continue;
    if (opts.subsystem && e.subsystem !== opts.subsystem) continue;
    const { score, severity } = scoreOf(e, now);
    out.push({
      category: e.category, source: e.source, component: e.component,
      method: e.method, route: e.route, subsystem: e.subsystem,
      version: e.version, status: e.status, detail: e.detail, count: e.count,
      firstSeen: e.firstSeen, lastSeen: e.lastSeen,
      affectedUsers: e.users.size + e.overflowUsers, severity, score,
      correlationIds: [...e.correlations],
    });
  }
  out.sort((a, b) => b.score - a.score || b.count - a.count);
  const limit = Math.max(1, Math.min(opts.limit ?? 200, MAX_KEYS));
  return out.slice(0, limit);
}

/** Rollups the dashboard needs without recomputing them client-side. */
export function getDiagnosticsSummary(): {
  totalEvents: number; distinctProblems: number;
  byCategory: Record<string, number>; bySubsystem: Record<string, number>; bySeverity: Record<string, number>;
} {
  const all = getDiagnostics({ limit: MAX_KEYS });
  const byCategory: Record<string, number> = {};
  const bySubsystem: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let totalEvents = 0;
  for (const e of all) {
    totalEvents += e.count;
    byCategory[e.category] = (byCategory[e.category] || 0) + e.count;
    bySubsystem[e.subsystem] = (bySubsystem[e.subsystem] || 0) + e.count;
    bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
  }
  return { totalEvents, distinctProblems: all.length, byCategory, bySubsystem, bySeverity };
}

// ── DURABILITY ───────────────────────────────────────────────────────────────────────────────────
//
// DIAGNOSTIC_COVERAGE.md named this the largest gap in the system, in these words: "the most valuable
// record — what happened immediately before a crash — is the one guaranteed not to survive it." The
// store was in memory, so a crash destroyed the evidence of the crash, and every restart erased the
// history that would answer "did this start after the last deploy?".
//
// The design is write-behind, not write-through, and the reason is the same reason the rest of this
// module is defensive: `recordDiagnostic` is called from error handlers. Doing disk I/O there would
// add a failure mode to the code whose entire job is to survive failures, and a 500-storm would
// become a write-storm. So memory stays authoritative, changed keys are marked, and a timer writes
// them in one transaction.
//
// THE CRASH CASE IS THE POINT. `flushDiagnosticsNow()` is called from the `uncaughtException`
// handler in index.ts, so the record that matters most is written by the crash itself. A durable
// store that persisted everything except the crash would have missed the only event nobody can
// reproduce on demand.
//
// WHAT SURVIVES A RESTART, PRECISELY — stated because "it persists now" is the kind of claim that
// quietly means less than it sounds:
//   survives:  the key, category, source, component, method, route, subsystem, version, status,
//              detail, count, firstSeen, lastSeen, and the NUMBER of affected users.
//   does not:  the per-user hash set (only its cardinality is kept, so a returning player can be
//              counted twice after a restart — see restoreDiagnostics), the 5-minute trend window
//              (correctly: nothing is "recent" after a restart), correlation id samples, and the
//              incident baseline in incidents.ts.

/** Keys changed since the last successful flush. Bounded by `entries`, which is bounded by MAX_KEYS. */
const dirty = new Set<string>();

/** How long a diagnostic can exist only in memory. The exposure window, in ms. */
const FLUSH_INTERVAL_MS = 5_000;
let flushTimer: NodeJS.Timeout | null = null;

function rowFor(key: string, e: InternalEntry): PersistedDiagnostic {
  return {
    key, category: e.category, source: e.source, component: e.component,
    method: e.method, route: e.route, subsystem: e.subsystem, version: e.version,
    status: e.status, detail: e.detail, count: e.count,
    firstSeen: e.firstSeen, lastSeen: e.lastSeen,
    users: e.users.size + e.overflowUsers,
  };
}

/**
 * Write every changed entry now. Returns how many rows were written.
 *
 * Safe to call at any time, including from a fatal handler and more than once: the upsert is
 * idempotent, so a double flush during shutdown writes the same rows rather than double-counting.
 * Never throws — a diagnostic system must not be the reason a shutdown fails.
 */
export function flushDiagnosticsNow(): number {
  try {
    if (dirty.size === 0) return 0;
    const rows: PersistedDiagnostic[] = [];
    for (const key of dirty) {
      const e = entries.get(key);
      // Evicted between being marked and being flushed. The row it had on disk stays as it was —
      // `persist` never lowers a count, so eviction cannot erase history.
      if (e) rows.push(rowFor(key, e));
    }
    // Cleared before the write, not after: a flush that fails must not accumulate an ever-growing
    // dirty set, and every one of these keys will be marked again the next time it occurs.
    dirty.clear();
    return persist(rows);
  } catch {
    return 0;
  }
}

/**
 * Load persisted diagnostics back into memory at startup.
 *
 * Restored rows are NOT marked dirty — they already match what is on disk, and re-flushing them
 * would be pure write amplification on every start.
 *
 * The affected-user count comes back as `overflowUsers` because the hashes themselves are not
 * stored (deliberately — see `userTag`). The cardinality is therefore right at restore and can
 * drift upward afterwards: a player who was already counted before the restart is counted again
 * when they next hit the same failure. That is a known, bounded inaccuracy in the direction of
 * over-reporting breadth, and it is preferred to the alternative of retaining per-user material
 * across restarts purely to keep a counter tidy.
 */
export function restoreDiagnostics(): number {
  let restored = 0;
  try {
    for (const r of loadPersisted()) {
      if (entries.size >= MAX_KEYS) break; // most-recent-first, so this keeps the useful end
      if (entries.has(r.key)) continue;
      entries.set(r.key, {
        category: r.category as DiagnosticCategory, source: r.source as DiagnosticSource,
        component: r.component, method: r.method, route: r.route, subsystem: r.subsystem,
        version: r.version, status: r.status, detail: r.detail,
        count: r.count, firstSeen: r.firstSeen, lastSeen: r.lastSeen,
        users: new Set<string>(), overflowUsers: r.users,
        // Empty on purpose. `recent` drives the "is this getting worse" term, and history read off
        // a disk is by definition not happening right now — seeding it would make every restart
        // look like a spike.
        recent: [], correlations: [],
      });
      restored++;
    }
  } catch {
    /* a store that cannot be read must not stop the backend starting */
  }
  return restored;
}

/**
 * Turn on durable diagnostics. Call once, after the database is open.
 *
 * Returns false when the store is unavailable, in which case everything above still works exactly
 * as it did — in memory, non-durable. Degrading is acceptable; refusing to start is not.
 */
export function startDiagnosticPersistence(): boolean {
  if (!initDiagnosticStore()) return false;
  const restored = restoreDiagnostics();
  if (restored > 0) console.log(`[Diagnostics] restored ${restored} diagnostic(s) from the last run`);

  if (!flushTimer) {
    flushTimer = setInterval(flushDiagnosticsNow, FLUSH_INTERVAL_MS);
    // unref so the timer cannot hold the process open. This is the OPPOSITE case to the one in
    // index.ts, where `.unref()` on the exit timer meant the process exited 0 after a crash: here
    // nothing depends on the timer firing before exit, because every exit path flushes explicitly.
    flushTimer.unref?.();
  }
  return true;
}

/** Stop the flush timer, flushing what is pending first. For shutdown and for tests. */
export function stopDiagnosticPersistence(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flushDiagnosticsNow();
}

/** Whether diagnostics are durable right now, and how many rows are on disk. For the dashboard. */
export function diagnosticPersistenceStatus(): { durable: boolean; rows: number; pending: number } {
  return { durable: storeReady(), rows: persistedCount(), pending: dirty.size };
}

/**
 * Test/maintenance hook.
 *
 * Memory-only by default, which is what the `POST /nova/api/diagnostics/clear` admin route has
 * always meant: dismiss what is on screen. Pass `{ persisted: true }` to also drop the history —
 * that is a deliberate destructive act, not the default, because "clear the view" and "delete the
 * record of what went wrong" should never be the same button.
 */
export function clearDiagnostics(opts: { persisted?: boolean } = {}): void {
  entries.clear();
  dirty.clear();
  if (opts.persisted) clearPersisted();
}
