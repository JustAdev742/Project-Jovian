/**
 * Log Intelligence — read every line of every log Nova has, recognise known failures by signature,
 * and count everything else rather than dropping it.
 *
 * Sources: all UE4 logs (client and headless server, current and rotated), cobalt.log (Cobalt +
 * Reboot + the backend, client and host interleaved), nova-agent.log, launcher-startup.log, and
 * with --remote the coordinator's nova.log.
 *
 * Nothing is sampled. The only bounded thing is how many evidence lines a finding keeps; its count is
 * always the full count (lib/finding.mjs).
 */
import path from 'node:path';
import zlib from 'node:zlib';
import { RULES } from '../rules/signatures.mjs';
import { parseLine, normaliseMessage, readHeader, BAD_VERBOSITY, SUBSYSTEMS } from '../lib/ue4log.mjs';
import { ue4LogFiles } from '../lib/context.mjs';
import { readText, ue4Time, exists, run, stat, countNul } from '../lib/util.mjs';

/** NUL, built from a char code so this file stays plain ASCII (an escape here once became a literal NUL byte). */
const NUL_RE = new RegExp(String.fromCharCode(0), "g");

const M = 'logs';

/** Which rules apply to a source kind. `ue4` covers both `ue4:client` and `ue4:host`. */
function rulesFor(kind) {
  return RULES.filter(r => r.sources.some(s => s === kind || (s === 'ue4' && kind.startsWith('ue4:'))));
}

/**
 * Remember the most recent session each key appeared in. UE4 files are visited newest first, so a
 * smaller index is more recent; cobalt.log sessions are in file order, so a larger index is.
 */
function noteSeen(stats, key, ev) {
  const s = (stats.seen[key] ||= { kind: ev.kind, ue4Newest: Infinity, cobaltLatest: -1 });
  if (ev.kind?.startsWith('ue4:')) s.ue4Newest = Math.min(s.ue4Newest, ev.order);
  if (ev.kind === 'cobalt') s.cobaltLatest = Math.max(s.cobaltLatest, ev.order);
}

function applyRules(rules, line, ev, F, stats) {
  let matched = false;
  for (const r of rules) {
    const m = r.re.exec(line);
    if (!m) continue;
    if (r.skipIf && r.skipIf(m)) continue;
    matched = true;
    const extra = r.classify ? r.classify(m) : {};
    const status = extra.status ?? (r.status === 'proof' ? 'known-benign' : r.status ?? 'open');
    const disc = r.key ? r.key(m) : null;
    const key = `log.${r.id}${disc ? ':' + disc : ''}`;
    if (r.metric) {
      const v = r.metric(m);
      const s = (stats.metrics[key] ||= { n: 0, max: -Infinity, sum: 0 });
      s.n++; s.sum += v; if (v > s.max) s.max = v;
    }
    stats.ruleHits[r.id] = (stats.ruleHits[r.id] || 0) + 1;
    noteSeen(stats, key, ev);
    F.add({
      id: `log.${r.id}`, key, module: M,
      component: r.component, category: r.category,
      severity: extra.severity ?? r.severity, confidence: r.confidence, status,
      title: extra.title ?? r.title, explain: r.explain, cause: r.cause, kb: r.kb, fix: r.fix,
      firstSeen: ev.time, lastSeen: ev.time,
      evidence: [{ source: ev.source, line: ev.line, time: ev.time ?? ev.clock, excerpt: line.trim() }],
      data: r.status === 'proof' ? { proof: true, ...(disc ? { variant: disc } : {}) } : (disc ? { variant: disc } : null),
    });
  }
  return matched;
}

// ── UE4 logs ──────────────────────────────────────────────────────────────────────────────────────

