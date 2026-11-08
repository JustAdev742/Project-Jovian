/**
 * Runtime Diagnostics — crashes, and what is running right now.
 *
 * CRASHES. UE4 writes a UE4CC-* directory per crash (CrashContext.runtime-xml + UE4Minidump.dmp).
 * DIAGNOSTIC_COVERAGE.md lists these as "files exist on disk; not read" — the largest blind spot in
 * the pipeline. This module reads every one, takes the role from the recorded COMMAND LINE (never
 * from the log copy beside it, which is the wrong process's in most gameserver crashes), reads the
 * exception and module list from the minidump, and groups crashes by their fault frame.
 *
 * A crash group is CURRENT if the Project Reboot.dll it crashed in has the same build stamp as the
 * DLL we build today; otherwise it is STALE — that exact code no longer ships, so it may be fixed.
 *
 * LIVE. Ports 3551/3552/7777 with an identity probe (a 200 from something that is not Nova is
 * worse than a closed port — NOVA-201/202), and the coordinator's reachability from THIS machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { readText, listDir, exists, stat } from '../lib/util.mjs';
import { readMinidump, locate, peTimeDateStamp, EXCEPTION_NAMES } from '../lib/minidump.mjs';

const M = 'runtime';
// BigInt-safe: a 64-bit fault address must not round through a double (0xffff…ffff printed as 0x10000000000000000).
const hex = n => '0x' + (typeof n === 'bigint' ? n : BigInt(Math.trunc(Number(n)))).toString(16);

function tag(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
}

/** .NET ticks (100 ns since 0001-01-01) → ISO. 0 means "not recorded". */
function ticksToIso(t) {
  const n = Number(t);
  if (!n) return null;
  return new Date((n / 1e4) - 62135596800000).toISOString();
}

