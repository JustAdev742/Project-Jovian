/**
 * Project Scanner — what exists, which version of it, and whether the copy that RUNS is the copy
 * that was BUILT.
 *
 * That last question is the one this project keeps getting wrong. Three components have shipped a
 * stale copy while the fix sat in source (backend payload, Cobalt, Reboot — KNOWN_ISSUES
 * `reboot-dll-stale-beside-dev-exe`, `cobalt-dll-three-live-copies`, NOVA-AUDIT-013), and the
 * coordinator ran without the 1.9.0 region fix for seven weeks while the register said FIXED.
 */
import fs from 'node:fs';
import path from 'node:path';
import { exists, readText, md5, run, countNul, walk, stat, rel } from '../lib/util.mjs';

const M = 'scanner';

function json(p) { try { return JSON.parse(readText(p)); } catch { return null; } }

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function launcherVersions(ctx) {
  const tauri = json(path.join(ctx.paths.tauri, 'tauri.conf.json'));
  const pkg = json(path.join(ctx.paths.launcher, 'package.json'));
  const cargo = readText(path.join(ctx.paths.tauri, 'Cargo.toml')) || '';
  // RELEASING.md: Cargo.toml line 3, NOT the dependency table further down.
  const cargoV = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1] ?? null;
  return {
    'tauri.conf.json': tauri?.package?.version ?? tauri?.version ?? null,
    'package.json': pkg?.version ?? null,
    'Cargo.toml': cargoV,
  };
}

function installedVersion(ctx) {
  if (!exists(ctx.paths.installedExe)) return null;
  const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Item -LiteralPath '${ctx.paths.installedExe.replace(/'/g, "''")}').VersionInfo.ProductVersion`]);
  return r.ok ? r.stdout.trim() || null : null;
}

function checkVersions(ctx, F, cov) {
  const v = launcherVersions(ctx);
  const distinct = [...new Set(Object.values(v).filter(Boolean))];
  if (distinct.length > 1) {
    F.add({
      id: 'scanner.version-files-disagree', module: M, component: 'launcher', category: 'release',
      severity: 'P1', confidence: 'CONFIRMED',
      title: `Launcher version files disagree: ${Object.entries(v).map(([k, x]) => `${k}=${x}`).join(', ')}`,
      explain: 'RELEASING.md step 4: all three must match, or the updater and the installer describe different builds.',
      evidence: Object.entries(v).map(([k, x]) => ({ source: k, excerpt: `version ${x}` })),
      kb: 'RELEASING.md',
    });
  }
  const repoVersion = v['tauri.conf.json'];
  const latest = json(path.join(ctx.repo, 'latest.json'))?.version ?? null;
  const installed = installedVersion(ctx);
  ctx.versions = { repo: repoVersion, latestJson: latest, installed, files: v };
  cov.push({ area: 'launcher version files', status: 'checked', detail: JSON.stringify(v) });

  if (installed && latest && cmpVersion(installed, latest) < 0) {
    F.add({
      id: 'scanner.installed-launcher-behind', module: M, component: 'launcher', category: 'release',
      severity: 'P1', confidence: 'CONFIRMED',
      title: `Installed launcher is ${installed}; the published release is ${latest}`,
      explain: 'Anything fixed in the newer release is not running on this PC. Results from this machine describe the older build.',
      evidence: [{ source: rel(ctx.repo, ctx.paths.installedExe) || ctx.paths.installedExe, excerpt: `ProductVersion ${installed}` },
        { source: 'latest.json', excerpt: `"version": "${latest}"` }],
      fix: { summary: 'Open the launcher and accept the update, then re-run the doctor.' },
    });
  }
  cov.push({ area: 'installed launcher version', status: installed ? 'checked' : 'skipped', detail: installed ? `installed ${installed}, latest.json ${latest}` : 'no installed launcher found' });
}

