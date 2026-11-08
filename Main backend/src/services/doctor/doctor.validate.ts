/**
 * Everything a player's machine sends about itself is UNTRUSTED. These functions whitelist the
 * fields the fleet dashboard uses, clamp every string and number, re-redact text (the sender already
 * did; a second layer is cheap), and refuse decompression bombs.
 *
 * The output of normalizeReport is what gets stored and later rendered into an admin page, so
 * nothing here may let a sender choose markup: values are plain strings and numbers, and the
 * renderer escapes all of them.
 */
import zlib from 'node:zlib';
import { redactSecrets } from '../nova/diagnostics';

export const SEVERITIES = ['P0', 'P1', 'P2', 'P3', 'INFO'] as const;
export const CONFIDENCES = ['CONFIRMED', 'PROBABLE', 'POTENTIAL'] as const;
export const STATUSES = ['open', 'stale', 'not-ours', 'known-benign', 'resolved', 'proof'] as const;
const COVERAGE = ['checked', 'skipped', 'n/a', 'error'] as const;
const SOURCES = ['client', 'server', 'cobalt', 'agent'] as const;

export const LIMITS = {
  LINES_PER_BATCH: 500,
  LINE_TEXT: 400,
  FULL_GZ_BYTES: 2_000_000,       // compressed, as sent
  FULL_JSON_BYTES: 12_000_000,    // decompressed ceiling — a zip bomb stops here
  FINDINGS: 500,
  EVIDENCE: 8,
  CAUSES: 30,
  COVERAGE: 250,
};

const str = (v: unknown, max: number): string => (v == null ? '' : redactSecrets(String(v))).slice(0, max);
const optStr = (v: unknown, max: number): string | null => (v == null || v === '' ? null : str(v, max));
const int = (v: unknown, min: number, max: number, dflt = 0): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
function pick<T extends readonly string[]>(v: unknown, list: T, dflt: T[number]): T[number] {
  return (list as readonly string[]).includes(v as string) ? (v as T[number]) : dflt;
}
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** `count` > 1 means the same line repeated that many times in a burst and was sent once (live.mjs). */
export interface LiveLine { src: string; sev: string; rule: string | null; status: string; t: string | null; text: string; count: number }

export function normalizeLines(raw: unknown): LiveLine[] {
  return arr(raw, LIMITS.LINES_PER_BATCH).map(x => {
    const l = obj(x);
    return {
      src: pick(l.src, SOURCES, 'client'),
      sev: pick(l.sev, SEVERITIES, 'P3'),
      rule: optStr(l.rule, 80),
      status: pick(l.status, STATUSES, 'open'),
      t: optStr(l.t, 40),
      text: str(l.text, LIMITS.LINE_TEXT),
      count: Math.min(Math.max(Math.trunc(Number(l.count)) || 1, 1), 1_000_000),
    };
  }).filter(l => l.text.length > 0);
}

function bySeverity(v: unknown): Record<string, number> {
  const o = obj(v);
  return Object.fromEntries(SEVERITIES.map(s => [s, int(o[s], 0, 1e6)]));
}

export function normalizeSummary(raw: unknown) {
  const s = obj(raw);
  const sum = obj(s.summary);
  const v = obj(s.verdict);
  return {
    version: str(s.version, 20),
    profile: str(s.profile, 12),
    startedAt: optStr(s.startedAt, 40),
    finishedAt: optStr(s.finishedAt, 40),
    machine: str(s.machine, 64),
    verdict: { lead: str(v.lead, 600), rest: str(v.rest, 400) },
    summary: { total: int(sum.total, 0, 1e6), open: int(sum.open, 0, 1e6), bySeverity: bySeverity(sum.bySeverity) },
    causes: arr(s.causes, LIMITS.CAUSES).map(x => {
      const c = obj(x);
      return { id: str(c.id, 64), title: str(c.title, 300), severity: pick(c.severity, SEVERITIES, 'P3'), confidence: pick(c.confidence, CONFIDENCES, 'POTENTIAL'), findings: int(c.findings, 0, 1e5) };
    }),
    top: arr(s.top, 60).map(x => {
      const f = obj(x);
      return {
        key: str(f.key, 300), id: str(f.id, 100), title: str(f.title, 300),
        severity: pick(f.severity, SEVERITIES, 'P3'), confidence: pick(f.confidence, CONFIDENCES, 'POTENTIAL'),
        status: pick(f.status, STATUSES, 'open'), component: str(f.component, 20), count: int(f.count, 0, 1e9),
        lastSeen: optStr(f.lastSeen, 40),
      };
    }),
  };
}

