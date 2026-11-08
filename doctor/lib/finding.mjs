/**
 * The unit of output: one problem, with the evidence for it.
 *
 * Two axes that must never be confused, because confusing them is how this project has produced
 * confident wrong answers before (see KNOWN_ISSUES.md, "How to read this"):
 *
 *   severity    how bad it is IF real     P0 blocks play or hosting · P1 serious · P2 degraded ·
 *                                         P3 minor · INFO worth knowing, not a defect
 *   confidence  how sure we are it IS real
 *               CONFIRMED  a positive signal was observed (a log line, a hash mismatch, a failed
 *                          build) — not merely the absence of a good one
 *               PROBABLE   strong indirect evidence; one link of the chain is inferred
 *               POTENTIAL  a heuristic or static pattern; a lead, not a finding
 *
 * Coverage is never capped. Every line of every log is read and every occurrence counted; only the
 * number of evidence SAMPLES kept per finding is bounded, and the total is always carried in `count`
 * so a capped sample list can never be mistaken for the full picture.
 */

export const SEVERITIES = ['P0', 'P1', 'P2', 'P3', 'INFO'];
export const CONFIDENCES = ['CONFIRMED', 'PROBABLE', 'POTENTIAL'];
/** stale = not seen in the most recent sessions: may be fixed, or simply not exercised. Never "fixed". */
export const STATUSES = ['open', 'stale', 'not-ours', 'known-benign', 'resolved'];
export const COMPONENTS = [
  'backend', 'launcher', 'cobalt', 'reboot', 'proxy', 'coordinator', 'game', 'environment', 'doctor',
];

/** Evidence samples kept per finding. The count is never capped; only the samples are. */
export const MAX_SAMPLES = 8;

/**
 * Strip secrets from anything that will be written to a report.
 *
 * The report is meant to be shared, and the evidence it quotes comes straight from logs that have
 * held live bearer tokens (launcher-startup.log did until 2026-11-08). Mirrors the launcher's
 * ue4log::redact and the backend's redactSecrets, plus the secret-shaped values this project uses.
 */
export function redact(text) {
  if (text == null) return text;
  return String(text)
    .replace(/eg1~[A-Za-z0-9._~+\/=-]+/g, 'eg1~<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '<jwt-redacted>')
    .replace(/(authorization:\s*(?:bearer|basic)\s+)\S+/gi, '$1<redacted>')
    .replace(/tskey-[A-Za-z0-9-]+/g, 'tskey-<redacted>')
    .replace(/([?&](?:secret|token|access_token|code|password)=)[^&\s"]+/gi, '$1<redacted>')
    .replace(/(NOVA_[A-Z_]*(?:SECRET|KEY|TOKEN)[A-Z_]*\s*=\s*)\S+/g, '$1<redacted>')
    .replace(/(-AUTH_PASSWORD=)\S+/g, '$1<redacted>')
    .replace(/("(?:secret|password|access_token|refresh_token)"\s*:\s*")[^"]*"/gi, '$1<redacted>"');
}

function clip(s, n = 400) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function rank(list, v) {
  const i = list.indexOf(v);
  return i < 0 ? list.length : i;
}

/** Normalise and validate one finding as a module reports it. Throws on a malformed one. */
export function makeFinding(f) {
  if (!f || typeof f.id !== 'string' || !f.id) throw new Error('finding needs an id');
  if (!SEVERITIES.includes(f.severity)) throw new Error(`${f.id}: bad severity ${f.severity}`);
  if (!CONFIDENCES.includes(f.confidence)) throw new Error(`${f.id}: bad confidence ${f.confidence}`);
  const status = f.status ?? 'open';
  if (!STATUSES.includes(status)) throw new Error(`${f.id}: bad status ${status}`);
  const component = f.component ?? 'environment';
  if (!COMPONENTS.includes(component)) throw new Error(`${f.id}: bad component ${component}`);
  return {
    id: f.id,
    key: f.key ?? f.id,
    title: redact(f.title ?? f.id),
    module: f.module ?? 'unknown',
    component,
    category: f.category ?? 'general',
    severity: f.severity,
    confidence: f.confidence,
    status,
    count: Number.isFinite(f.count) ? f.count : 1,
    firstSeen: f.firstSeen ?? null,
    lastSeen: f.lastSeen ?? null,
    explain: redact(f.explain ?? ''),
    cause: f.cause ?? null,
    kb: f.kb ?? null,
    fix: f.fix ? { ...f.fix, summary: redact(f.fix.summary ?? '') } : null,
    evidence: (f.evidence ?? []).slice(0, MAX_SAMPLES).map(e => ({
      source: e.source ?? null,
      line: e.line ?? null,
      time: e.time ?? null,
      excerpt: clip(redact(e.excerpt ?? '')),
    })),
    data: f.data ?? null,
  };
}

/**
 * All findings for one run, de-duplicated by key. Reporting the same key twice MERGES: counts add,
 * the time range widens, evidence samples accumulate up to the cap, and the stronger severity and
 * confidence win. That is what lets a module report per occurrence without flooding the report.
 */
export class FindingSet {
  constructor() { this.map = new Map(); }

  add(raw) {
    const f = makeFinding(raw);
    const prev = this.map.get(f.key);
    if (!prev) { this.map.set(f.key, f); return f; }
    prev.count += f.count;
    if (f.firstSeen && (!prev.firstSeen || f.firstSeen < prev.firstSeen)) prev.firstSeen = f.firstSeen;
    if (f.lastSeen && (!prev.lastSeen || f.lastSeen > prev.lastSeen)) prev.lastSeen = f.lastSeen;
    for (const e of f.evidence) if (prev.evidence.length < MAX_SAMPLES) prev.evidence.push(e);
    if (rank(SEVERITIES, f.severity) < rank(SEVERITIES, prev.severity)) prev.severity = f.severity;
    if (rank(CONFIDENCES, f.confidence) < rank(CONFIDENCES, prev.confidence)) prev.confidence = f.confidence;
    return prev;
  }

  get(key) { return this.map.get(key); }
  has(key) { return this.map.has(key); }
  get size() { return this.map.size; }

  /** Most urgent first: open before closed, then severity, then confidence, then frequency. */
  list() {
    const statusRank = s => ({ open: 0, stale: 1, 'not-ours': 2, 'known-benign': 2, resolved: 3 })[s] ?? 2;
    return [...this.map.values()].sort((a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      rank(SEVERITIES, a.severity) - rank(SEVERITIES, b.severity) ||
      rank(CONFIDENCES, a.confidence) - rank(CONFIDENCES, b.confidence) ||
      b.count - a.count ||
      a.key.localeCompare(b.key));
  }
}