/** The three staging gates RELEASING.md calls "the only thing between fixed in source and fixed for players". */
function checkStaging(ctx, F, cov) {
  const gates = [
    ['backend payload', ['tools/stage-backend.mjs', '--check']],
    ['Cobalt.dll copies', ['tools/stage-cobalt.mjs', '--check']],
    ['Project Reboot.dll copies', ['tools/stage-cobalt.mjs', 'reboot', '--check']],
  ];
  for (const [name, args] of gates) {
    if (!exists(path.join(ctx.repo, args[0]))) { cov.push({ area: `staging: ${name}`, status: 'skipped', detail: `${args[0]} missing` }); continue; }
    const r = run(ctx.tools.node, args, { cwd: ctx.repo, timeout: 600_000 });
    cov.push({ area: `staging: ${name}`, status: 'checked', detail: r.ok ? 'up to date' : `exit ${r.status}` });
    if (!r.ok) {
      F.add({
        id: 'scanner.staging-stale', key: `scanner.staging-stale:${name}`, module: M,
        component: name.startsWith('backend') ? 'backend' : name.startsWith('Cobalt') ? 'cobalt' : 'reboot',
        category: 'release', severity: 'P1', confidence: 'CONFIRMED',
        title: `Staged ${name} differ from the build — a release now would ship stale code`,
        explain: 'Same failure as NOVA-AUDIT-013 and cobalt-dll-three-live-copies: the build writes one path and the installer bundles another.',
        evidence: [{ source: args.join(' '), excerpt: (r.stdout + r.stderr).trim().split('\n').slice(-6).join(' | ') }],
        fix: { summary: `Run node ${args.filter(a => a !== '--check').join(' ')} after building.`, repairId: `restage:${name}` },
        data: { gate: args },
      });
    }
  }
}

/** Installed resources vs the repo's staged payload, file by file. */
function checkInstalledCopies(ctx, F, cov) {
  const inst = ctx.paths.installedResources;
  if (!exists(inst)) { cov.push({ area: 'installed resources', status: 'skipped', detail: 'no installed launcher' }); return; }
  const pairs = ['Cobalt.dll', 'Project Reboot.dll', 'bumper.mp4', 'bumper.wav'];
  const sameVersion = ctx.versions?.installed && ctx.versions?.repo && cmpVersion(ctx.versions.installed, ctx.versions.repo) === 0;
  const diffs = [];
  for (const f of pairs) {
    const a = md5(path.join(inst, f)), b = md5(path.join(ctx.paths.payload, f));
    if (a && b && a !== b) diffs.push({ f, a, b });
    if (!a && b) diffs.push({ f, a: 'MISSING', b });
  }
  cov.push({ area: 'installed vs staged binaries', status: 'checked', detail: `${pairs.length} files compared, ${diffs.length} differ` });
  if (!diffs.length) return;
  F.add({
    id: 'scanner.installed-differs-from-build', module: M, component: 'launcher', category: 'release',
    // Expected when the installed launcher is simply older; alarming when the version is the same.
    severity: sameVersion ? 'P1' : 'INFO', confidence: 'CONFIRMED',
    title: sameVersion
      ? `Installed ${ctx.versions.installed} carries different binaries from the ${ctx.versions.repo} build`
      : `Installed launcher (${ctx.versions?.installed ?? '?'}) runs older binaries than the repo build (${ctx.versions?.repo ?? '?'})`,
    explain: sameVersion
      ? 'Same version number, different bytes: the installed copy was modified, corrupted, or built from different source.'
      : 'Expected until the update is installed. Logs from this PC describe the installed binaries, not the repo.',
    evidence: diffs.map(d => ({ source: d.f, excerpt: `installed ${String(d.a).slice(0, 12)} vs build ${String(d.b).slice(0, 12)}` })),
  });
}

/**
 * Files torn to NUL bytes by an unclean shutdown. 2026-09-19: nova-proxy/proxy.js and 13
 * node_modules files were entirely NUL, so nothing bound 127.0.0.1:3551.
 */
