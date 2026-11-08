/**
 * What a player's machine sends about one scan: a compact summary the fleet dashboard can list, and
 * the full report (gzipped) for the per-player view. The server re-validates every field — this
 * file only decides what is worth sending and keeps it small.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import zlib from 'node:zlib';
import { verdict } from './render.mjs';

/** Compressed full-report ceiling. Above it, evidence is trimmed; above it again, only the summary goes. */
export const FULL_REPORT_MAX = 1_500_000;
const TOP_FINDINGS = 60;

/**
 * The PC's name never leaves it: a Windows hostname is often a person's name ("SCOTTS-PC"). Admins
 * still need to tell two PCs on one account apart, so it becomes a stable 8-hex label instead.
 */
export function machineLabel(host = os.hostname()) {
  return 'PC-' + crypto.createHash('sha256').update(String(host).toLowerCase()).digest('hex').slice(0, 8);
}
/** Replaces the hostname wherever it appears in a string (log lines, evidence). */
export function scrubHost(text, host = os.hostname()) {
  if (!host || host.length < 4 || typeof text !== 'string') return text;
  const re = new RegExp('\\b' + host.replace(/[^A-Za-z0-9]/g, c => '\\' + c) + '\\b', 'gi');
  return text.replace(re, machineLabel(host));
}

export function buildSummary(report) {
  const open = report.findings.filter(f => f.status === 'open');
  return {
    version: report.version,
    profile: report.options?.profile || 'player',
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    machine: report.machine,
    verdict: verdict(report),
    summary: report.summary,
    causes: (report.causes || []).map(c => ({ id: c.id, title: c.title, severity: c.severity, confidence: c.confidence, findings: c.findings.length })),
    top: open.slice(0, TOP_FINDINGS).map(f => ({
      key: f.key, id: f.id, title: f.title, severity: f.severity, confidence: f.confidence,
      status: f.status, component: f.component, count: f.count, lastSeen: f.lastSeen,
    })),
  };
}

function gz(obj) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 });
}

export function buildUpload(report, host = os.hostname()) {
  // Through JSON so the name is caught in evidence and paths too, not just report.machine.
  report = JSON.parse(scrubHost(JSON.stringify(report), host));
  const summary = buildSummary(report);
  let full = gz(report);
  if (full.length > FULL_REPORT_MAX) {
    const trimmed = { ...report, findings: report.findings.map(f => ({ ...f, evidence: f.evidence.slice(0, 2) })) };
    full = gz(trimmed);
  }
  if (full.length > FULL_REPORT_MAX) return { summary, full: null, fullBytes: full.length };
  return { summary, full: full.toString('base64'), fullBytes: full.length };
}
