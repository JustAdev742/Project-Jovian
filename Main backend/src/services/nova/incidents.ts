/**
 * Incidents — turning a pile of failure counters into "is something happening right now, to whom,
 * and is it our fault".
 *
 * The diagnostics store answers "what has failed and how badly" as a running total. That is the
 * wrong shape for two questions an operator actually asks:
 *
 *   1. **Is this getting worse?** A total cannot distinguish 600 failures spread over a week from
 *      600 in the last four minutes, and only one of those is an incident.
 *   2. **Whose problem is it?** One player failing repeatedly is a bug report. Forty players across
 *      three builds failing at once is an outage. The response is completely different, and the
 *      count alone never says which.
 *
 * This module keeps a small bounded time series per problem and classifies the shape of it.
 *
 * WHAT IT COSTS. One array of 12 numbers per distinct problem, capped by the store's own 400-key
 * limit — about 4,800 numbers, worst case, for the whole system. Buckets are advanced lazily on
 * write, so an idle problem costs nothing at all until something happens to it.
 */
import type { DiagnosticEntry, DiagnosticCategory, DiagnosticSource } from './diagnostics';

/** Five-minute buckets, one hour of history. Matches the brief's worked example cadence. */
export const BUCKET_MS = 5 * 60 * 1000;
export const BUCKET_COUNT = 12;

interface Series {
  /** Newest LAST. Index 11 is the bucket currently being written. */
  buckets: number[];
  /** Start-of-bucket timestamp for the newest bucket. */
  head: number;
}

const series = new Map<string, Series>();

/** Bounded independently of the store, so a key churn cannot grow this without limit. */
const MAX_SERIES = 500;

function advance(s: Series, now: number): void {
  const elapsed = Math.floor((now - s.head) / BUCKET_MS);
  if (elapsed <= 0) return;
  if (elapsed >= BUCKET_COUNT) {
    s.buckets = new Array(BUCKET_COUNT).fill(0);
  } else {
    s.buckets = [...s.buckets.slice(elapsed), ...new Array(elapsed).fill(0)];
  }
  s.head += elapsed * BUCKET_MS;
}

/**
 * Record `count` occurrences of `key`. Called from `recordDiagnostic`, so it must be cheap and must
 * never throw — a diagnostic that breaks a request is worse than no diagnostic.
 */
export function noteOccurrence(key: string, count: number, now: number = Date.now()): void {
  try {
    let s = series.get(key);
    if (!s) {
      if (series.size >= MAX_SERIES) {
        // Drop the least active series rather than the oldest: an idle-but-recent key is less
        // interesting than a busy one, and this map is reachable from request data.
        let worstKey: string | null = null;
        let worstTotal = Infinity;
        for (const [k, v] of series) {
          const total = v.buckets.reduce((a, b) => a + b, 0);
          if (total < worstTotal) { worstTotal = total; worstKey = k; }
        }
        if (worstKey) series.delete(worstKey);
      }
      s = { buckets: new Array(BUCKET_COUNT).fill(0), head: now - (now % BUCKET_MS) };
      series.set(key, s);
    }
    advance(s, now);
    s.buckets[BUCKET_COUNT - 1] += Math.max(1, count);
  } catch {
    /* never break a request */
  }
}

export interface Trend {
  /** Occurrences in the newest complete-ish bucket. */
  current: number;
  /** Mean per bucket across the preceding history, excluding the current bucket. */
  baseline: number;
  /** Percentage growth over baseline. Null when there is no baseline to compare against. */
  growthPct: number | null;
  /** Is this a spike worth surfacing? See `isSpiking` for the rule and why it is that rule. */
  spiking: boolean;
  /** Newest last, for sparkline rendering. */
  buckets: number[];
}

/**
 * Spike rule, stated so it can be argued with:
 *
 *   current >= MIN_ABSOLUTE  AND  current >= baseline * MULTIPLE
 *
 * Both terms are necessary and neither is sufficient.
 *
 *   - Without MIN_ABSOLUTE, 0 → 2 is an infinite-percentage spike and the dashboard fills with
 *     noise the moment anything happens twice.
 *   - Without the MULTIPLE, a steady high-volume endpoint looks like a permanent emergency.
 *
 * A problem with no history at all (baseline 0) spikes only on the absolute term, which is the
 * behaviour you want for something that has genuinely never happened before.
 */
