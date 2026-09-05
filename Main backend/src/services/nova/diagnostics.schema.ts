/**
 * The wire schema every Nova component uses to report a failure.
 *
 * Three processes emit these — the backend itself, Cobalt inside the game client, and Project Reboot
 * inside the gameserver — and the whole value of the central view depends on them agreeing. This
 * module is the single definition, and the C++ side mirrors it (see DIAGNOSTIC_SCHEMA.md).
 *
 * EVERYTHING HERE TREATS ITS INPUT AS HOSTILE. Events arrive over HTTP from a player's machine, so
 * `parseEvent` validates rather than trusts: enums are whitelisted, strings are truncated, unknown
 * fields are dropped, numbers are range-checked. A client that lies can only make its OWN rows wrong,
 * and cannot make the store grow without bound, inject a category that skews ranking, or smuggle a
 * token through a free-text field.
 */

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  WHO SAW IT
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Which component observed the failure. The dashboard must never confuse "the client could not
 * reach us" with "we returned a 500" — they have different causes and different fixes, and before
 * this field existed every event was implicitly BACKEND.
 */
export const SOURCES = ['CLIENT', 'HOST', 'BACKEND', 'NETWORK', 'VERSION'] as const;
export type DiagnosticSource = (typeof SOURCES)[number];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  WHAT WENT WRONG
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Canonical failure categories.
 *
 * The first ten predate this module and are load-bearing for the existing store, its tests and the
 * launcher's Self-check; they are kept exactly. The last four are the subsystem-specific failures a
 * client or host can report that the backend could never see for itself — a matchmaking attempt that
 * never produced a request, a party that failed to form, a gameserver that died.
 */
export const CATEGORIES = [
  'MISSING',              // no route matched; the catch-all answered
  'FAILED',               // a handler ran and deliberately returned 4xx
  'TIMEOUT',
  'AUTH_FAILURE',
  'INVALID_RESPONSE',
  'UNEXPECTED_STATE',
  'NETWORK_FAILURE',
  'INTERNAL_ERROR',
  'VERSION_MISMATCH',
  'UNKNOWN',
  'SESSION_FAILURE',      // a session could not be created, joined or kept
  'MATCHMAKING_FAILURE',  // the player could not be placed in a match
  'PARTY_FAILURE',
  'CRASH',                // a component died
] as const;
export type DiagnosticCategory = (typeof CATEGORIES)[number];

/**
 * Names accepted on the wire that are not canonical.
 *
 * The engineering brief names a slightly different taxonomy, and the C++ emitters were written
 * against it. Rather than force one vocabulary on the other — or, worse, keep two — the ingest
 * boundary accepts both and normalises. `UNROUTED_PATH` and `MISSING_CALL` are the same event seen
 * from the client rather than the server; `source` already carries that distinction, so folding them
 * into MISSING keeps one row per real problem instead of three.
 */
const ALIASES: Record<string, DiagnosticCategory> = {
  MISSING_CALL: 'MISSING',
  UNROUTED_PATH: 'MISSING',
  FAILED_CALL: 'FAILED',
  OTHER: 'UNKNOWN',
  SESSION_ERROR: 'SESSION_FAILURE',
  MATCHMAKING_ERROR: 'MATCHMAKING_FAILURE',
  PARTY_ERROR: 'PARTY_FAILURE',
};

const CATEGORY_SET = new Set<string>(CATEGORIES);
const SOURCE_SET = new Set<string>(SOURCES);

export function normaliseCategory(raw: unknown): DiagnosticCategory {
  const s = String(raw ?? '').toUpperCase().trim();
  if (CATEGORY_SET.has(s)) return s as DiagnosticCategory;
  return ALIASES[s] ?? 'UNKNOWN';
}

export function normaliseSource(raw: unknown): DiagnosticSource {
  const s = String(raw ?? '').toUpperCase().trim();
  return SOURCE_SET.has(s) ? (s as DiagnosticSource) : 'CLIENT';
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  THE EVENT
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Hard caps. Every one of these is reachable from untrusted input. */
export const LIMITS = {
  /** Events accepted in a single POST. A client with more than this is rate-limited, not served. */
  MAX_BATCH: 50,
  MAX_URL: 512,
  MAX_DETAIL: 300,
  MAX_COMPONENT: 40,
  MAX_BUILD: 80,
  MAX_CORRELATION: 64,
  /** Occurrence count a single client may claim for one event. Stops a client inflating a ranking. */
  MAX_CLAIMED_COUNT: 1000,
} as const;

export interface DiagnosticEvent {
  source: DiagnosticSource;
  category: DiagnosticCategory;
  /** HTTP method, or a short verb like `LAUNCH` / `TRAVEL` for non-HTTP events. */
  method: string;
  /** The path or operation. Normalised and redacted by the store, never by the caller. */
  url: string;
  /** Which component emitted it — `cobalt`, `reboot`, `launcher`, `backend`. */
  component: string;
  /** Client build string, e.g. `++Fortnite+Release-7.40-CL-5046157`. */
  build?: string;
  status?: number;
  detail?: string;
  /**
   * Ties one player action together across Cobalt → backend → host. Generated client-side, opaque
   * to us, and the only way to answer "where did this FIRST fail" rather than "what failed last".
   */
  correlationId?: string;
  /** How many times the client already aggregated this locally before sending it. */
  count: number;
  /** Client-side timestamp, ms. Advisory only — the server stamps its own. */
  clientTimeMs?: number;
}

function str(v: unknown, max: number): string {
  return String(v ?? '').slice(0, max);
}

/**
 * Parse one untrusted event. Returns null for anything unusable rather than throwing — a malformed
 * event in a batch must not discard the well-formed ones around it.
 */
export function parseEvent(raw: unknown): DiagnosticEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  const url = str(o.url ?? o.path, LIMITS.MAX_URL);
  const method = str(o.method, 16).toUpperCase() || 'GET';
  // An event with no subject cannot be aggregated into anything meaningful.
  if (!url) return null;

  const rawCount = Number(o.count);
  const count = Number.isFinite(rawCount)
    ? Math.max(1, Math.min(Math.floor(rawCount), LIMITS.MAX_CLAIMED_COUNT))
    : 1;

  const status = Number(o.status);

  return {
    source: normaliseSource(o.source),
    category: normaliseCategory(o.category),
    method,
    url,
    component: str(o.component, LIMITS.MAX_COMPONENT) || 'unknown',
    build: o.build ? str(o.build, LIMITS.MAX_BUILD) : undefined,
    status: Number.isFinite(status) && status >= 100 && status <= 599 ? status : undefined,
    detail: o.detail ? str(o.detail, LIMITS.MAX_DETAIL) : undefined,
    correlationId: o.correlationId ? str(o.correlationId, LIMITS.MAX_CORRELATION) : undefined,
    count,
    clientTimeMs: Number.isFinite(Number(o.clientTimeMs)) ? Number(o.clientTimeMs) : undefined,
  };
}

/** Parse a batch, dropping unusable entries and capping the total. */
export function parseBatch(raw: unknown): DiagnosticEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: DiagnosticEvent[] = [];
  for (const item of raw.slice(0, LIMITS.MAX_BATCH)) {
    const ev = parseEvent(item);
    if (ev) out.push(ev);
  }
  return out;
}
