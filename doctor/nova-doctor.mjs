#!/usr/bin/env node
/**
 * nova-doctor — find, group and help fix what is wrong with Project Nova.
 *
 * Project Nova is not an Unreal Engine project in the editor sense: there is no .uproject, no
 * Blueprint source and no editor build. It is a private server around a SHIPPED Fortnite 7.40
 * (UE 4.22, CL-5046157) binary. So the doctor investigates what actually exists — the game build and
 * its paks, UE4's own logs and crash reports, Nova's backend / launcher / Cobalt / Reboot / proxy
 * source and builds, the installed copies of each, and the live coordinator — and says plainly
 * which editor-era checks do not apply and why (doctor/COVERAGE.md).
 *
 * USAGE
 *   node doctor/nova-doctor.mjs                 scan with the fast modules
 *   node doctor/nova-doctor.mjs scan --build    also compile everything (MSBuild, cargo, tsc) and run tests
 *   node doctor/nova-doctor.mjs scan --remote   also check the live coordinator (read-only SSH + HTTP)
 *   node doctor/nova-doctor.mjs scan --only logs,runtime
 *   node doctor/nova-doctor.mjs scan --save-baseline      remember this run as the baseline
 *   node doctor/nova-doctor.mjs repair          list the repairs available for current findings
 *   node doctor/nova-doctor.mjs repair --apply <id> [--yes]
 *   node doctor/nova-doctor.mjs verify          regression tests (all suites + re-scan vs baseline)
 *   node doctor/nova-doctor.mjs live --agent http://127.0.0.1:3552 [--parent <pid>]
 *                                               what the launcher runs on players' PCs: tails new log lines
 *                                               and hands them, plus a player-profile scan after each
 *                                               game session, to the local agent (lib/live.mjs)
 *
 * Output: doctor/out/latest/report.json and report.html (and a timestamped copy).
 * Exit code: 0, or 1 with --strict when an open CONFIRMED P0/P1 exists.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discover } from './lib/context.mjs';
import { FindingSet, SEVERITIES } from './lib/finding.mjs';
import { compareToBaseline } from './lib/baseline.mjs';

const MODULE_ORDER = ['scanner', 'logs', 'runtime', 'assets', 'blueprint', 'native', 'rootcause'];
export const VERSION = '1.0.0';

function parseArgs(argv) {
  const opts = { command: 'scan', only: null, skip: [], build: false, remote: false, strict: false };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) opts.command = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = () => rest[++i];
    if (a === '--only') opts.only = next().split(',').map(s => s.trim());
    else if (a === '--skip') opts.skip = next().split(',').map(s => s.trim());
    else if (a === '--build') opts.build = true;
    else if (a === '--remote') opts.remote = true;
    else if (a === '--game') opts.game = next();
    else if (a === '--profile') opts.profile = next();
    else if (a === '--agent') opts.agent = next();
    else if (a === '--parent') opts.parent = Number(next());
    else if (a === '--out') opts.out = next();
    else if (a === '--save-baseline') opts.saveBaseline = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--apply') opts.apply = next();
    else if (a === '--rollback') opts.rollback = next();
    else if (a === '--quick') opts.quick = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--help' || a === '-h') opts.command = 'help';
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

export async function scan(opts) {
  const ctx = discover(opts);
  const findings = new FindingSet();
  const coverage = [];
  const timings = {};
  // The player profile runs on installed launchers: no repo, so the source & build analyzer is out.
  const profileSkip = opts.profile === 'player' ? ['native'] : [];
  const wanted = MODULE_ORDER.filter(m => (!opts.only || opts.only.includes(m) || m === 'rootcause') && !opts.skip.includes(m) && !profileSkip.includes(m));

  for (const id of wanted) {
    const t0 = Date.now();
    if (!fs.existsSync(new URL(`./modules/${id}.mjs`, import.meta.url))) {
      coverage.push({ module: id, area: id, status: 'skipped', detail: 'module not built yet' });
      continue;
    }
    try {
      const mod = (await import(`./modules/${id}.mjs`)).default;
      const r = (await mod.run(ctx, findings, opts)) || {};
      for (const c of r.coverage || []) coverage.push({ module: id, ...c });
      if (r.causes) ctx.causes = r.causes;
    } catch (e) {
      // A module that crashes is a finding about the doctor, never a silent hole in the report.
      findings.add({
        id: 'doctor.module-crashed', key: `doctor.module-crashed:${id}`, module: id, component: 'doctor',
        severity: 'P2', confidence: 'CONFIRMED', title: `The ${id} module crashed — its area was not checked`,
        explain: String(e?.stack || e).split('\n').slice(0, 4).join(' | '),
      });
      coverage.push({ module: id, area: id, status: 'error', detail: String(e?.message || e) });
    }
    timings[id] = Date.now() - t0;
  }

  const list = findings.list();
  const summary = { total: list.length, open: 0, bySeverity: {}, byConfidence: {}, byComponent: {} };
  for (const f of list) {
    if (f.status === 'open') summary.open++;
    summary.bySeverity[f.severity] = (summary.bySeverity[f.severity] || 0) + (f.status === 'open' ? 1 : 0);
    summary.byConfidence[f.confidence] = (summary.byConfidence[f.confidence] || 0) + 1;
    summary.byComponent[f.component] = (summary.byComponent[f.component] || 0) + 1;
  }

  const report = {
    tool: 'nova-doctor', version: VERSION,
    startedAt: ctx.startedAt, finishedAt: new Date().toISOString(),
    machine: os.hostname(),
    options: { only: opts.only, build: !!opts.build, remote: !!opts.remote, profile: opts.profile || 'dev' },
    paths: { game: ctx.paths.game, gameHow: ctx.paths.gameHow },
    summary, timings, coverage,
    causes: ctx.causes || [],
    findings: list,
  };

  // Players' reports live in their own %LOCALAPPDATA%: an installed launcher's folder may not be writable.
  const outRoot = opts.out || (opts.profile === 'player' ? path.join(ctx.paths.novaState, 'Doctor') : path.join(ctx.repo, 'doctor', 'out'));
  report.baseline = compareToBaseline(report, path.join(outRoot, 'baseline.json'));
  writeReport(report, outRoot, opts);
  return report;
}

function writeReport(report, outRoot, opts) {
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const dirs = [path.join(outRoot, 'runs', stamp), path.join(outRoot, 'latest')];
  let html = null;
  try { html = renderFn ? renderFn(report) : null; } catch (e) { report.renderError = String(e?.message || e); }
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'report.json'), JSON.stringify(report, null, 2));
    if (html) fs.writeFileSync(path.join(d, 'report.html'), html);
  }
  if (opts.saveBaseline) fs.writeFileSync(path.join(outRoot, 'baseline.json'), JSON.stringify(report, null, 2));
  report.outDir = path.join(outRoot, 'latest');
}

/** The HTML renderer, loaded in main(). JSON is always written even if this is missing or throws. */
let renderFn = null;