export const SPIKE_MIN_ABSOLUTE = 10;
export const SPIKE_MULTIPLE = 3;

export function trendOf(key: string, now: number = Date.now()): Trend {
  const s = series.get(key);
  if (!s) return { current: 0, baseline: 0, growthPct: null, spiking: false, buckets: [] };
  advance(s, now);

  const buckets = [...s.buckets];
  const current = buckets[BUCKET_COUNT - 1];
  const history = buckets.slice(0, BUCKET_COUNT - 1);
  const nonEmpty = history.filter((b) => b > 0);
  const baseline = nonEmpty.length ? nonEmpty.reduce((a, b) => a + b, 0) / nonEmpty.length : 0;

  const growthPct = baseline > 0 ? Math.round(((current - baseline) / baseline) * 100) : null;
  const spiking = current >= SPIKE_MIN_ABSOLUTE && current >= baseline * SPIKE_MULTIPLE;

  return { current, baseline: Math.round(baseline * 10) / 10, growthPct, spiking, buckets };
}

/**
 * How far a problem reaches. Ranked responses differ completely between these, which is why the
 * dashboard shows scope rather than only severity.
 */
export type IncidentScope =
  | 'ISOLATED_CLIENT'    // one machine. Almost always local: their install, their network.
  | 'SMALL_CLUSTER'      // a handful. Worth watching; not yet an outage.
  | 'VERSION_SPECIFIC'   // concentrated in one build while others are fine — a regression.
  | 'HOST_ISSUE'         // reported by a gameserver host, not by players.
  | 'BACKEND_OUTAGE'     // we are returning errors, to many people.
  | 'NETWORK_WIDESPREAD' // many clients cannot reach us at all.
  | 'WIDESPREAD';        // broad, but none of the sharper shapes fit.

/**
 * Classify one problem, given the whole picture.
 *
 * `versionsSeen` is every build the store currently knows about. Without it "concentrated in one
 * build" is meaningless — on a single-build deployment EVERYTHING is concentrated in one build, and
 * calling that a version-specific regression would be a permanent false positive. That was the
 * mistake this parameter exists to prevent.
 */
export function classifyScope(
  entry: Pick<DiagnosticEntry, 'source' | 'category' | 'affectedUsers' | 'version'>,
  versionsSeen: Set<string>,
): IncidentScope {
  const users = entry.affectedUsers;

  if (entry.source === 'HOST') return 'HOST_ISSUE';

  // Only meaningful when more than one REAL build is in play. `unknown` is what a request with no
  // parseable User-Agent gets — the launcher, tooling, a browser opening the dashboard — and counting
  // it as a build made a single-build deployment report VERSION_SPECIFIC for everything. Observed on
  // the live dashboard; the unit test passed because it was handed a clean set.
  const realBuilds = [...versionsSeen].filter((v) => v && v !== 'unknown');
  const multipleBuilds = realBuilds.length > 1;
  if (multipleBuilds && users >= 2 && entry.version !== 'unknown') return 'VERSION_SPECIFIC';

  if (entry.source === 'NETWORK' && users >= 5) return 'NETWORK_WIDESPREAD';
  if (entry.source === 'BACKEND' && users >= 5 &&
      (entry.category === 'INTERNAL_ERROR' || entry.category === 'UNEXPECTED_STATE')) {
    return 'BACKEND_OUTAGE';
  }

  if (users <= 1) return 'ISOLATED_CLIENT';
  if (users <= 4) return 'SMALL_CLUSTER';
  return 'WIDESPREAD';
}

export interface Incident {
  /** Stable across polls, so the UI can track one row over time. Derived from the problem identity. */
  id: string;
  title: string;
  category: DiagnosticCategory;
  source: DiagnosticSource;
  component: string;
  subsystem: string;
  route: string;
  method: string;
  version: string;
  severity: DiagnosticEntry['severity'];
  score: number;
  occurrences: number;
  affectedUsers: number;
  firstSeen: string;
  lastSeen: string;
  trend: Trend;
  scope: IncidentScope;
  /** ACTIVE while it is still happening; RESOLVED once it has been quiet for a while. */
  state: 'ACTIVE' | 'RESOLVED';
  /** Present only when the trend rule fires — the "POSSIBLE INCIDENT" marker. */
  possibleIncident: boolean;
  correlationIds: string[];
  /** Other problems seen from the same client population, by id. Cheap correlation. */
  related: string[];
}