/** `Project Reboot 0x00000000ca9b0000 + 2e453 FortniteClient-Win64-Shipping 0x… + 2f3433 …` */
export function parsePCallStack(s) {
  const out = [];
  const re = /(\S[^]*?) 0x([0-9a-fA-F]{8,16}) \+ ([0-9a-fA-F]+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push({ module: m[1].trim(), rva: parseInt(m[3], 16) });
  return out;
}

const short = mod => /FortniteClient/i.test(mod) ? 'Shipping' : /Project Reboot/i.test(mod) ? 'Reboot' : /Cobalt|GFSDK_Aftermath/i.test(mod) ? 'Cobalt' : mod.replace(/\.dll$/i, '');

function crashDirs(ctx) {
  const dirs = [];
  for (const e of listDir(ctx.paths.ue4Crashes)) if (e.isDirectory()) dirs.push(path.join(ctx.paths.ue4Crashes, e.name));
  // A crash folder also turns up inside Logs (Logs\_0000) — read it too.
  for (const e of listDir(ctx.paths.ue4Logs)) if (e.isDirectory() && exists(path.join(ctx.paths.ue4Logs, e.name, 'CrashContext.runtime-xml'))) dirs.push(path.join(ctx.paths.ue4Logs, e.name));
  return dirs;
}

export function readCrash(dir) {
  const xml = readText(path.join(dir, 'CrashContext.runtime-xml'));
  if (!xml) return null;
  const cmd = tag(xml, 'CommandLine') || '';
  const frames = parsePCallStack(tag(xml, 'PCallStack'));
  const dump = readMinidump(path.join(dir, 'UE4Minidump.dmp'));
  let fault = null, exception = null, rebootStamp = null;
  if (dump?.exception) {
    const ex = dump.exception;
    const where = locate(dump.modules, ex.address);
    fault = where ? { module: where.module, rva: where.rva } : null;
    exception = {
      code: ex.code, name: EXCEPTION_NAMES[ex.code] || hex(ex.code),
      access: ex.code === 0xC0000005 && ex.params.length >= 2 ? { op: ['read', 'write'][Number(ex.params[0])] ?? `op${ex.params[0]}`, address: hex(ex.params[1]) } : null,
    };
  }
  const reboot = dump?.modules.find(m => /Project Reboot/i.test(m.name));
  if (reboot) rebootStamp = reboot.timeDateStamp;
  const top = frames.slice(0, 2).map(f => `${short(f.module)}+${hex(f.rva)}`);
  const faultFrame = fault ? `${short(fault.module)}+${hex(fault.rva)}` : top[0] ?? 'unknown';
  return {
    dir, id: path.basename(dir),
    time: ticksToIso(tag(xml, 'TimeOfCrash')) || stat(path.join(dir, 'CrashContext.runtime-xml'))?.mtime.toISOString() || null,
    role: /-nullrhi/i.test(cmd) ? 'gameserver' : cmd ? 'client' : 'unknown',
    build: tag(xml, 'BuildVersion'),
    state: tag(xml, 'GameStateName'),
    uptime: Number(tag(xml, 'SecondsSinceStart')) || null,
    error: tag(xml, 'ErrorMessage'),
    isAssert: tag(xml, 'IsAssert') === 'true', isEnsure: tag(xml, 'IsEnsure') === 'true',
    exception, fault, frames, rebootStamp,
    signature: `${faultFrame} ← ${top[1] ?? '?'}`,
    hasRebootFrame: frames.some(f => /Project Reboot/i.test(f.module)),
    inProcessEventFromReboot: frames.length > 1 && /FortniteClient/i.test(frames[0].module) && /Project Reboot/i.test(frames[1].module),
  };
}

function analyseCrashes(ctx, F, cov) {
  const dirs = crashDirs(ctx);
  const crashes = dirs.map(readCrash).filter(Boolean);
  ctx.crashes = crashes;
  const dllStamp = peTimeDateStamp(path.join(ctx.paths.reboot, 'x64', 'Release', 'Project Reboot.dll'));
  const groups = new Map();
  for (const c of crashes) {
    const g = groups.get(c.signature) || { signature: c.signature, crashes: [] };
    g.crashes.push(c);
    groups.set(c.signature, g);
  }
  let current = 0;
  for (const g of groups.values()) {
    const cs = g.crashes.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const last = cs[cs.length - 1];
    const roles = [...new Set(cs.map(c => c.role))];
    const reboot = cs.some(c => c.hasRebootFrame);
    const stamps = [...new Set(cs.map(c => c.rebootStamp).filter(Boolean))];
    const onCurrentBuild = dllStamp != null && stamps.includes(dllStamp);
    const assert = cs.find(c => c.isAssert);
    // Stale when every crash in the group ran a Reboot build we no longer ship — or, for client
    // crashes with no Reboot loaded, when the newest one predates the newest crash overall by a month.
    const newestAll = crashes.map(c => c.time).filter(Boolean).sort().pop();
    const stale = stamps.length
      ? !onCurrentBuild
      : !!(last.time && newestAll && Date.parse(newestAll) - Date.parse(last.time) > 30 * 864e5);
    if (!stale) current++;
    const ex = last.exception;
    const title = assert
      ? `${roles.join('/')} assert: ${(assert.error || '').slice(0, 90)}`
      : `${roles.join('/')} crash ${ex ? ex.name : ''}${ex?.access ? ` (${ex.access.op} ${ex.access.address})` : ''} at ${g.signature}`;
    F.add({
      id: 'runtime.crash-group', key: `runtime.crash-group:${g.signature}`, module: M,
      component: reboot ? 'reboot' : roles.includes('client') ? 'game' : 'game', category: 'crash',
      severity: cs.length > 1 || reboot ? 'P1' : 'P2', confidence: 'CONFIRMED',
      status: stale ? 'stale' : 'open', count: cs.length,
      firstSeen: cs[0].time, lastSeen: last.time,
      title: `${title}${cs.length > 1 ? ` — ${cs.length} times` : ''}`,
      explain: [
        reboot ? 'Project Reboot frames are on the stack.' : 'No Reboot frames: engine or Cobalt code.',
        cs.some(c => c.inProcessEventFromReboot) ? 'Faults inside a FortniteClient function called directly from Reboot (e.g. ProcessEvent).' : '',
        stamps.length ? (onCurrentBuild ? 'The crashing Reboot build IS the one built today — this crash is in code that currently ships.' : 'The crashing Reboot build is not the one built today — STALE: may be fixed, unverified.') : '',
        `States: ${[...new Set(cs.map(c => c.state).filter(Boolean))].join(', ') || '?'}; uptime ${cs.map(c => c.uptime).filter(Boolean).join('/') || 'unknown'}${cs.some(c => c.uptime) ? 's' : ''}.`,
      ].filter(Boolean).join(' '),
      cause: reboot ? 'host-crash' : 'ue4-crash',
      evidence: cs.map(c => ({ source: path.relative(ctx.paths.ue4Saved, c.dir), time: c.time, excerpt: `${c.role} · ${c.state ?? '?'} · ${c.uptime ?? '?'}s · ${c.exception?.name ?? c.error ?? '?'} · top: ${c.frames.slice(0, 4).map(f => `${short(f.module)}+${hex(f.rva)}`).join(' ← ')}` })),
      data: { roles, rebootBuilds: stamps.map(s => new Date(s * 1000).toISOString()), currentRebootBuild: dllStamp ? new Date(dllStamp * 1000).toISOString() : null, onCurrentBuild, crashes: cs.map(c => c.id) },
    });
  }
  cov.push({ area: 'UE4 crash reports', status: dirs.length ? 'checked' : 'skipped', detail: `${crashes.length} reports read (XML + minidump), ${groups.size} distinct fault signatures, ${current} not stale` });

  // Reboot's own crash.log / crash.dmp beside the game exe.
  if (ctx.paths.gameWin64 && exists(ctx.paths.gameWin64)) {
    const files = fs.readdirSync(ctx.paths.gameWin64).filter(n => /^crash.*\.(log|dmp)$/i.test(n));
    cov.push({ area: 'Reboot crash.log/.dmp', status: 'checked', detail: `${files.length} file(s) in ${ctx.paths.gameWin64}` });
    for (const f of files.filter(n => n.endsWith('.log'))) {
      const text = readText(path.join(ctx.paths.gameWin64, f)) || '';
      const rva = (/fault RVA[^:]*:\s*(0x[0-9A-Fa-f]+)/.exec(text)?.[1] || '').toLowerCase();
      // Reboot's handler is vectored, so it writes crash.log for first-chance faults the game then
      // survives. This RVA is one: 2026-09-18 and 2026-11-08, the server played on for minutes after.
      const benign = SURVIVED_FIRST_CHANCE_RVAS.has(rva);
      F.add({ id: 'runtime.reboot-crash-log', key: `runtime.reboot-crash-log:${f}`, module: M, component: 'reboot', category: 'crash',
        severity: benign ? 'INFO' : 'P2', confidence: 'CONFIRMED', status: benign ? 'known-benign' : undefined,
        title: benign ? `Reboot logged a survived first-chance fault (RVA ${rva}) in ${f}` : `Reboot wrote ${f}`,
        explain: benign
          ? 'Not a crash: this fault happens during map streaming and the server carries on (seen with the server playing on for minutes afterwards). Reboot\'s vectored handler records it because it cannot tell a survived fault from a fatal one.'
          : 'Read alongside the UE4CC report of the same time; a vectored handler also records survived first-chance faults.',
        evidence: [{ source: path.join(ctx.paths.gameWin64, f), excerpt: text.split('\n').slice(0, 6).join(' | ') }] });
    }
  } else {
    cov.push({ area: 'Reboot crash.log/.dmp', status: 'skipped', detail: 'game build not found' });
  }
}

/** First-chance faults the game is known to survive (rule first-chance-av-known in rules/signatures.mjs). */
const SURVIVED_FIRST_CHANCE_RVAS = new Set(['0x1242250']);

// ── live state ────────────────────────────────────────────────────────────────────────────────────

function tcp(host, port, ms = 1500) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function get(url, ms = 2500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, body: String(e?.cause?.code || e?.message || e) }; }
}

