/**
 * Working out which build is talking to us.
 *
 * The old model was one regex over the User-Agent, and whatever it produced was treated as fact. It
 * had two failure modes that matter for a cross-version backend:
 *
 *   1. `season = major`, true only in Chapter 1 (see builds.ts).
 *   2. No notion of *how sure* it was. A parsed 7.40 and a fallback default were the same shape, so
 *      downstream code could not tell a measurement from a guess, and neither could a diagnostic.
 *
 * This module keeps the User-Agent as the primary signal — it is the only one 7.40 reliably provides
 * — but records corroboration and confidence explicitly, and refuses to invent a chapter for a
 * major it has no evidence for.
 */
import { eraForMajor, NEWEST_KNOWN_MAJOR } from './builds';
import { clientById, eraConflict } from './clients';

/** How much weight the identification carries. Mirrors the project-wide evidence grades. */
export type VersionConfidence =
  /** Parsed from the client's own User-Agent AND the major is in the build registry. */
  | 'CONFIRMED'
  /** Parsed, but the major is outside the registry — the numbers are real, the era is inferred. */
  | 'STRONGLY_SUPPORTED'
  /** Nothing usable in the request; this is the configured default. */
  | 'UNKNOWN';

export interface GameVersion {
  major: number;
  minor: number;
  /** Season WITHIN the chapter. Null when the major is not in the registry — never faked. */
  season: number | null;
  /** Chapter. Null when the major is not in the registry. */
  chapter: number | null;
  /** Epic changelist, when the client sent one. A second, independent signal. */
  changelist?: number;
  /** The raw User-Agent, kept for diagnostics. Never parsed downstream — parse here or nowhere. */
  buildString: string;
  confidence: VersionConfidence;
  /** Which signals actually contributed. Makes a wrong identification debuggable. */
  signals: string[];
  /** Stable id for keying compatibility profiles and diagnostics, e.g. "7.40" or "unknown". */
  id: string;
  /** Platform, when the OAuth client id identifies one. CONFIRMED from the client registry. */
  platform?: string;
  /**
   * Set when the client id and the parsed build cannot both be true — a PS5 client claiming a 2019
   * build. Advisory only: the underlying floor is INFERRED, so this raises a diagnostic and never
   * rejects a request.
   */
  eraConflict?: string;
}

/**
 * `Fortnite/++Fortnite+Release-7.40-CL-5046157 Windows/10.0.17763.1.256.64bit`
 *
 * Anchored on `Release-` because a bare `\d+\.\d+` also matches the Windows version that follows it,
 * and on some agents matches it FIRST.
 */
const RELEASE_RE = /Release-(\d+)\.(\d+)/;
const CL_RE = /CL-(\d+)/;

/**
 * Pull the client id out of `Authorization: basic base64(clientId:secret)`.
 *
 * Case-insensitive on the scheme because Fortnite sends a lowercase `basic`, which is legal and has
 * caught this project out before in auth.routes.ts.
 */
function basicAuthClientId(headers: Record<string, unknown>): string {
  const raw = String(headers['authorization'] ?? '');
  if (!/^basic\s+/i.test(raw)) return '';
  try {
    const decoded = Buffer.from(raw.replace(/^basic\s+/i, ''), 'base64').toString('utf-8');
    return decoded.split(':')[0] ?? '';
  } catch {
    return '';
  }
}

/**
 * Identify the client version from a request's headers.
 *
 * `fallbackMajor` is used only when nothing can be parsed, and the result is marked UNKNOWN so a
 * caller can tell the difference. It is deliberately a parameter rather than a Config import: this
 * module is pure, which is what makes it testable without booting the app.
 */
export function identifyVersion(
  headers: Record<string, unknown>,
  fallbackMajor: number,
): GameVersion {
  const ua = String(headers['user-agent'] ?? '');
  const signals: string[] = [];

  const release = RELEASE_RE.exec(ua);
  const cl = CL_RE.exec(ua);

  // SECOND SIGNAL: the OAuth client id, from the Basic auth header the client sends on its very
  // first request. It does not depend on the User-Agent being parseable, which is the point.
  //
  // It identifies the PLATFORM, not the era — Epic's client table is partitioned by platform and
  // region, and one PC id covers every Fortnite version there has ever been. See clients.ts. So it
  // corroborates and annotates; it never decides the build.
  const client = clientById(basicAuthClientId(headers));

  if (!release) {
    // No version in the request at all: the launcher, tooling, or proxied traffic. Answer with the
    // configured target and be honest that it is a default. Note season/chapter still come from the
    // registry — the fallback picks a MAJOR, it does not get to invent an era.
    const era = eraForMajor(fallbackMajor);
    return {
      major: fallbackMajor,
      minor: 0,
      season: era?.season ?? null,
      chapter: era?.chapter ?? null,
      buildString: ua || 'unknown',
      confidence: 'UNKNOWN',
      signals: client ? ['fallback:configured-target', 'client-id:platform'] : ['fallback:configured-target'],
      id: 'unknown',
      platform: client?.platform,
    };
  }

  signals.push('user-agent:Release');
  const major = parseInt(release[1], 10);
  const minor = parseInt(release[2], 10);

  const era = eraForMajor(major);
  if (era) signals.push('registry:chapter-season');

  const changelist = cl ? parseInt(cl[1], 10) : undefined;
  if (changelist !== undefined) signals.push('user-agent:CL');
  if (client) signals.push('client-id:platform');

  const conflict = eraConflict(client?.clientId ?? '', major);
  if (conflict) signals.push('client-id:era-conflict');

  return {
    major,
    minor,
    season: era?.season ?? null,
    chapter: era?.chapter ?? null,
    changelist,
    buildString: ua,
    // A major beyond the registry is still a real, parsed version — we just cannot place it in a
    // chapter. Saying CONFIRMED there would be exactly the silent upgrade the project forbids.
    confidence: era ? 'CONFIRMED' : 'STRONGLY_SUPPORTED',
    signals,
    id: `${major}.${String(minor).padStart(2, '0')}`,
    platform: client?.platform,
    eraConflict: conflict ?? undefined,
  };
}

/** True when `v` is at or after `major.minor`. The ordering used by every compatibility check. */
export function atOrAfter(v: { major: number; minor: number }, major: number, minor = 0): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/** True when `v` is strictly before `major.minor`. */
export function before(v: { major: number; minor: number }, major: number, minor = 0): boolean {
  return !atOrAfter(v, major, minor);
}

/**
 * Is this a build the registry has never heard of?
 *
 * Worth surfacing rather than swallowing: a client newer than the registry is the signal that the
 * corpus needs refreshing, and it is the case most likely to be served wrong behaviour silently.
 */
export function isBeyondKnownBuilds(v: { major: number }): boolean {
  return v.major > NEWEST_KNOWN_MAJOR;
}
