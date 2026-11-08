/**
 * Asset & install inspector — the files the game and Nova depend on at runtime, and whether each is
 * what it should be.
 *
 * Nova authors no Unreal content: the game's assets are Epic's, cooked and AES-encrypted in paks. So
 * "unused assets", redirectors, circular references and cooking failures have no subject here and
 * are reported as not applicable, with the reason. What CAN break — and has — is checked:
 *
 *   - the local Engine.ini patch (the XMPP endpoint and peer verification)
 *   - the served cloudstorage hotfix, which OUTRANKS every local config (port 80, months of
 *     "Fortnite was not started correctly")
 *   - the sliver-window GameUserSettings left behind by a -nullrhi server
 *   - the bumper files the game actually reads
 *   - the game build: paks present and their footers intact (two crash reports on this PC are pak
 *     corruption), and the Aftermath slot holding the current Cobalt
 */
import fs from 'node:fs';
import path from 'node:path';
import { readText, exists, md5, stat, run } from '../lib/util.mjs';

const M = 'assets';

function engineIni(ctx, F, cov) {
  const p = path.join(ctx.paths.ue4Config, 'Engine.ini');
  const t = readText(p);
  if (t == null) { cov.push({ area: 'local Engine.ini patch', status: 'skipped', detail: `${p} not found (written by the launcher at each launch)` }); return; }
  const xmpp = /ServerAddr="ws:\/\/127\.0\.0\.1:3551"/.test(t) && /ServerPort=3551/.test(t);
  const verify = /n\.VerifyPeer=false/i.test(t);
  const wrongPort = [...t.matchAll(/ServerPort=(\d+)/g)].map(m => m[1]).filter(v => v !== '3551');
  cov.push({ area: 'local Engine.ini patch', status: 'checked', detail: `XMPP→3551 ${xmpp ? 'yes' : 'NO'}, VerifyPeer=false ${verify ? 'yes' : 'NO'}${wrongPort.length ? `, other ServerPort values ${wrongPort.join(',')}` : ''}` });
  if (!xmpp || !verify || wrongPort.length) {
    F.add({ id: 'assets.engine-ini-not-patched', module: M, component: 'launcher', category: 'config',
      severity: 'P2', confidence: 'CONFIRMED', title: 'The local Engine.ini does not carry Nova\'s patch',
      explain: 'patch_local_engine_ini (carter.rs) writes it on every launch, so a missing patch means the last launch failed to write it or something reset it. Note the served cloudstorage hotfix outranks this file anyway.',
      evidence: [{ source: p, excerpt: `XMPP→3551=${xmpp} VerifyPeer=false=${verify} otherPorts=${wrongPort.join(',') || 'none'}` }] });
  }
}

function tinyWindow(ctx, F, cov) {
  const p = path.join(ctx.paths.ue4Config, 'GameUserSettings.ini');
  const t = readText(p);
  if (t == null) { cov.push({ area: 'GameUserSettings resolution', status: 'skipped', detail: 'file not found' }); return; }
  const x = Number(/ResolutionSizeX=(\d+)/.exec(t)?.[1]), y = Number(/ResolutionSizeY=(\d+)/.exec(t)?.[1]);
  cov.push({ area: 'GameUserSettings resolution', status: 'checked', detail: `${x}x${y}` });
  if (x && y && (x < 640 || y < 480)) {
    F.add({ id: 'assets.sliver-window', module: M, component: 'launcher', category: 'config',
      severity: 'P3', confidence: 'CONFIRMED', title: `GameUserSettings.ini holds a ${x}x${y} resolution (left by a -nullrhi server)`,
      explain: 'The headless server shares this file and saves its null render size on exit. repair_client_display_settings (carter.rs) fixes it on the next CLIENT launch.',
      evidence: [{ source: p, excerpt: `ResolutionSizeX=${x} ResolutionSizeY=${y}` }],
      fix: { summary: 'Launch the client from the launcher, or apply the repair.', repairId: 'fix-sliver-window' } });
  }
}

function bumperFiles(ctx, F, cov) {
  // The game reads the copies staged into %LOCALAPPDATA%\ProjectNova on every launch (bumper.rs).
  const off = exists(path.join(ctx.paths.novaState, 'bumper.off'));
  const diffs = [];
  for (const f of ['bumper.mp4', 'bumper.wav']) {
    const staged = path.join(ctx.paths.novaState, f), shipped = path.join(ctx.paths.installedResources, f);
    if (!exists(shipped)) continue;
    if (!exists(staged)) diffs.push(`${f} not staged`);
    else if (md5(staged) !== md5(shipped)) diffs.push(`${f} differs from the installed copy`);
  }
  cov.push({ area: 'bumper files', status: 'checked', detail: `${off ? 'switched OFF (bumper.off present)' : 'on'}; ${diffs.length ? diffs.join('; ') : 'staged copies match'}` });
  if (diffs.length) {
    F.add({ id: 'assets.bumper-files-stale', module: M, component: 'launcher', category: 'install', severity: 'P3', confidence: 'CONFIRMED',
      title: 'The bumper files the game reads differ from the installed ones', explain: 'bumper.rs re-stages them on every launch, so this clears at the next launch.',
      evidence: diffs.map(d => ({ source: ctx.paths.novaState, excerpt: d })) });
  }
}