/** The full report, reduced to exactly the fields the doctor's renderer reads. */
export function normalizeReport(raw: unknown) {
  const r = obj(raw);
  const o = obj(r.options);
  const sum = obj(r.summary);
  const b = obj(r.baseline);
  return {
    tool: 'nova-doctor',
    version: str(r.version, 20),
    startedAt: str(r.startedAt, 40),
    finishedAt: str(r.finishedAt, 40),
    machine: str(r.machine, 64),
    options: { build: o.build === true, remote: o.remote === true, profile: str(o.profile, 12) },
    summary: { total: int(sum.total, 0, 1e6), open: int(sum.open, 0, 1e6), bySeverity: bySeverity(sum.bySeverity), byConfidence: {}, byComponent: {} },
    causes: arr(r.causes, LIMITS.CAUSES).map(x => {
      const c = obj(x);
      return {
        id: str(c.id, 64), title: str(c.title, 300), short: optStr(c.short, 200),
        severity: pick(c.severity, SEVERITIES, 'P3'), confidence: pick(c.confidence, CONFIDENCES, 'POTENTIAL'),
        narrative: str(c.narrative, 1500), next: str(c.next, 600),
        findings: arr(c.findings, 200).map(k => str(k, 300)),
      };
    }),
    coverage: arr(r.coverage, LIMITS.COVERAGE).map(x => {
      const c = obj(x);
      return { module: str(c.module, 20), area: str(c.area, 120), status: pick(c.status, COVERAGE, 'skipped'), detail: str(c.detail, 300) };
    }),
    findings: arr(r.findings, LIMITS.FINDINGS).map(x => {
      const f = obj(x);
      const fix = obj(f.fix);
      const data = obj(f.data);
      return {
        key: str(f.key, 300), id: str(f.id, 100), title: str(f.title, 300), module: str(f.module, 20),
        component: str(f.component, 20), category: str(f.category, 40),
        severity: pick(f.severity, SEVERITIES, 'P3'), confidence: pick(f.confidence, CONFIDENCES, 'POTENTIAL'),
        status: pick(f.status, STATUSES, 'open'), count: int(f.count, 0, 1e9),
        firstSeen: optStr(f.firstSeen, 40), lastSeen: optStr(f.lastSeen, 40),
        explain: str(f.explain, 1200), cause: optStr(f.cause, 64), kb: optStr(f.kb, 200),
        fix: f.fix ? { summary: str(fix.summary, 400), repairId: optStr(fix.repairId, 60) } : null,
        baseline: f.baseline === 'new' ? 'new' : undefined,
        evidence: arr(f.evidence, LIMITS.EVIDENCE).map(y => {
          const e = obj(y);
          return { source: optStr(e.source, 200), line: e.line == null ? null : int(e.line, 0, 1e9), time: optStr(e.time, 40), excerpt: str(e.excerpt, 400) };
        }),
        data: data.stale ? { stale: str(data.stale, 300) } : null,
      };
    }),
    baseline: b.compared === true
      ? {
        compared: true, baselineAt: str(b.baselineAt, 40),
        new: arr(b.new, 200).map(k => str(k, 300)),
        resolved: arr(b.resolved, 200).map(y => { const z = obj(y); return { key: str(z.key, 300), title: str(z.title, 300), severity: pick(z.severity, SEVERITIES, 'P3') }; }),
        persisting: int(b.persisting, 0, 1e6),
      }
      : { compared: false },
  };
}

/** base64(gzip(json)) → normalized report, or null. Never decompresses past FULL_JSON_BYTES. */
export function decodeFullReport(b64: unknown) {
  if (typeof b64 !== 'string' || !b64 || b64.length > Math.ceil(LIMITS.FULL_GZ_BYTES * 4 / 3) + 8) return null;
  try {
    const gz = Buffer.from(b64, 'base64');
    const json = zlib.gunzipSync(gz, { maxOutputLength: LIMITS.FULL_JSON_BYTES });
    return normalizeReport(JSON.parse(json.toString('utf8')));
  } catch {
    return null;
  }
}
