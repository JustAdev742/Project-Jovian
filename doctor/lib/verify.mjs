/**
 * Regression Tester — run every test the project has, then re-scan and compare with the baseline.
 *
 *   node doctor/nova-doctor.mjs verify           everything
 *   node doctor/nova-doctor.mjs verify --quick   skip the slow native builds (cargo, MSVC)
 *
 * Several of the project's harnesses exit 0 whatever happens (e2e-probe always does; method-audit
 * exits 0 on method mismatches), so each suite is judged by PARSING its output, never by its exit
 * code alone. A suite that cannot run is reported as such — not as a pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { run, exists } from './util.mjs';
import { discover } from './context.mjs';

function suites(ctx, quick) {
  const be = ctx.paths.backend;
  const tsx = path.join(be, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const list = [
    {
      id: 'doctor unit tests', cmd: [ctx.tools.node, ['--test', ...fs.readdirSync(path.join(ctx.repo, 'doctor', 'test')).filter(n => n.endsWith('.test.mjs')).map(n => path.join(ctx.repo, 'doctor', 'test', n))]],
      judge: o => nodeTest(o),
    },
    {
      id: 'backend tests', when: () => exists(tsx), cwd: be,
      cmd: [ctx.tools.node, [tsx, '--test', ...listTests(path.join(be, 'src'))]], timeout: 900_000,
      judge: o => nodeTest(o),
    },
    {
      id: 'backend typecheck', when: () => !!ctx.tools.tscJs, cwd: be,
      cmd: [ctx.tools.node, [ctx.tools.tscJs, '--noEmit']], judge: o => ({ ok: o.ok, detail: o.ok ? 'clean' : (o.stdout.match(/error TS\d+/g) || []).length + ' errors' }),
    },
    {
      id: 'staging gates', cmd: null,
      custom: () => {
        const gates = [['tools/stage-backend.mjs', '--check'], ['tools/stage-cobalt.mjs', '--check'], ['tools/stage-cobalt.mjs', 'reboot', '--check']];
        const res = gates.map(g => run(ctx.tools.node, g, { cwd: ctx.repo }));
        return { ok: res.every(r => r.ok), detail: res.map((r, i) => `${gates[i].join(' ')}: ${r.ok ? 'ok' : 'STALE'}`).join('; ') };
      },
    },
    {
      id: 'method audit', cmd: [ctx.tools.node, ['tools/method-audit.mjs']], cwd: ctx.repo,
      // "33/33 clean · 0 method mismatch · 0 unrouted" — exit code ignores mismatches.
      judge: o => {
        const m = /(\d+)\/(\d+) clean · (\d+) method mismatch · (\d+) unrouted/.exec(o.stdout);
        return m ? { ok: m[3] === '0' && m[4] === '0', detail: m[0] } : { ok: false, detail: 'summary line not found' };
      },
    },
    {
      id: 'e2e probe (7.40 session replay)', when: () => exists(tsx), cwd: be,
      cmd: [ctx.tools.node, [tsx, 'e2e-probe.ts']], timeout: 300_000,
      // Always exits 0 — read "N/M returned 2xx".
      judge: o => {
        const m = /(\d+)\/(\d+) returned 2xx/.exec(o.stdout);
        return m ? { ok: m[1] === m[2], detail: m[0] } : { ok: false, detail: 'summary line not found' };
      },
    },
  ];
  if (!quick) {
    list.push({
      id: 'launcher ue4log tests', cwd: ctx.paths.tauri, cmd: [ctx.tools.cargo, ['test', 'ue4log']], timeout: 1_200_000,
      judge: o => {
        const m = [...(o.stdout + o.stderr).matchAll(/test result: (\w+)\. (\d+) passed; (\d+) failed/g)].pop();
        return m ? { ok: m[1] === 'ok' && m[3] === '0', detail: `${m[2]} passed, ${m[3]} failed` } : { ok: false, detail: 'no test result line' };
      },
    });
    list.push({
      id: 'Cobalt emitter test + Reboot drift', when: () => exists(path.join(ctx.paths.cobalt, 'Cobalt', 'tests', 'build-and-run.cmd')),
      // Full path, no shell: cmd resolved the bare name against the wrong directory (and shell:true
      // drew a DEP0190 warning). The script itself uses %~dp0 for its own paths.
      cwd: path.join(ctx.paths.cobalt, 'Cobalt', 'tests'), cmd: ['cmd.exe', ['/d', '/c', path.join(ctx.paths.cobalt, 'Cobalt', 'tests', 'build-and-run.cmd')]], timeout: 600_000,
      judge: o => ({ ok: o.ok && /matches the Reboot copy/.test(o.stdout), detail: o.ok ? 'redaction test passed, emitter matches Reboot' : (o.stdout + o.stderr).trim().split('\n').slice(-2).join(' | ') }),
    });
  }
  return list;
}

function listTests(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTests(p));
    else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function nodeTest(o) {
  const t = o.stdout + o.stderr;
  const pass = Number(/ℹ pass (\d+)/.exec(t)?.[1] ?? NaN), fail = Number(/ℹ fail (\d+)/.exec(t)?.[1] ?? NaN);
  if (Number.isNaN(pass)) return { ok: false, detail: 'no node:test summary in the output' };
  return { ok: fail === 0, detail: `${pass} passed, ${fail} failed` };
}

export async function verifyCommand(opts, scan) {
  const ctx = discover(opts);
  const results = [];
  for (const s of suites(ctx, !!opts.quick)) {
    if (s.when && !s.when()) { results.push({ id: s.id, ok: null, detail: 'could not run (tooling missing)' }); continue; }
    const t0 = Date.now();
    let r;
    if (s.custom) r = s.custom();
    else {
      const o = run(s.cmd[0], s.cmd[1], { cwd: s.cwd, timeout: s.timeout, shell: s.shell });
      r = s.judge(o);
    }
    results.push({ id: s.id, ...r, seconds: Math.round((Date.now() - t0) / 1000) });
    if (!opts.quiet) console.log(`  ${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP'}  ${s.id.padEnd(36)} ${r.detail}`);
  }
  const report = await scan({ ...opts, quiet: true, saveBaseline: false });
  const regressions = report.baseline?.compared ? report.baseline.new : null;
  const out = { at: new Date().toISOString(), suites: results, baseline: report.baseline };
  fs.writeFileSync(path.join(report.outDir, 'verify.json'), JSON.stringify(out, null, 2));
  if (!opts.quiet) {
    console.log(regressions == null ? '  (no baseline saved — run scan --save-baseline to track regressions)'
      : `  re-scan vs baseline: ${regressions.length} NEW open finding(s)${regressions.length ? ': ' + regressions.join(', ') : ''}, ${report.baseline.resolved.length} no longer reported`);
  }
  const failed = results.some(r => r.ok === false) || (regressions && regressions.length > 0);
  return failed ? 1 : 0;
}
