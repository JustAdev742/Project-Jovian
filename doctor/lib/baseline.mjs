/**
 * Compare a run against a saved baseline: what is NEW (a regression or a newly detected problem),
 * what is RESOLVED, and what persists.
 *
 * A resolved finding is only ever "no longer detected". It is called resolved here and nowhere is it
 * called fixed — a problem can vanish because its log rotated away. The report says which evidence
 * source was checked so the reader can tell the two apart.
 */
import fs from 'node:fs';

export function compareToBaseline(report, baselinePath) {
  let base;
  try { base = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch { return { compared: false }; }
  const openNow = new Map(report.findings.filter(f => f.status === 'open').map(f => [f.key, f]));
  const openThen = new Map((base.findings || []).filter(f => f.status === 'open').map(f => [f.key, f]));
  const fresh = [...openNow.keys()].filter(k => !openThen.has(k));
  const resolved = [...openThen.keys()].filter(k => !openNow.has(k));
  for (const k of fresh) openNow.get(k).baseline = 'new';
  return {
    compared: true,
    baselineAt: base.startedAt,
    new: fresh,
    resolved: resolved.map(k => ({ key: k, title: openThen.get(k).title, severity: openThen.get(k).severity })),
    persisting: [...openNow.keys()].filter(k => openThen.has(k)).length,
  };
}