function gameBuild(ctx, F, cov) {
  if (!ctx.paths.game) {
    cov.push({ area: 'game paks', status: 'skipped', detail: 'game build not found' });
    cov.push({ area: 'Aftermath slot (installed Cobalt)', status: 'skipped', detail: 'game build not found' });
    return;
  }
  // Pak footers: the FPakInfo magic sits in the last bytes. A missing magic is exactly the
  // "Trailing magic number … is different than the expected one" fatal error (UE4CC Logs\_0000).
  const paks = exists(ctx.paths.gamePaks) ? fs.readdirSync(ctx.paths.gamePaks).filter(n => n.endsWith('.pak')) : [];
  const bad = [];
  for (const n of paks) {
    const p = path.join(ctx.paths.gamePaks, n);
    try {
      const size = fs.statSync(p).size;
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(Math.min(512, size));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      fs.closeSync(fd);
      if (buf.indexOf(Buffer.from([0xe1, 0x12, 0x6f, 0x5a])) < 0) bad.push(n);
    } catch { bad.push(n); }
  }
  cov.push({ area: 'game paks', status: 'checked', detail: `${paks.length} paks, ${bad.length} with a damaged footer` });
  for (const n of bad) {
    F.add({ id: 'assets.pak-footer-damaged', key: `assets.pak-footer-damaged:${n}`, module: M, component: 'game', category: 'install',
      severity: 'P0', confidence: 'CONFIRMED', title: `${n} has no valid pak footer — the game will refuse to mount it`,
      explain: 'Matches the "Trailing magic number" fatal error and the "Corrupted index in pak file" assert recorded on this PC. Re-copy the pak from a known-good build.',
      evidence: [{ source: path.join(ctx.paths.gamePaks, n), excerpt: 'FPakInfo magic 0x5A6F12E1 not found in the last 512 bytes' }] });
  }

  const slot = ctx.paths.aftermathSlot, built = path.join(ctx.paths.cobalt, 'x64', 'Release', 'Cobalt.dll');
  const shipped = path.join(ctx.paths.installedResources, 'Cobalt.dll');
  if (!exists(slot)) {
    cov.push({ area: 'Aftermath slot (installed Cobalt)', status: 'checked', detail: 'empty — the launcher copies Cobalt in at launch' });
    return;
  }
  const h = md5(slot);
  const match = [md5(shipped), md5(built)].includes(h);
  cov.push({ area: 'Aftermath slot (installed Cobalt)', status: 'checked', detail: `${stat(slot).size} bytes, ${match ? 'matches a known Cobalt build' : 'matches NO current Cobalt'}` });
  if (!match) {
    F.add({ id: 'assets.aftermath-slot-stale', module: M, component: 'cobalt', category: 'install', severity: 'P2', confidence: 'CONFIRMED',
      title: 'The game\'s Aftermath slot holds a Cobalt that matches neither the installed nor the built one',
      explain: 'dll_replace (carter.rs) copies Cobalt over GFSDK_Aftermath_Lib.x64.dll at launch; a mismatch now means the last launch used another launcher, or the original NVIDIA DLL is back.',
      evidence: [{ source: slot, excerpt: `md5 ${h}` }] });
  }
}

function remoteHotfix(ctx, F, cov) {
  // The cloudstorage DefaultEngine.ini is applied ON TOP of every local config. Check it first.
  const r = run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-i', ctx.remote.key, ctx.remote.host,
    `cat ${ctx.remote.dir}/data/cloudstorage/DefaultEngine.ini 2>/dev/null || echo __MISSING__`]);
  if (!r.ok) { cov.push({ area: 'served cloudstorage hotfix', status: 'error', detail: r.stderr.trim().slice(0, 120) }); return; }
  const t = r.stdout;
  if (t.includes('__MISSING__')) { cov.push({ area: 'served cloudstorage hotfix', status: 'checked', detail: 'no DefaultEngine.ini on the coordinator (generated on demand)' }); return; }
  const ports = [...t.matchAll(/ServerPort\s*=\s*(\d+)/g)].map(m => m[1]);
  const addrs = [...t.matchAll(/ServerAddr\s*=\s*"?([^"\s]+)"?/g)].map(m => m[1]);
  const bad = ports.filter(p => p !== '3551').concat(addrs.filter(a => /:(\d+)/.exec(a)?.[1] && /:(\d+)/.exec(a)[1] !== '3551'));
  cov.push({ area: 'served cloudstorage hotfix', status: 'checked', detail: `${t.length} bytes; ServerPort ${ports.join(',') || 'none'}; ServerAddr ${addrs.join(',') || 'none'}` });
  if (bad.length) {
    F.add({ id: 'assets.hotfix-xmpp-wrong-port', module: M, component: 'coordinator', category: 'config', severity: 'P0', confidence: 'CONFIRMED',
      title: 'The coordinator\'s cloudstorage hotfix points XMPP at a port other than 3551',
      explain: 'This file outranks every local config. Port 80 here caused months of "Fortnite was not started correctly". Edits take effect immediately — no restart.',
      evidence: [{ source: 'coordinator:data/cloudstorage/DefaultEngine.ini', excerpt: bad.join(', ') }] });
  }
}

export default {
  id: M,
  title: 'Asset & install inspector',
  async run(ctx, F, opts) {
    const cov = [];
    engineIni(ctx, F, cov);
    tinyWindow(ctx, F, cov);
    bumperFiles(ctx, F, cov);
    gameBuild(ctx, F, cov);
    if (opts.remote) remoteHotfix(ctx, F, cov);
    else cov.push({ area: 'served cloudstorage hotfix', status: 'skipped', detail: 'pass --remote' });
    for (const area of ['redirectors', 'circular asset references', 'unused assets', 'cooking / packaging']) {
      cov.push({ area, status: 'n/a', detail: 'Nova authors no Unreal content — the game\'s assets are Epic\'s, cooked and encrypted; there is no editor project to inspect' });
    }
    return { coverage: cov };
  },
};
