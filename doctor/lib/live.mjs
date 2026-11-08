/**
 * Live mode — what the launcher runs on every player's PC.
 *
 *   node doctor/nova-doctor.mjs live --agent http://127.0.0.1:3552 --parent <launcher pid>
 *
 * It does two things, and both are built around one constraint: it must be LIGHT on a machine that
 * is also running Fortnite.
 *
 *   1. Live lines. Every TICK it stats the current logs and reads ONLY the bytes appended since the
 *      last tick — never a whole file. New lines are classified with the doctor's own catalog and
 *      UE4 grammar; only problems are kept (catalog matches that are not benign, UE4 Error/Fatal,
 *      warnings in Nova-owned categories). They are redacted, queued (bounded, oldest dropped and
 *      counted) and handed to the local agent every FLUSH.
 *
 *   2. Full report. A player-profile scan (~2-3 s of one core) runs at most once per SCAN_COOLDOWN,
 *      and NEVER while the game is writing its log: once after start-up if the game is idle, and
 *      when a game session goes quiet. The summary and the gzipped report go to the local agent.
 *
 * The launcher, not this process, forwards to the coordinator under the player's token — the same
 * attribution model the DLLs use (DIAGNOSTICS_ARCHITECTURE §2): nothing here holds a credential.
 *
 * The process lowers its own priority, exits when the launcher (--parent) goes away, and stops
 * sending the moment %LOCALAPPDATA%\ProjectNova\doctor.off exists (the Settings switch).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover } from './context.mjs';
import { RULES } from '../rules/signatures.mjs';
import { parseLine, readHeader, BAD_VERBOSITY, SUBSYSTEMS } from './ue4log.mjs';
import { redact } from './finding.mjs';
import { buildUpload, scrubHost } from './upload.mjs';

export const LIMITS = {
  TICK_MS: 10_000,              // how often appended bytes are read
  FLUSH_MS: 15_000,             // how often queued lines go to the agent
  MAX_QUEUE: 1000,              // lines held locally; oldest dropped (and counted) beyond this
  MAX_BYTES_PER_TICK: 1 << 20,  // per file per tick; a burst beyond it is skipped and counted
  MAX_LINE: 300,                // characters kept per line
  BATCH: 200,                   // lines per POST
  SCAN_COOLDOWN_MS: 10 * 60_000,
  FIRST_SCAN_DELAY_MS: 90_000,
  ACTIVE_WINDOW_MS: 30_000,     // the client log written this recently = a game is running
  IDLE_AFTER_MS: 90_000,        // ...and this long without a write = the session is over
};

const BENIGN = new Set(['not-ours', 'known-benign']);
const rulesByKind = new Map();
function rulesFor(kind) {
  if (!rulesByKind.has(kind)) rulesByKind.set(kind, RULES.filter(r => r.sources.some(s => s === kind || (s === 'ue4' && kind.startsWith('ue4:')))));
  return rulesByKind.get(kind);
}

/**
 * Is this line worth sending? Returns { sev, rule, status } or null. A line a benign or not-ours rule
 * explains is dropped here — it is exactly the noise the catalog exists to recognise.
 */
export function classifyLine(kind, line) {
  for (const r of rulesFor(kind)) {
    const m = r.re.exec(line);
    if (!m || (r.skipIf && r.skipIf(m))) continue;
    const extra = r.classify ? r.classify(m) : {};
    const status = extra.status ?? (r.status === 'proof' ? 'proof' : r.status ?? 'open');
    if (BENIGN.has(status)) return null;
    return { sev: extra.severity ?? r.severity, rule: r.id, status };
  }
  if (kind.startsWith('ue4:')) {
    const p = parseLine(line);
    if (!p || !BAD_VERBOSITY.includes(p.verbosity)) return null;
    if (p.verbosity === 'Warning' && !Object.prototype.hasOwnProperty.call(SUBSYSTEMS, p.category)) return null;
    return { sev: p.verbosity === 'Fatal' ? 'P1' : 'P3', rule: null, status: 'open' };
  }
  if (/\[(Exception|Crash)\]|\bERROR\b|\bFAILED\b|\bMISSING\b/.test(line)) return { sev: 'P3', rule: null, status: 'open' };
  return null;
}