/** Quiet for this long and a problem is considered resolved rather than merely idle. */
export const RESOLVE_AFTER_MS = 30 * 60 * 1000;

/** The key `recordDiagnostic` aggregates on. Must match, or trends attach to the wrong row. */
export function seriesKey(e: Pick<DiagnosticEntry, 'source' | 'category' | 'method' | 'route' | 'version'>): string {
  return `${e.source}|${e.category}|${e.method}|${e.route}|${e.version}`;
}

/** Short stable id from the same identity. Readable enough to quote in a message. */
export function incidentId(e: Pick<DiagnosticEntry, 'source' | 'category' | 'method' | 'route' | 'version' | 'subsystem'>): string {
  const key = seriesKey(e);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  const num = (h >>> 0).toString(36).toUpperCase().slice(0, 4).padStart(4, '0');
  return `${e.subsystem.toUpperCase().slice(0, 4)}-${num}`;
}

function titleFor(e: DiagnosticEntry): string {
  const what: Record<string, string> = {
    MISSING: 'Unrouted call',
    FAILED: 'Request rejected',
    TIMEOUT: 'Timed out',
    AUTH_FAILURE: 'Authentication failed',
    INVALID_RESPONSE: 'Malformed response',
    UNEXPECTED_STATE: 'Unexpected state',
    NETWORK_FAILURE: 'Could not reach the server',
    INTERNAL_ERROR: 'Server error',
    VERSION_MISMATCH: 'Build mismatch',
    SESSION_FAILURE: 'Session failure',
    MATCHMAKING_FAILURE: 'Could not find a match',
    PARTY_FAILURE: 'Party failure',
    CRASH: 'Component crashed',
    UNKNOWN: 'Unclassified failure',
  };
  return `${what[e.category] ?? e.category} — ${e.method} ${e.route}`;
}

/** Build the ranked incident list from a diagnostics snapshot. Pure, so it is testable. */
export function buildIncidents(entries: DiagnosticEntry[], now: number = Date.now()): Incident[] {
  const versionsSeen = new Set(entries.map((e) => e.version));

  // Which problems share an affected population, approximated by subsystem + version. Cheap, and
  // good enough to answer "did these start together"; a precise version would need per-user sets.
  const byGroup = new Map<string, string[]>();
  for (const e of entries) {
    const g = `${e.subsystem}|${e.version}`;
    const id = incidentId(e);
    byGroup.set(g, [...(byGroup.get(g) ?? []), id]);
  }

  const out = entries.map((e): Incident => {
    const id = incidentId(e);
    const trend = trendOf(seriesKey(e), now);
    const quietFor = now - Date.parse(e.lastSeen);
    return {
      id,
      title: titleFor(e),
      category: e.category,
      source: e.source,
      component: e.component,
      subsystem: e.subsystem,
      route: e.route,
      method: e.method,
      version: e.version,
      severity: e.severity,
      score: e.score,
      occurrences: e.count,
      affectedUsers: e.affectedUsers,
      firstSeen: e.firstSeen,
      lastSeen: e.lastSeen,
      trend,
      scope: classifyScope(e, versionsSeen),
      state: quietFor > RESOLVE_AFTER_MS ? 'RESOLVED' : 'ACTIVE',
      possibleIncident: trend.spiking && quietFor <= RESOLVE_AFTER_MS,
      correlationIds: e.correlationIds,
      related: (byGroup.get(`${e.subsystem}|${e.version}`) ?? []).filter((x) => x !== id).slice(0, 5),
    };
  });

  // Rank: anything spiking first, then by score. A quiet high-score total should not outrank
  // something that is actively getting worse right now.
  out.sort((a, b) => {
    if (a.possibleIncident !== b.possibleIncident) return a.possibleIncident ? -1 : 1;
    if (a.state !== b.state) return a.state === 'ACTIVE' ? -1 : 1;
    return b.score - a.score;
  });
  return out;
}

/** Test/maintenance hook. */
export function clearIncidents(): void {
  series.clear();
}