function scanUe4(ctx, F, cov, stats) {
  const files = ue4LogFiles(ctx);
  ctx.ue4Sessions = [];
  const warningTally = {};
  const kindIndex = {};
  for (const file of files) {
    const text = readText(file);
    if (text == null) continue;
    const nul = (text.match(NUL_RE) || []).length;
    if (nul > text.length * 0.5) {
      F.add({
        id: 'log.ue4-log-torn', key: `log.ue4-log-torn:${path.basename(file)}`, module: M, component: 'environment', category: 'integrity',
        severity: 'P3', confidence: 'CONFIRMED',
        title: `${path.basename(file)} is entirely NUL bytes — that session's evidence is lost`,
        explain: 'A torn write (power loss or a hard kill while the file was open). Same signature as the nova-proxy corruption of 2026-09-19.',
        evidence: [{ source: file, excerpt: `${nul} of ${text.length} characters are NUL` }],
      });
      continue;
    }
    const header = readHeader(text);
    const kind = header.source === 'HOST' ? 'ue4:host' : 'ue4:client';
    const rules = rulesFor(kind);
    const name = path.basename(file);
    const order = (kindIndex[kind] = (kindIndex[kind] ?? -1) + 1);   // 0 = newest of its kind
    const sess = { file, name, kind, build: header.build, lines: 0, errors: 0, warnings: 0, fatals: 0, first: null, last: null, markers: {}, script: [] };
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw) continue;
      sess.lines++;
      const p = parseLine(raw);
      const time = p?.stamp ? ue4Time(p.stamp) : null;
      if (time) { if (!sess.first) sess.first = time; sess.last = time; }
      // Session milestones the Root Cause Analyzer reasons about.
      for (const mk of ['Join succeeded', 'EnterAircraft', 'ExitAircraft', 'Players may join now!', 'Ready to start match', 'World Inventory received', 'LevelActorCluster', 'OnLoggedIntoXmpp', 'PendingConnectionLost', 'PublishPartyInfoToPresence failure']) {
        if (raw.includes(mk)) { (sess.markers[mk] ||= { count: 0, first: time, last: time }).count++; sess.markers[mk].last = time; }
      }
      const ev = { source: name, line: i + 1, time, kind, order };
      const matched = applyRules(rules, raw, ev, F, stats);
      if (!p) continue;
      if (p.category === 'LogScript' && BAD_VERBOSITY.includes(p.verbosity)) sess.script.push({ line: i + 1, time, message: p.message });
      if (!BAD_VERBOSITY.includes(p.verbosity)) continue;
      if (p.verbosity === 'Fatal') sess.fatals++;
      else if (p.verbosity === 'Error') sess.errors++;
      else sess.warnings++;
      if (matched || p.category === 'LogScript') continue;   // LogScript belongs to the Blueprint inspector

      const owned = Object.prototype.hasOwnProperty.call(SUBSYSTEMS, p.category);
      if (p.verbosity === 'Warning' && !owned) {
        // Engine-noise warnings: tallied per category so nothing is hidden, reported as one row each.
        const t = (warningTally[p.category] ||= { count: 0, kinds: new Map() });
        t.count++;
        const k = normaliseMessage(p.message);
        t.kinds.set(k, (t.kinds.get(k) || 0) + 1);
        continue;
      }
      const norm = normaliseMessage(p.message);
      noteSeen(stats, `log.unclassified:${kind}:${p.category}:${p.verbosity}:${norm}`, ev);
      F.add({
        id: 'log.unclassified', key: `log.unclassified:${kind}:${p.category}:${p.verbosity}:${norm}`, module: M,
        component: kind === 'ue4:host' ? 'reboot' : 'game', category: 'unclassified',
        severity: p.verbosity === 'Fatal' ? 'P1' : 'P3', confidence: 'CONFIRMED',
        title: `${p.category} ${p.verbosity}: ${norm}`,
        explain: `Unclassified ${p.verbosity.toLowerCase()} from the ${kind === 'ue4:host' ? 'gameserver' : 'client'} — no catalog rule explains it yet.${owned ? ` ${p.category} is a Nova-owned category (${SUBSYSTEMS[p.category]}).` : ''}`,
        firstSeen: time, lastSeen: time,
        evidence: [{ source: name, line: i + 1, time, excerpt: raw.trim() }],
        data: { ue4Category: p.category, verbosity: p.verbosity, owned },
      });
    }
    ctx.ue4Sessions.push(sess);
  }

  for (const [cat, t] of Object.entries(warningTally)) {
    const top = [...t.kinds.entries()].sort((a, b) => b[1] - a[1]);
    F.add({
      id: 'log.engine-warnings', key: `log.engine-warnings:${cat}`, module: M, component: 'game', category: 'engine-warning',
      severity: 'INFO', confidence: 'CONFIRMED', status: 'not-ours', count: t.count,
      title: `${t.count} ${cat} warnings (${top.length} distinct) — engine category, not Nova-owned`,
      explain: 'Counted in full and listed in data; not individually reported, the same filter the launcher applies (ue4log.rs SUBSYSTEMS) so real errors are not buried.',
      data: { top: top.slice(0, 15).map(([m, n]) => ({ message: m, count: n })), distinct: top.length },
    });
  }
  const hosts = ctx.ue4Sessions.filter(s => s.kind === 'ue4:host').length;
  cov.push({ area: 'UE4 logs', status: files.length ? 'checked' : 'skipped', detail: `${files.length} files (${files.length - hosts} client, ${hosts} gameserver), ${ctx.ue4Sessions.reduce((a, s) => a + s.lines, 0)} lines, every line read` });
}