/** Follows one file by byte offset. Starts at the END: history belongs to the full report. */
export class Tail {
  constructor(file, kind) {
    this.file = file; this.kind = kind; this.baseKind = kind;
    this.offset = -1; this.ino = null; this.partial = ''; this.skipped = 0;
  }

  #readHead() {
    if (!this.baseKind.startsWith('ue4:')) return;
    try {
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      this.kind = readHeader(buf.subarray(0, n).toString('utf8')).source === 'HOST' ? 'ue4:host' : 'ue4:client';
    } catch { /* keep the guess from the file name */ }
  }

  /** Lines appended since the last call (without the trailing partial line). */
  read() {
    let st;
    try { st = fs.statSync(this.file); } catch { return []; }
    if (this.offset < 0) { this.offset = st.size; this.ino = st.ino; this.#readHead(); return []; }
    // UE4 rotates by renaming the old log and starting a new file: a new inode, or a shorter file.
    if (st.ino !== this.ino || st.size < this.offset) { this.offset = 0; this.ino = st.ino; this.partial = ''; this.#readHead(); }
    if (st.size === this.offset) return [];
    let start = this.offset;
    if (st.size - start > LIMITS.MAX_BYTES_PER_TICK) { this.skipped += st.size - LIMITS.MAX_BYTES_PER_TICK - start; start = st.size - LIMITS.MAX_BYTES_PER_TICK; this.partial = ''; }
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    try {
      const fd = fs.openSync(this.file, 'r');
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
    } catch { return []; }
    this.offset = st.size;
    const NUL = String.fromCharCode(0);
    const lines = (this.partial + buf.toString('utf8').split(NUL).join('')).split(/\r?\n/);
    this.partial = lines.pop() ?? '';
    return lines;
  }
}

export async function liveCommand(opts, scan) {
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
  // End-to-end tests only: the same code on a seconds-scale clock. Never set by the launcher.
  if (process.env.NOVA_DOCTOR_FAST === '1') {
    Object.assign(LIMITS, { TICK_MS: 1000, FLUSH_MS: 2000, FIRST_SCAN_DELAY_MS: 3000, SCAN_COOLDOWN_MS: 5000, ACTIVE_WINDOW_MS: 3000, IDLE_AFTER_MS: 6000 });
  }
  const ctx = discover(opts);
  const agent = (opts.agent || process.env.NOVA_DOCTOR_AGENT || 'http://127.0.0.1:3552').replace(/\/+$/, '');
  const outDir = opts.out || path.join(ctx.paths.novaState, 'Doctor');
  const offMarker = path.join(ctx.paths.novaState, 'doctor.off');
  const sharing = () => !fs.existsSync(offMarker);
  const clientLog = path.join(ctx.paths.ue4Logs, 'FortniteGame.log');

  const tails = [
    new Tail(clientLog, 'ue4:client'),
    new Tail(path.join(ctx.paths.ue4Logs, 'FortniteGame_2.log'), 'ue4:host'),
    new Tail(ctx.paths.cobaltLog, 'cobalt'),
    new Tail(ctx.paths.agentLog, 'agent'),
  ];
  const SRC = { 'ue4:client': 'client', 'ue4:host': 'server', cobalt: 'cobalt', agent: 'agent' };
  let queue = [];
  let dropped = 0;
  let lastScan = 0, scanning = false, wasActive = false;
  const startedAt = Date.now();
  let quietFailures = 0;

  async function post(route, body) {
    try {
      const r = await fetch(`${agent}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
      if (r.ok) { quietFailures = 0; return true; }
    } catch { /* agent not up yet — normal at launcher start */ }
    if (++quietFailures === 1 || quietFailures % 40 === 0) console.log(`[doctor-live] agent ${agent} not accepting (${quietFailures} attempt(s))`);
    return false;
  }

  function tick() {
    for (const t of tails) {
      for (const raw of t.read()) {
        if (!raw.trim()) continue;
        const c = classifyLine(t.kind, raw);
        if (!c) continue;
        const p = t.kind.startsWith('ue4:') ? parseLine(raw) : null;
        queue.push({
          src: SRC[t.kind] || t.kind, sev: c.sev, rule: c.rule, status: c.status,
          t: p?.stamp ?? (/^(\d\d:\d\d:\d\d(?:\.\d+)?)/.exec(raw)?.[1] ?? null),
          text: scrubHost(redact(raw.trim())).slice(0, LIMITS.MAX_LINE),
        });
      }
      if (t.skipped) { dropped += Math.ceil(t.skipped / 200); t.skipped = 0; }   // ~200 bytes a line
    }
    if (queue.length > LIMITS.MAX_QUEUE) { dropped += queue.length - LIMITS.MAX_QUEUE; queue = queue.slice(-LIMITS.MAX_QUEUE); }

    // Game activity, read from the client log's write time — a stat, not a process listing.
    let mtime = 0;
    try { mtime = fs.statSync(clientLog).mtimeMs; } catch { /* no game yet */ }
    const now = Date.now();
    const active = mtime && now - mtime < LIMITS.ACTIVE_WINDOW_MS;
    const sessionOver = wasActive && mtime && now - mtime > LIMITS.IDLE_AFTER_MS;
    if (active) wasActive = true;
    const firstScanDue = !lastScan && now - startedAt > LIMITS.FIRST_SCAN_DELAY_MS && !active;
    if ((sessionOver || firstScanDue) && now - lastScan > LIMITS.SCAN_COOLDOWN_MS) {
      // The first scan waits for an idle game, so if a session ran before it, it IS the
      // session-end scan — say so, rather than calling it start-up.
      const why = sessionOver || wasActive ? 'game session ended' : 'start-up';
      wasActive = false;
      void fullScan(why);
    }
  }

  async function flush() {
    if (!sharing()) { queue = []; dropped = 0; return; }
    while (queue.length) {
      const batch = queue.slice(0, LIMITS.BATCH);
      if (!(await post('/nova/api/doctor/local', { lines: batch, dropped }))) return;   // keep for next time
      queue = queue.slice(batch.length);
      dropped = 0;
    }
  }

  async function fullScan(why) {
    if (scanning) return;
    scanning = true;
    const t0 = Date.now();
    try {
      const report = await scan({ ...opts, command: 'scan', profile: 'player', quiet: true, only: null, skip: [], out: outDir, build: false, remote: false });
      const payload = buildUpload(report);
      const sent = sharing() ? await post('/nova/api/doctor/local-report', payload) : false;
      console.log(`[doctor-live] scan (${why}) ${Date.now() - t0} ms: ${report.summary.open} open; ${sharing() ? (sent ? `sent ${payload.full ? payload.fullBytes + ' B gzipped' : 'summary only'}` : 'agent unavailable') : 'sharing is off'}`);
    } catch (e) {
      console.log(`[doctor-live] scan failed: ${e?.message || e}`);
    } finally {
      lastScan = Date.now();
      scanning = false;
    }
  }

  console.log(`[doctor-live] started (agent ${agent}, sharing ${sharing() ? 'on' : 'off'}, pid ${process.pid})`);
  tick();                                           // establishes end-of-file offsets
  setInterval(tick, LIMITS.TICK_MS);
  setInterval(() => { void flush(); }, LIMITS.FLUSH_MS);
  if (opts.parent) {
    setInterval(() => {
      try { process.kill(opts.parent, 0); } catch { console.log('[doctor-live] launcher exited — stopping'); process.exit(0); }
    }, 30_000);
  }
  return new Promise(() => {});
}
