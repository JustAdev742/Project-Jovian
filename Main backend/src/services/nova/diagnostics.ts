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

/** Failure taxonomy. Deliberately NOT collapsed into one bucket — the whole point is that a missing
 *  endpoint and a failed login need different responses from whoever reads this. */
export type DiagnosticCategory =
  | 'MISSING'           // No route matched. The catch-all answered instead of a real handler.
  | 'FAILED'            // A handler ran and deliberately returned a 4xx.
  | 'TIMEOUT'
  | 'AUTH_FAILURE'      // 401/403 — a token was absent, malformed or rejected.
  | 'INVALID_RESPONSE'
  | 'UNEXPECTED_STATE'
  | 'NETWORK_FAILURE'
  | 'INTERNAL_ERROR'    // 5xx, or a handler threw.
  | 'VERSION_MISMATCH'  // The caller's build is not the one this response was written for.
  | 'UNKNOWN';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL';

export interface DiagnosticInput {
  category: DiagnosticCategory;
  method: string;
  /** Raw request URL. Normalised and redacted in here — callers must not pre-clean it. */
  url: string;
  /** Game build string from the User-Agent, as parsed by version-router. */
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
}

/** Cap on DISTINCT problems retained. Aggregation means this is a count of *kinds* of failure, not
 *  of events, so a few hundred is a lot. Bounded because this map is reachable from request data. */
const MAX_KEYS = 400;
/** Per-entry cap on the distinct-caller set, so one endpoint cannot grow unboundedly. */
const MAX_TRACKED_USERS = 64;

interface InternalEntry extends Omit<DiagnosticEntry, 'severity' | 'score' | 'affectedUsers'> {
  users: Set<string>;
  overflowUsers: number;
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
  INTERNAL_ERROR: 5, UNEXPECTED_STATE: 4, AUTH_FAILURE: 4, VERSION_MISMATCH: 4,
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
  const users = e.users.size + e.overflowUsers;
  const recent = e.recent.filter((t) => now - t <= TREND_WINDOW_MS).length;

  const subsystem = SUBSYSTEM_WEIGHT[e.subsystem] ?? 1;
  const category = CATEGORY_WEIGHT[e.category] ?? 1;
  const volume = 1 + Math.log10(Math.max(1, e.count));
  const userFactor = 1 + Math.min(users, 20) / 10;                     // caps at 3x
  const growthFactor = 1 + Math.min(recent / Math.max(1, e.count), 1); // caps at 2x

  const score = subsystem * category * volume * userFactor * growthFactor;
  return { score: Math.round(score * 100) / 100, severity: severityFor(score) };
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
export function recordDiagnostic(input: DiagnosticInput): void {
  try {
    const route = normaliseRoute(input.url);
    const subsystem = subsystemFor(route);
    const version = input.version || 'unknown';
    const key = `${input.category}|${input.method}|${route}|${version}`;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    let e = entries.get(key);
    if (!e) {
      if (entries.size >= MAX_KEYS) evictOne(nowMs);
      e = {
        category: input.category, method: input.method, route, subsystem, version,
        status: input.status, detail: input.detail ? redactSecrets(input.detail).slice(0, 300) : undefined,
        count: 0, firstSeen: nowIso, lastSeen: nowIso,
        users: new Set<string>(), overflowUsers: 0, recent: [],
      };
      entries.set(key, e);
    }

    e.count++;
    e.lastSeen = nowIso;
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
export function getDiagnostics(opts: { category?: DiagnosticCategory; limit?: number } = {}): DiagnosticEntry[] {
  const now = Date.now();
  const out: DiagnosticEntry[] = [];
  for (const e of entries.values()) {
    if (opts.category && e.category !== opts.category) continue;
    const { score, severity } = scoreOf(e, now);
    out.push({
      category: e.category, method: e.method, route: e.route, subsystem: e.subsystem,
      version: e.version, status: e.status, detail: e.detail, count: e.count,
      firstSeen: e.firstSeen, lastSeen: e.lastSeen,
      affectedUsers: e.users.size + e.overflowUsers, severity, score,
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

/** Test/maintenance hook. */
export function clearDiagnostics(): void {
  entries.clear();
}