// ── Nova's own logs ───────────────────────────────────────────────────────────────────────────────

/** Split a log into sessions on a banner line; returns [{ start, lines: [{n, text}] }]. */
function sessions(text, banner) {
  const out = [];
  let cur = { start: null, lines: [] };
  text.split(/\r?\n/).forEach((t, i) => {
    if (banner.test(t)) { if (cur.lines.length || cur.start) out.push(cur); cur = { start: t.trim(), lines: [] }; }
    cur.lines.push({ n: i + 1, text: t });
  });
  out.push(cur);
  return out;
}

function scanNovaLog(ctx, F, cov, stats, { kind, file, banner, label }) {
  if (!exists(file)) { cov.push({ area: label, status: 'skipped', detail: `${file} not found` }); return null; }
  const text = readText(file) || '';
  const nul = countNul(file) || 0;
  const rules = rulesFor(kind);
  const sess = sessions(text, banner);
  let lines = 0;
  sess.forEach((s, order) => {
    for (const { n, text: t } of s.lines) {
      if (!t || !t.replace(/\0/g, '').trim()) continue;
      lines++;
      const clock = /^(\d\d:\d\d:\d\d(?:\.\d+)?)/.exec(t)?.[1] ?? null;
      applyRules(rules, t, { source: path.basename(file), line: n, time: null, clock, kind, order, session: s.start }, F, stats);
    }
  });
  if (nul > 0) {
    F.add({
      id: 'log.file-has-nul-runs', key: `log.file-has-nul-runs:${path.basename(file)}`, module: M,
      component: 'environment', category: 'integrity', severity: 'P3', confidence: 'CONFIRMED',
      title: `${path.basename(file)} contains ${nul} NUL bytes (torn writes from unclean shutdowns)`,
      explain: 'The same signature as the 2026-09-19 nova-proxy corruption. Harmless in a log; if it appears in code files too, suspect the drive.',
      evidence: [{ source: file, excerpt: `${nul} NUL bytes` }],
    });
  }
  cov.push({ area: label, status: 'checked', detail: `${sess.length} session(s), ${lines} lines, every line read${nul ? `, ${nul} NUL bytes` : ''}` });
  return { sessions: sess };
}

/** How often does each intermittent failure happen per session? Rates beat raw counts. */
function intermittency(ctx, F, cobalt) {
  if (!cobalt) return;
  let hostRuns = 0, misses = 0, rescued = 0;
  for (const s of cobalt.sessions) {
    const t = s.lines.map(l => l.text).join('\n');
    const ran = /ProcessEventAddress:|Unable to find ProcessEventAddress|ProcessEvent: our scan found nothing/.test(t);
    if (!ran) continue;
    hostRuns++;
    if (/Unable to find ProcessEventAddress/.test(t)) misses++;
    if (/ProcessEvent: our scan found nothing/.test(t)) rescued++;
  }
  ctx.intermittency = { processEvent: { hostRuns, aborted: misses, rescued } };
  for (const key of ['log.processevent-not-found', 'log.processevent-handoff-used']) {
    const f = F.get(key);
    if (f) f.data = { ...(f.data || {}), hostRuns, aborted: misses, rescuedByCobalt: rescued, missRate: hostRuns ? (misses + rescued) / hostRuns : null };
  }
}