function printSummary(report) {
  const open = report.findings.filter(f => f.status === 'open');
  const line = SEVERITIES.map(s => `${s} ${report.summary.bySeverity[s] || 0}`).join('  ');
  console.log(`\nnova-doctor ${report.version} — ${report.summary.total} findings, ${open.length} open   [${line}]`);
  if (report.baseline?.compared) {
    const b = report.baseline;
    console.log(`vs baseline ${b.baselineAt}: ${b.new.length} new, ${b.resolved.length} resolved, ${b.persisting} persisting`);
  }
  for (const f of open.slice(0, 25)) {
    console.log(`  ${f.severity.padEnd(4)} ${f.confidence.padEnd(9)} ${f.component.padEnd(11)} ${f.title}${f.count > 1 ? `  (×${f.count})` : ''}`);
  }
  if (open.length > 25) console.log(`  … ${open.length - 25} more in the report`);
  const gaps = report.coverage.filter(c => c.status !== 'checked');
  console.log(`coverage: ${report.coverage.length - gaps.length} areas checked, ${gaps.length} skipped/n.a./error — see report`);
  console.log(`report: ${path.join(report.outDir, 'report.html')}\n`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.command === 'help') {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8');
    console.log(src.split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }
  try { renderFn = (await import('./lib/render.mjs')).renderHtml; } catch { renderFn = null; }

  if (opts.command === 'scan') {
    const report = await scan(opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else if (!opts.quiet) printSummary(report);
    const blocking = report.findings.some(f => f.status === 'open' && f.confidence === 'CONFIRMED' && (f.severity === 'P0' || f.severity === 'P1'));
    return opts.strict && blocking ? 1 : 0;
  }
  if (opts.command === 'serve') {
    // View the latest report in a browser. Loopback only, read-only, and only files inside out/latest.
    const http = await import('node:http');
    // fileURLToPath, not URL.pathname: the repo path contains a space, which pathname keeps as %20.
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'latest');
    const port = Number(process.env.NOVA_DOCTOR_PORT || 4310);
    http.createServer((req, res) => {
      const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'report.html';
      const file = path.join(root, path.basename(name));          // basename: no path traversal
      if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json' });
      fs.createReadStream(file).pipe(res);
    }).listen(port, '127.0.0.1', () => console.log(`nova-doctor report: http://127.0.0.1:${port}/`));
    return new Promise(() => {});
  }
  if (opts.command === 'live') return (await import('./lib/live.mjs')).liveCommand(opts, scan);
  if (opts.command === 'repair') return (await import('./lib/repair.mjs')).repairCommand(opts, scan);
  if (opts.command === 'verify') return (await import('./lib/verify.mjs')).verifyCommand(opts, scan);
  throw new Error(`unknown command: ${opts.command}`);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('nova-doctor.mjs')) {
  main().then(code => process.exit(code ?? 0), e => { console.error(e?.stack || e); process.exit(2); });
}