function checkCorruption(ctx, F, cov) {
  const roots = [
    ['nova-proxy (installed)', path.join(ctx.paths.installedResources, 'nova-proxy'), 'proxy'],
    ['backend payload (installed)', path.join(ctx.paths.installedResources, 'Backend-Coordinator', 'dist'), 'backend'],
  ];
  for (const [name, dir, component] of roots) {
    if (!exists(dir)) { cov.push({ area: `corruption: ${name}`, status: 'skipped', detail: 'not present' }); continue; }
    const files = walk(dir, n => /\.(js|mjs|cjs|json)$/.test(n));
    const bad = [];
    for (const f of files) {
      const s = stat(f);
      if (!s || s.size === 0) continue;
      const nul = countNul(f);
      if (nul && nul / s.size > 0.2) bad.push({ f, nul, size: s.size });
    }
    cov.push({ area: `corruption: ${name}`, status: 'checked', detail: `${files.length} files scanned in full, ${bad.length} torn` });
    if (bad.length) {
      const fatal = bad.some(b => /proxy\.js$|index\.js$/.test(b.f));
      F.add({
        id: 'scanner.files-torn-to-nul', key: `scanner.files-torn-to-nul:${name}`, module: M, component, category: 'integrity',
        severity: fatal ? 'P0' : 'P1', confidence: 'CONFIRMED',
        title: `${bad.length} file(s) in ${name} are mostly NUL bytes`,
        explain: 'Unclean-shutdown corruption. A torn entry point means the process cannot start at all (2026-09-19: "the proxy didn\'t start"). If it recurs, suspect the drive.',
        evidence: bad.map(b => ({ source: b.f, excerpt: `${b.nul} of ${b.size} bytes are NUL` })),
        fix: { summary: 'Restore the files from the staged payload.', repairId: `restore-torn:${component}` },
        data: { dir, files: bad.map(b => b.f) },
      });
    }
  }
}

function checkToolchain(ctx, cov) {
  const node = process.version;
  const cargo = run(ctx.tools.cargo, ['--version']);
  cov.push({ area: 'toolchain: node', status: 'checked', detail: node });
  cov.push({ area: 'toolchain: cargo', status: cargo.ok ? 'checked' : 'skipped', detail: cargo.ok ? cargo.stdout.trim() : 'cargo not found' });
  cov.push({ area: 'toolchain: MSBuild', status: ctx.tools.msbuild ? 'checked' : 'skipped', detail: ctx.tools.msbuild || 'not found — C++ builds cannot be checked' });
  cov.push({ area: 'toolchain: dumpbin', status: ctx.tools.dumpbin ? 'checked' : 'skipped', detail: ctx.tools.dumpbin || 'not found — import tables cannot be checked' });
  cov.push({ area: 'toolchain: tsc', status: ctx.tools.tsc ? 'checked' : 'skipped', detail: ctx.tools.tsc || 'Main backend/node_modules missing — run npm install there' });
}

function checkGame(ctx, F, cov) {
  if (!ctx.paths.game) {
    cov.push({ area: 'game build', status: 'error', detail: ctx.paths.gameHow });
    if (ctx.paths.gameLastLaunched) {
      F.add({
        id: 'scanner.game-build-missing', module: M, component: 'game', category: 'install',
        severity: 'P0', confidence: 'CONFIRMED',
        title: `The Fortnite 7.40 build is gone: the launcher last launched ${ctx.paths.gameLastLaunched}, which no longer exists`,
        explain: 'Nothing can be played or hosted from this PC until the build is restored and re-selected in the launcher. Every check that reads the game (paks, exe signatures, the Aftermath slot, Reboot crash files) is skipped.',
        evidence: [
          { source: 'launcher-startup.log', excerpt: `firstlaunch: begin (path=${ctx.paths.gameLastLaunched}, …)` },
          { source: ctx.paths.gameLastLaunched, excerpt: 'folder not found' },
        ],
        fix: { summary: 'Restore the 7.40 build (or point the launcher at its new location), then re-run with --game <folder>.' },
      });
    }
    return;
  }
  const exe = stat(ctx.paths.gameExe);
  const paks = exists(ctx.paths.gamePaks) ? fs.readdirSync(ctx.paths.gamePaks).filter(n => n.endsWith('.pak')) : [];
  ctx.game = { dir: ctx.paths.game, exeBytes: exe?.size ?? null, paks: paks.length };
  cov.push({ area: 'game build', status: exe ? 'checked' : 'error', detail: `${ctx.paths.game} (found via ${ctx.paths.gameHow}); exe ${exe ? exe.size + ' bytes' : 'MISSING'}; ${paks.length} paks` });
  if (!exe) {
    F.add({
      id: 'scanner.game-exe-missing', module: M, component: 'game', category: 'install',
      severity: 'P0', confidence: 'CONFIRMED', title: 'The Fortnite executable is not where the launcher points',
      evidence: [{ source: ctx.paths.gameExe, excerpt: 'file not found' }],
    });
  }
}