async function scanCoordinatorLog(ctx, F, cov, stats) {
  const r = run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-i', ctx.remote.key, ctx.remote.host,
    `cd ${ctx.remote.dir} && gzip -c nova.log | base64 -w0`], { timeout: 180_000 });
  if (!r.ok) { cov.push({ area: 'coordinator nova.log', status: 'error', detail: r.stderr.trim().slice(0, 160) || r.error }); return; }
  const text = zlib.gunzipSync(Buffer.from(r.stdout.trim(), 'base64')).toString('utf8');
  const rules = rulesFor('coordinator');
  const lines = text.split(/\r?\n/);
  lines.forEach((t, i) => t && applyRules(rules, t, { source: 'coordinator:nova.log', line: i + 1, time: null }, F, stats));
  cov.push({ area: 'coordinator nova.log', status: 'checked', detail: `${lines.length} lines, every line read` });
}

/**
 * Separate current problems from history. cobalt.log reaches back to July, so without this the report
 * would be dominated by things fixed months ago. The word is "stale", never "fixed": a session that
 * did not exercise the code path cannot show the error either way.
 */
function markStale(ctx, F, stats, cov) {
  // cobalt.log: sessions of the newest Cobalt build in the log, by the banner's build stamp.
  const builds = (ctx.cobaltSessions || []).map(s => /built (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(s.start || '')?.[1] ?? null);
  const newest = builds.filter(Boolean).sort().pop() ?? null;
  const firstNewest = newest ? builds.indexOf(newest) : -1;
  const newestCount = newest ? builds.filter(b => b === newest).length : 0;
  let stale = 0;
  for (const [key, s] of Object.entries(stats.seen)) {
    const f = F.get(key);
    if (!f || f.status !== 'open') continue;
    let why = null;
    if (s.cobaltLatest >= 0 && firstNewest >= 0 && s.cobaltLatest < firstNewest) {
      why = `not seen in the ${newestCount} cobalt.log session(s) of the newest Cobalt build (${newest})`;
    } else if (s.ue4Newest !== Infinity && s.ue4Newest >= 2) {
      why = `absent from the ${s.ue4Newest} most recent ${s.kind === 'ue4:host' ? 'gameserver' : 'client'} log(s)`;
    }
    if (why) {
      f.status = 'stale';
      f.data = { ...(f.data || {}), stale: why + ' — may be fixed, or that path was not exercised; unverified' };
      stale++;
    }
  }
  cov.push({ area: 'recency', status: 'checked', detail: `${stale} open findings marked stale; newest Cobalt build in the log: ${newest ?? 'unknown'} (${newestCount} sessions)` });
}

export default {
  id: M,
  title: 'Log Intelligence',
  async run(ctx, F, opts) {
    const cov = [];
    const stats = { ruleHits: {}, metrics: {}, seen: {} };
    scanUe4(ctx, F, cov, stats);
    const cobalt = scanNovaLog(ctx, F, cov, stats, { kind: 'cobalt', file: ctx.paths.cobaltLog, banner: /^==== Cobalt (?:[d.]+ )?starting/, label: 'cobalt.log' });
    scanNovaLog(ctx, F, cov, stats, { kind: 'agent', file: ctx.paths.agentLog, banner: /==== nova agent starting/, label: 'nova-agent.log' });
    scanNovaLog(ctx, F, cov, stats, { kind: 'agent', file: ctx.paths.agentLog + '.1', banner: /==== nova agent starting/, label: 'nova-agent.log.1' });
    scanNovaLog(ctx, F, cov, stats, { kind: 'startup', file: ctx.paths.startupLog, banner: /--- launcher start ---/, label: 'launcher-startup.log' });
    ctx.cobaltSessions = cobalt?.sessions ?? [];
    intermittency(ctx, F, cobalt);
    if (opts.remote) await scanCoordinatorLog(ctx, F, cov, stats);
    else cov.push({ area: 'coordinator nova.log', status: 'skipped', detail: 'pass --remote' });

    // Attach metrics (e.g. worst hitch) to their findings.
    for (const [key, s] of Object.entries(stats.metrics)) {
      const f = F.get(key);
      if (f) f.data = { ...(f.data || {}), metric: { n: s.n, max: s.max, mean: s.sum / s.n } };
    }
    markStale(ctx, F, stats, cov);
    ctx.ruleHits = stats.ruleHits;
    const unmatchedRules = RULES.filter(r => !stats.ruleHits[r.id]).map(r => r.id);
    cov.push({ area: 'signature catalog', status: 'checked', detail: `${RULES.length} rules, ${RULES.length - unmatchedRules.length} matched at least once` });
    return { coverage: cov };
  },
};