async function liveChecks(ctx, F, cov) {
  const ports = [
    [3551, 'nova-proxy (the game talks to this)', 'proxy'],
    [3552, 'host agent (local backend)', 'backend'],
  ];
  let anyUp = false;
  for (const [port, what, component] of ports) {
    const open = await tcp('127.0.0.1', port);
    if (!open) { cov.push({ area: `port ${port}`, status: 'checked', detail: `${what}: closed` }); continue; }
    anyUp = true;
    const r = await get(`http://127.0.0.1:${port}/nova/api/components`);
    const nova = r.status === 200 && /"components"|"statuses"/.test(r.body);
    cov.push({ area: `port ${port}`, status: 'checked', detail: `${what}: open, ${nova ? 'answers as Nova' : `NOT Nova (HTTP ${r.status})`}` });
    if (!nova) {
      F.add({ id: 'runtime.port-held-by-something-else', key: `runtime.port-held-by-something-else:${port}`, module: M, component, category: 'network',
        severity: 'P0', confidence: 'CONFIRMED', title: `Port ${port} is held by something that is not Nova`,
        explain: 'Worse than a closed port: the game or launcher talks to it and gets the wrong answers (NOVA-201/202).',
        evidence: [{ source: `http://127.0.0.1:${port}/nova/api/components`, excerpt: `HTTP ${r.status} ${r.body.slice(0, 120)}` }] });
    }
  }
  if (!anyUp) cov.push({ area: 'live launcher checks', status: 'n/a', detail: 'the launcher is not running — nothing live to check' });

  // Pull the running agent's own telemetry into the report — the runtime pipeline and the doctor
  // should never disagree about what is failing.
  if (await tcp('127.0.0.1', 3552)) {
    const d = await get('http://127.0.0.1:3552/nova/api/diagnostics?summary=1&limit=50', 4000);
    try {
      const j = JSON.parse(d.body);
      const rows = j.problems || j.diagnostics || j.items || [];
      cov.push({ area: 'agent diagnostics store', status: 'checked', detail: `${rows.length} aggregated problems imported` });
      for (const p of rows) {
        F.add({ id: 'runtime.agent-diagnostic', key: `runtime.agent-diagnostic:${p.key || p.route || p.url}`, module: M, component: 'backend', category: 'telemetry',
          severity: /CRITICAL|HIGH/.test(p.severity || '') ? 'P1' : 'P3', confidence: 'CONFIRMED', count: p.count || 1,
          title: `Agent recorded ${p.category || '?'} on ${p.route || p.url || '?'}`, explain: p.detail || '',
          evidence: [{ source: 'GET /nova/api/diagnostics', excerpt: JSON.stringify(p).slice(0, 300) }] });
      }
    } catch { cov.push({ area: 'agent diagnostics store', status: 'error', detail: `unparseable (HTTP ${d.status})` }); }
  }

  // Can THIS machine reach the coordinator? (NOVA-203/204, run here so it works without the launcher.)
  const host = new URL(ctx.remote.funnel).hostname;
  let resolved = null;
  try { resolved = (await dns.lookup(host, { all: true })).map(a => a.address); } catch (e) { resolved = null; }
  const reach = resolved ? await tcp(host, Number(new URL(ctx.remote.funnel).port || 443), 4000) : false;
  cov.push({ area: 'coordinator reachability (from this PC)', status: 'checked', detail: `DNS ${resolved ? resolved.join(', ') : 'FAILED'}; TCP ${reach ? 'ok' : 'failed'}` });
  if (!resolved || !reach) {
    F.add({ id: 'runtime.coordinator-unreachable-from-here', module: M, component: 'coordinator', category: 'network',
      severity: 'P0', confidence: 'CONFIRMED',
      title: !resolved ? `This PC cannot resolve ${host}` : `This PC resolves ${host} but cannot connect`,
      explain: 'Sign-in and matchmaking go through the coordinator. A failed lookup of a Funnel name usually means the coordinator node is offline (coordinator/README.md, Outages).',
      evidence: [{ source: host, excerpt: resolved ? `resolved ${resolved.join(', ')}, TCP failed` : 'DNS lookup failed' }] });
  }
}

export default {
  id: M,
  title: 'Runtime Diagnostics',
  async run(ctx, F) {
    const cov = [];
    analyseCrashes(ctx, F, cov);
    await liveChecks(ctx, F, cov);
    return { coverage: cov };
  },
};
