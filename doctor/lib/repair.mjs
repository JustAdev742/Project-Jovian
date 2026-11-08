/**
 * Repair Engine — fixes that are safe to apply mechanically, each with a precondition, a backup, a
 * verification and a way back.
 *
 * Deliberately narrow. Code defects are not "repaired" by a script: they are findings with evidence
 * for a person (or an agent) to fix, build and test. What lives here is environmental drift that
 * has a single right answer — a stale payload, a torn install file, a sliver window, a token in a
 * log — where the risky part is forgetting to do it, not deciding what to do.
 *
 *   node doctor/nova-doctor.mjs repair                       list what applies to current findings
 *   node doctor/nova-doctor.mjs repair --apply <id> [--yes]  apply one (--yes required outside the repo)
 *   node doctor/nova-doctor.mjs repair --rollback <run-dir>  put back what a repair backed up
 *
 * "Fixed" is only ever claimed after a re-scan no longer reports the finding that triggered it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { run, exists, countNul, md5, readText } from './util.mjs';

const TOKEN = /eg1~[A-Za-z0-9._~+\/=-]{20,}/g;

export const REPAIRS = [
  ...['backend payload', 'Cobalt.dll copies', 'Project Reboot.dll copies'].map(name => ({
    id: `restage:${name}`,
    title: `Re-stage the ${name} from the current build`,
    scope: 'repo',                     // touches only the gitignored installer payload in this repo
    rescan: ['scanner'],
    applies: f => f.key === `scanner.staging-stale:${name}`,
    apply(ctx, f) {
      const args = f.data.gate.filter(a => a !== '--check');
      const r = run(ctx.tools.node, args, { cwd: ctx.repo, timeout: 900_000 });
      if (!r.ok) throw new Error(`${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
      return `ran node ${args.join(' ')}`;
    },
  })),
  ...['proxy', 'backend'].map(component => ({
    id: `restore-torn:${component}`,
    title: `Restore NUL-torn ${component === 'proxy' ? 'nova-proxy' : 'backend payload'} files in the installed launcher from the staged payload`,
    scope: 'installed',
    rescan: ['scanner'],
    applies: f => f.id === 'scanner.files-torn-to-nul' && f.component === component,
    apply(ctx, f, backupDir) {
      const done = [];
      for (const file of f.data.files) {
        const relp = path.relative(ctx.paths.installedResources, file);
        const src = path.join(ctx.paths.payload, relp);
        if (!exists(src) || countNul(src) > 0) throw new Error(`no clean source for ${relp} in the staged payload`);
        const b = path.join(backupDir, 'installed', relp);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(file, b);
        fs.copyFileSync(src, file);
        if (md5(src) !== md5(file)) throw new Error(`copy of ${relp} did not verify`);
        done.push(relp);
      }
      return `restored ${done.length} file(s): ${done.join(', ')}`;
    },
    rollbackRoot: ctx => ctx.paths.installedResources,
  })),
  {
    id: 'fix-sliver-window',
    title: 'Reset a sliver-sized GameUserSettings.ini resolution to the desktop size',
    scope: 'installed',
    rescan: ['assets'],
    applies: f => f.id === 'assets.sliver-window',
    apply(ctx, f, backupDir) {
      const p = path.join(ctx.paths.ue4Config, 'GameUserSettings.ini');
      const t = readText(p);
      fs.mkdirSync(path.join(backupDir, 'ue4config'), { recursive: true });
      fs.copyFileSync(p, path.join(backupDir, 'ue4config', 'GameUserSettings.ini'));
      // Same rule as repair_client_display_settings (carter.rs): only touch values below 640x480,
      // and take the target from the game's own record of the desktop.
      const w = Number(/DesiredScreenWidth=(\d+)/.exec(t)?.[1]) || 1920;
      const h = Number(/DesiredScreenHeight=(\d+)/.exec(t)?.[1]) || 1080;
      const out = t
        .replace(/^(ResolutionSizeX|LastUserConfirmedResolutionSizeX)=(\d+)/gm, (m, k, v) => (Number(v) < 640 ? `${k}=${w}` : m))
        .replace(/^(ResolutionSizeY|LastUserConfirmedResolutionSizeY)=(\d+)/gm, (m, k, v) => (Number(v) < 480 ? `${k}=${h}` : m));
      fs.writeFileSync(p, out);
      return `set the resolution to ${w}x${h}`;
    },
    rollbackRoot: ctx => ctx.paths.ue4Config,
  },
  {
    id: 'scrub-tokens',
    title: 'Redact bearer tokens already written into Nova\'s own log files',
    scope: 'installed',
    rescan: ['logs'],
    noBackup: 'a backup would keep the very secrets being removed',
    applies: f => f.id === 'log.token-in-log',
    apply(ctx) {
      const files = [ctx.paths.cobaltLog, ctx.paths.startupLog, ctx.paths.agentLog, ctx.paths.agentLog + '.1'].filter(exists);
      let n = 0;
      for (const p of files) {
        const buf = fs.readFileSync(p, 'latin1');            // byte-preserving: these logs hold NUL runs
        const out = buf.replace(TOKEN, () => { n++; return 'eg1~<redacted>'; });
        if (out !== buf) fs.writeFileSync(p, out, 'latin1');
      }
      return `redacted ${n} token(s) in ${files.length} file(s)`;
    },
  },
];

function applicable(report) {
  const out = [];
  for (const r of REPAIRS) {
    const hits = report.findings.filter(f => f.status === 'open' && r.applies(f));
    if (hits.length) out.push({ repair: r, findings: hits });
  }
  return out;
}

export async function repairCommand(opts, scan) {
  if (opts.rollback) return rollback(opts);
  const report = await scan({ ...opts, quiet: true, only: ['scanner', 'logs', 'assets'] });
  const list = applicable(report);
  if (!opts.apply) {
    if (!list.length) { console.log('No mechanical repairs apply to the current findings.'); return 0; }
    console.log('Repairs available for the current findings (dry run — nothing changed):\n');
    for (const { repair, findings } of list) {
      console.log(`  ${repair.id}`);
      console.log(`      ${repair.title}`);
      console.log(`      scope: ${repair.scope === 'repo' ? 'this repo only' : 'files OUTSIDE the repo (needs --yes)'}${repair.noBackup ? `; no backup — ${repair.noBackup}` : '; backed up first'}`);
      console.log(`      for: ${findings.map(f => f.title).join(' | ')}`);
    }
    console.log('\nApply one with: node doctor/nova-doctor.mjs repair --apply <id>' + (list.some(l => l.repair.scope !== 'repo') ? ' --yes' : ''));
    return 0;
  }

  const hit = list.find(l => l.repair.id === opts.apply);
  if (!hit) { console.error(`Repair "${opts.apply}" does not apply to any open finding right now.`); return 1; }
  const { repair, findings } = hit;
  if (repair.scope !== 'repo' && !opts.yes) { console.error(`"${repair.id}" changes files outside the repo. Re-run with --yes to confirm.`); return 1; }

  const outRoot = opts.out || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'out');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(outRoot, 'repairs', `${stamp}-${repair.id.replace(/[^\w.-]+/g, '_')}`);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = (await import('./context.mjs')).discover(opts);
  const journal = { repair: repair.id, at: stamp, findings: findings.map(f => f.key), steps: [] };
  try {
    for (const f of findings) journal.steps.push(repair.apply(ctx, f, dir));
  } catch (e) {
    journal.error = String(e?.message || e);
    fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(journal, null, 2));
    console.error(`Repair failed: ${journal.error}\nBackups (if any) are in ${dir}; roll back with --rollback "${dir}"`);
    return 1;
  }
  // Verify by re-scanning: the triggering findings must be gone.
  const after = await scan({ ...opts, quiet: true, only: repair.rescan });
  const still = findings.map(f => f.key).filter(k => after.findings.some(x => x.key === k && x.status === 'open'));
  journal.verified = still.length === 0;
  journal.stillPresent = still;
  journal.rollbackRoot = repair.rollbackRoot ? repair.rollbackRoot(ctx) : null;
  fs.writeFileSync(path.join(dir, 'journal.json'), JSON.stringify(journal, null, 2));
  console.log(`${repair.id}: ${journal.steps.join('; ')}`);
  console.log(journal.verified ? 'VERIFIED: a re-scan no longer reports the finding(s).' : `NOT verified: still reported — ${still.join(', ')}`);
  console.log(`journal: ${path.join(dir, 'journal.json')}`);
  return journal.verified ? 0 : 1;
}

function rollback(opts) {
  const dir = opts.rollback;
  const journal = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf8'));
  if (!journal.rollbackRoot) { console.error('This repair has nothing to roll back (no backup was taken).'); return 1; }
  const roots = { installed: journal.rollbackRoot, ue4config: journal.rollbackRoot };
  let n = 0;
  for (const sub of Object.keys(roots)) {
    const base = path.join(dir, sub);
    if (!exists(base)) continue;
    const walkCopy = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walkCopy(p);
        else { const target = path.join(roots[sub], path.relative(base, p)); fs.copyFileSync(p, target); n++; }
      }
    };
    walkCopy(base);
  }
  console.log(`Rolled back ${n} file(s) from ${dir}.`);
  return 0;
}
