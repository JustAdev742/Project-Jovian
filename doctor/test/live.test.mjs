/**
 * Live mode must send problems only, read only new bytes, and survive rotation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyLine, Tail, LIMITS } from '../lib/live.mjs';
import { buildUpload, buildSummary } from '../lib/upload.mjs';

test('a known problem is kept, with its rule', () => {
  const c = classifyLine('ue4:client', '[2026.09.19-02.47.15:721][686]LogFort: Warning: AFortQuickBars::AddItemInternal could not find Item with GUID 520B7F5C');
  assert.equal(c.rule, 'quickbar-guid-unmapped');
  assert.equal(c.sev, 'P0');
});

test('benign and not-ours lines are dropped — they are noise the catalog already explains', () => {
  assert.equal(classifyLine('ue4:client', 'LogHttp: bVerifyPeer = true  - Libcurl will verify peer certificate'), null);
  assert.equal(classifyLine('ue4:client', "[2026.09.18-11.12.58:001][  0]LogStreaming: Warning: Couldn't find file for package /Game/Items/LootQuotaData requested"), null);
});

test('ordinary log lines and engine-noise warnings are not sent', () => {
  assert.equal(classifyLine('ue4:client', '[2026.09.19-02.44.09:873][  0]LogConfig: Setting CVar [[tick.LightweightTimeguardThresholdMS:30]]'), null);
  assert.equal(classifyLine('ue4:host', "[2026.09.19-02.44.09:873][  0]LogFortAI: Warning: Can't match wall pattern"), null);
});

test('an unclassified UE4 error is still sent', () => {
  const c = classifyLine('ue4:host', '[2026.09.19-02.44.09:873][  0]LogStreaming: Error: Found 3 dependent packages...');
  assert.equal(c.rule, null);
  assert.equal(c.sev, 'P3');
});

test('a proof line (a fix that ran) is sent — it is good news the dashboard should show', () => {
  const c = classifyLine('cobalt', '12:07:18.000 [QuickBars] controller property found at offset 2152');
  assert.equal(c.status, 'proof');
});

test('the tail starts at the end, then reads only appended lines, holding a partial line back', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-live-')), 'cobalt.log');
  fs.writeFileSync(f, 'old line 1\nold line 2\n');
  const t = new Tail(f, 'cobalt');
  assert.deepEqual(t.read(), [], 'history is not resent');
  fs.appendFileSync(f, 'new A\nnew B\npart');
  assert.deepEqual(t.read(), ['new A', 'new B']);
  fs.appendFileSync(f, 'ial\n');
  assert.deepEqual(t.read(), ['partial']);
  assert.deepEqual(t.read(), [], 'nothing new, nothing read');
});

test('a rotated (shorter) log is read from the start', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-live-')), 'x.log');
  fs.writeFileSync(f, 'a long first session line that makes the file big\n'.repeat(20));
  const t = new Tail(f, 'cobalt');
  t.read();
  fs.writeFileSync(f, 'fresh 1\nfresh 2\n');
  assert.deepEqual(t.read(), ['fresh 1', 'fresh 2']);
});

test('a burst bigger than the per-tick budget is skipped and counted, not read', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-live-')), 'x.log');
  fs.writeFileSync(f, '');
  const t = new Tail(f, 'cobalt');
  t.read();
  fs.appendFileSync(f, 'x'.repeat(LIMITS.MAX_BYTES_PER_TICK + 5000) + '\nlast\n');
  const lines = t.read();
  assert.ok(t.skipped > 0, 'the skipped bytes are counted');
  assert.equal(lines[lines.length - 1], 'last');
});

test('the upload is compact: a summary plus a gzipped full report', () => {
  const report = {
    version: '1.0.0', machine: 'PC', startedAt: '2026-11-08T00:00:00Z', finishedAt: '2026-11-08T00:00:03Z',
    options: { profile: 'player' }, summary: { total: 1, open: 1, bySeverity: { P0: 1 } },
    causes: [{ id: 'c', title: 'Cause', severity: 'P0', confidence: 'CONFIRMED', narrative: '', next: '', findings: ['k'] }],
    coverage: [], baseline: { compared: false },
    findings: [{ key: 'k', id: 'log.x', title: 'Problem', severity: 'P0', confidence: 'CONFIRMED', status: 'open', component: 'game', count: 3, evidence: [] }],
  };
  const s = buildSummary(report);
  assert.equal(s.top.length, 1);
  assert.equal(s.causes[0].findings, 1);
  const u = buildUpload(report);
  assert.ok(u.full && u.fullBytes < 2000);
});

test('the PC name never leaves the machine: summary, full report and evidence carry a hashed label', async () => {
  const zlib = await import('node:zlib');
  const host = 'SCOTTS-GAMING-PC';
  const report = {
    version: '1.0.0', machine: host, startedAt: '2026-11-08T00:00:00Z', finishedAt: '2026-11-08T00:00:03Z',
    options: { profile: 'player' }, summary: { total: 1, open: 1, bySeverity: { P1: 1 } }, causes: [], coverage: [], baseline: { compared: false },
    findings: [{ key: 'k', id: 'log.x', title: 'Problem', severity: 'P1', confidence: 'CONFIRMED', status: 'open', component: 'game', count: 1,
      evidence: [{ kind: 'log', text: 'LogInit: Computer: scotts-gaming-pc' }] }],
  };
  const u = buildUpload(report, host);
  assert.match(u.summary.machine, /^PC-[0-9a-f]{8}$/);
  const full = zlib.gunzipSync(Buffer.from(u.full, 'base64')).toString('utf8');
  assert.ok(!/scotts-gaming-pc/i.test(full), 'no trace of the hostname in the full report');
  assert.ok(full.includes(u.summary.machine), 'the same label replaces it everywhere');
  assert.equal(report.machine, host, 'the caller’s report is not mutated');
});