function checkGit(ctx, cov) {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.repo });
  const dirty = run('git', ['status', '--porcelain'], { cwd: ctx.repo });
  const ahead = run('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: ctx.repo });
  ctx.git = { branch: branch.stdout.trim(), dirty: dirty.stdout.trim().split('\n').filter(Boolean).length, aheadOfMain: Number(ahead.stdout.trim()) || 0 };
  cov.push({ area: 'git', status: branch.ok ? 'checked' : 'skipped', detail: `branch ${ctx.git.branch}, ${ctx.git.dirty} uncommitted, ${ctx.git.aheadOfMain} ahead of origin/main` });
}

// ── remote: the live coordinator (read-only) ──────────────────────────────────────────────────────

function ssh(ctx, script, timeout = 60_000) {
  return run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-i', ctx.remote.key, ctx.remote.host, script], { timeout });
}

async function httpProbe(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    return { status: r.status, body: (await r.text()).slice(0, 400) };
  } catch (e) {
    return { status: 0, body: String(e?.cause?.code || e?.message || e) };
  }
}

async function checkRemote(ctx, F, cov) {
  // Reachability first, with a control: an unrouted path answers 200 {} from the catch-all, so a
  // 200 alone proves nothing (KNOWN_ISSUES "Do not fix these").
  const info = await httpProbe(`${ctx.remote.funnel}/nova/api/info`);
  const control = await httpProbe(`${ctx.remote.funnel}/nova/api/doctor-control-${Date.now()}`);
  const realRoute = info.status === 200 && /"name"\s*:\s*"Project Nova"/.test(info.body);
  cov.push({ area: 'coordinator: public Funnel', status: 'checked', detail: `info ${info.status}, control ${control.status} ${control.body.slice(0, 20)}` });
  if (!realRoute) {
    const ts = run('C:/Program Files/Tailscale/tailscale.exe', ['status']);
    const peer = /^\S+\s+clientfinder\s+.*$/m.exec(ts.stdout)?.[0] ?? '';
    const offline = /offline/.test(peer);
    F.add({
      id: 'scanner.coordinator-unreachable', module: M, component: 'coordinator', category: 'network',
      severity: 'P0', confidence: 'CONFIRMED',
      title: offline ? 'The coordinator is unreachable and its tailnet node is OFFLINE — the box is likely powered off'
        : 'The coordinator does not answer through the public Funnel',
      explain: 'Sign-in and matchmaking both go to the coordinator. "Box off" looks like: tailnet node offline + Funnel name not resolving + IPv6 SSH timing out, all at once (coordinator/README.md, Outages).',
      evidence: [{ source: `${ctx.remote.funnel}/nova/api/info`, excerpt: `HTTP ${info.status} ${info.body.slice(0, 120)}` },
        ...(peer ? [{ source: 'tailscale status', excerpt: peer.replace(/\s+/g, ' ') }] : [])],
    });
    return;
  }

  // Content drift: CRLF-normalised md5 of every non-test source file, box vs this repo's HEAD.
  const remote = ssh(ctx, `cd ${ctx.remote.dir}/src && find . -name "*.ts" ! -name "*.test.ts" | sort | while read f; do printf "%s %s\\n" "$(tr -d "\\r" < "$f" | md5sum | cut -d" " -f1)" "$f"; done`);
  if (!remote.ok) {
    cov.push({ area: 'coordinator: source drift', status: 'error', detail: `ssh failed: ${remote.stderr.trim().slice(0, 160)}` });
  } else {
    const remoteMap = new Map(remote.stdout.trim().split('\n').filter(Boolean).map(l => { const [h, f] = l.split(' '); return [f.replace(/^\.\//, ''), h]; }));
    const files = run('git', ['ls-files', 'Main backend/src'], { cwd: ctx.repo }).stdout.split('\n')
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const differ = [], missing = [];
    for (const f of files) {
      const blob = run('git', ['show', `HEAD:${f}`], { cwd: ctx.repo });
      const h = (await import('node:crypto')).createHash('md5').update(blob.stdout.replace(/\r/g, '')).digest('hex');
      const key = f.replace(/^Main backend\/src\//, '');
      if (!remoteMap.has(key)) missing.push(key);
      else if (remoteMap.get(key) !== h) differ.push(key);
      remoteMap.delete(key);
    }
    const extra = [...remoteMap.keys()];
    cov.push({ area: 'coordinator: source drift', status: 'checked', detail: `${files.length} files compared: ${differ.length} differ, ${missing.length} missing on box, ${extra.length} only on box` });
    if (differ.length || missing.length) {
      F.add({
        id: 'scanner.coordinator-drift', module: M, component: 'coordinator', category: 'drift',
        severity: 'P1', confidence: 'CONFIRMED',
        title: `The coordinator runs different backend code from the repo (${differ.length} differ, ${missing.length} missing)`,
        explain: 'A backend fix is not live until the box matches. Mtime checks cannot see this (they miss absent files); only a content diff does. Check direction before deploying — the box has occasionally been ahead.',
        evidence: [...differ.map(f => ({ source: `src/${f}`, excerpt: 'content differs from HEAD' })), ...missing.map(f => ({ source: `src/${f}`, excerpt: 'missing on the coordinator' }))],
        fix: { summary: 'Deploy with the staged-test procedure in coordinator/README.md.' },
        data: { differ, missing, extra },
      });
    }
  }

  // Standing rules and step-two evidence. Presence only — secret VALUES are never read here.
  const env = ssh(ctx, `cd ${ctx.remote.dir}; for k in NOVA_REGISTER_SECRET NOVA_AC_ADMIN_SECRET NOVA_COORDINATOR; do printf "%s=%s\\n" $k "$(grep -cE "^$k=.+" .env)"; done; printf "secretfile=%s\\n" "$([ -s data/register-secret ] && echo 1 || echo 0)"; grep -ho "auth=[a-z]*" nova.log 2>/dev/null | sort | uniq -c`);
  if (env.ok) {
    const has = k => new RegExp(`^${k}=1`, 'm').test(env.stdout);
    const tallies = Object.fromEntries([...env.stdout.matchAll(/^\s*(\d+)\s+auth=(\w+)/gm)].map(m => [m[2], Number(m[1])]));
    ctx.remoteState = { registerSecretEnforced: has('NOVA_REGISTER_SECRET'), adminSecret: has('NOVA_AC_ADMIN_SECRET'), auth: tallies };
    cov.push({ area: 'coordinator: config rules', status: 'checked', detail: `register gate ${has('NOVA_REGISTER_SECRET') ? 'ENFORCED' : 'open'}, admin secret ${has('NOVA_AC_ADMIN_SECRET') ? 'set' : 'unset'}, registrations ${JSON.stringify(tallies)}` });
    if (has('NOVA_COORDINATOR')) {
      F.add({ id: 'scanner.coordinator-in-agent-mode', module: M, component: 'coordinator', category: 'config', severity: 'P0', confidence: 'CONFIRMED',
        title: 'NOVA_COORDINATOR is set on the coordinator — it would run as a host agent',
        explain: 'That variable flips a backend into HOST AGENT mode; the Linux coordinator cannot run a gameserver (memory: nova-coordinator-deploy).' });
    }
    if (!has('NOVA_AC_ADMIN_SECRET')) {
      F.add({ id: 'scanner.coordinator-admin-secret-unset', module: M, component: 'coordinator', category: 'config', severity: 'P2', confidence: 'CONFIRMED',
        title: 'NOVA_AC_ADMIN_SECRET is not set — the dashboard and anti-cheat admin views are closed', explain: 'Fails closed by design; set it to use the dashboard.' });
    }
    if (has('NOVA_REGISTER_SECRET') && (tallies.unsigned || 0) > 0) {
      F.add({ id: 'scanner.register-gate-closed-on-unsigned-field', module: M, component: 'coordinator', category: 'config', severity: 'P0', confidence: 'PROBABLE',
        title: 'The register gate is enforced while unsigned registrations are still arriving',
        explain: 'Every launcher that sends no secret has lost the ability to host (KNOWN_ISSUES gameserver-register-unauthenticated).' });
    }
  } else {
    cov.push({ area: 'coordinator: config rules', status: 'error', detail: env.stderr.trim().slice(0, 160) });
  }
}

export default {
  id: M,
  title: 'Project Scanner',
  async run(ctx, F, opts) {
    const cov = [];
    checkGit(ctx, cov);
    checkToolchain(ctx, cov);
    checkVersions(ctx, F, cov);
    checkGame(ctx, F, cov);
    checkStaging(ctx, F, cov);
    checkInstalledCopies(ctx, F, cov);
    checkCorruption(ctx, F, cov);
    if (opts.remote) await checkRemote(ctx, F, cov);
    else cov.push({ area: 'coordinator', status: 'skipped', detail: 'pass --remote to check the live coordinator' });
    return { coverage: cov };
  },
};
