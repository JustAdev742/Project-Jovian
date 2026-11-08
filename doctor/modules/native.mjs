/**
 * Source & build analyzer — Nova's own code: the C++ DLLs (Cobalt, Reboot), the Rust launcher and
 * the TypeScript backend.
 *
 * Two tiers:
 *
 *   STATIC (always, seconds). Patterns that have each caused a real defect here, so a recurrence is
 *   caught before it ships. Each says where the lesson came from. Static matches are POTENTIAL
 *   unless the pattern is a defect by construction (an invalid escape is never what was meant).
 *
 *   BUILD (--build, minutes). Compile everything and read the diagnostics — NOT just the exit code.
 *   "It builds" said nothing about the bumper off-switch: MSVC warned C4129 in every release from
 *   1.7.2 to 1.8.1 and nobody read it. C++ builds go to a TEMP output directory so a diagnostic build
 *   can never replace the DLLs the installer ships (the staging gates would then report them stale).
 *
 * "No compiler errors" is never reported as "healthy": the coverage list says exactly which checks
 * ran.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { walk, readText, exists, run, md5, rel } from '../lib/util.mjs';

const M = 'native';

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function snippet(text, index) {
  const s = text.lastIndexOf('\n', index) + 1;
  const e = text.indexOf('\n', index);
  return text.slice(s, e < 0 ? undefined : e).trim();
}

/** C++ sources Nova owns (vendored MinHook/Memcury/Detours excluded — not ours to lint). */
function cppFiles(ctx) {
  const skip = /[\\/](vendor|packages|MinHook|minhook|tests|x64|\.vs)[\\/]|memcury\.h$|fontawesome\.h$|imgui/i;
  return [
    ...walk(path.join(ctx.paths.cobalt, 'Cobalt'), n => /\.(cpp|h|hpp)$/i.test(n)),
    ...walk(path.join(ctx.paths.reboot, 'Project Reboot'), n => /\.(cpp|h|hpp)$/i.test(n)),
  ].filter(f => !skip.test(f));
}

// ── static C++ patterns ───────────────────────────────────────────────────────────────────────────

const CPP_PATTERNS = [
  {
    id: 'cpp-invalid-escape',
    // A backslash inside a string literal followed by a character C++ has no escape for. MSVC warns
    // C4129 and drops the backslash — L"\ProjectNova\bumper.off" became a garbled path and the
    // bumper's off-switch never worked (KNOWN_ISSUES bumper-off-switch-never-worked).
    re: /L?"(?:[^"\\\n]|\\.)*\\[^\\nrtabfv0-7x'"?uU\n](?:[^"\\\n]|\\.)*"/g,
    filter: m => !/^#\s*include/.test(m.line) && !/\\\\/.test(m[0].slice(0, 0)),
    severity: 'P2', confidence: 'CONFIRMED', component: null,
    title: 'Invalid escape sequence in a string literal (MSVC C4129 — the backslash is silently dropped)',
    kb: 'KNOWN_ISSUES.md#bumper-off-switch-never-worked',
  },
  {
    id: 'cpp-cstr-of-temporary',
    // .c_str() of a std::(w)string built in the same expression dangles at the end of the
    // full-expression if the pointer is stored. Was a use-after-free on EVERY object lookup in
    // Reboot (structs.cpp, fixed 2026-07-25).
    re: /(?:=|return)\s*[^;\n]*(?:std::w?string|to_w?string)\s*\([^;\n]*\)\s*\.c_str\(\)/g,
    severity: 'P1', confidence: 'POTENTIAL', component: null,
    title: '.c_str() of a temporary string stored or returned — the pointer dangles',
    kb: 'memory: reboot-dll (FindObject use-after-free)',
  },
  {
    id: 'cpp-guard-tests-field-address',
    // Get<T>() returns the ADDRESS of the field, never null; `if (p)` then always passes while the
    // value used next is unchecked. Root cause of the 0x90 match-end crash (TickFlush, 2026-07-25).
    re: /auto\s*\*?\s*(\w+)\s*=\s*Get<[^;\n]+;\s*\n\s*if\s*\(\s*\1\s*\)/g,
    severity: 'P2', confidence: 'POTENTIAL', component: 'reboot',
    title: 'Null guard tests the address returned by Get<T>() (never null), not the value',
    kb: 'memory: reboot-dll (TickFlush dropped *)',
  },
  {
    id: 'cpp-vtable-slot-call',
    // NEVER guess a vtable slot. 1.8.0 searched slots for UpdateResource and froze the game.
    re: /\(\s*\*\s*\(\s*(?:void|uintptr_t|uint64_t|__int64)\s*\*\*+\s*\)\s*\w+\s*\)\s*\[\s*\d+\s*\]|vtable\s*\[\s*\d+\s*\]/g,
    severity: 'P2', confidence: 'POTENTIAL', component: null,
    title: 'Call through a hard-coded vtable slot',
    kb: 'memory: nova-bumper (never vtable-guess)',
  },
  {
    id: 'cpp-arbitrary-scan-cap',
    // `&& n < 8` capped the music mute at eight classes; the base class was never reached and the
    // feature logged "ok" while doing nothing (bumper-music-mute-capped-at-eight-classes).
    re: /for\s*\([^;]*;[^;]*&&\s*\w+\s*<\s*\d+\s*;/g,
    severity: 'P3', confidence: 'POTENTIAL', component: null,
    title: 'Loop bounded by an arbitrary count alongside its real bound',
    kb: 'KNOWN_ISSUES.md#bumper-music-mute-capped-at-eight-classes',
  },
  {
    id: 'cpp-findobject-unchecked',
    re: /FindObject(?:<[^>]+>)?\s*\([^;\n]*\)\s*->/g,
    severity: 'P3', confidence: 'POTENTIAL', component: 'reboot',
    title: 'FindObject(...) dereferenced without a null check',
    kb: 'memory: reboot-dll (unchecked FindObject derefs)',
  },
];

function staticCpp(ctx, F, cov) {
  const files = cppFiles(ctx);
  let hits = 0;
  for (const file of files) {
    const text = readText(file);
    if (!text) continue;
    const component = file.includes(`${path.sep}cobalt${path.sep}`) ? 'cobalt' : 'reboot';
    for (const p of CPP_PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(text))) {
        const ln = snippet(text, m.index);
        if (/^\s*\/\//.test(ln)) continue;                       // commented out
        if (p.id === 'cpp-invalid-escape' && /^\s*#\s*(include|pragma)/.test(ln)) continue;
        hits++;
        F.add({
          id: `native.${p.id}`, key: `native.${p.id}:${rel(ctx.repo, file)}:${lineOf(text, m.index)}`, module: M,
          component: p.component || component, category: 'source',
          severity: p.severity, confidence: p.confidence, title: p.title, kb: p.kb,
          evidence: [{ source: rel(ctx.repo, file), line: lineOf(text, m.index), excerpt: ln }],
        });
      }
    }
  }
  // trap8, as one number rather than ~300 rows: GetOffset returns 0 for a missing property, which
  // then points at the object's VTABLE. GetOffsetChecked exists for migration.
  let raw = 0, checked = 0;
  for (const f of files.filter(f => f.includes('Project Reboot'))) {
    const t = readText(f) || '';
    raw += (t.match(/->GetOffset\(|\.GetOffset\(|\bGetOffset\(/g) || []).length;
    checked += (t.match(/GetOffsetChecked\(/g) || []).length;
  }
  if (raw) {
    F.add({
      id: 'native.trap8-unchecked-offsets', module: M, component: 'reboot', category: 'source',
      severity: 'P2', confidence: 'CONFIRMED', count: raw,
      title: `${raw} GetOffset call sites in Reboot vs ${checked} GetOffsetChecked — a 0 offset reads the vtable`,
      explain: 'Three separate crashes came from this (QuickBars, the win-notify Place write, ApplyBackpack). Offsets::Report() lists which lookups miss at runtime; migrate those sites first.',
      kb: 'KNOWN_ISSUES.md#trap8-systemic-unguarded-offsets', data: { getOffset: raw, getOffsetChecked: checked },
    });
  }
  cov.push({ area: 'C++ static patterns', status: 'checked', detail: `${files.length} Cobalt/Reboot sources (vendored code excluded), ${CPP_PATTERNS.length} patterns, ${hits} matches` });
}

// ── consistency checks ────────────────────────────────────────────────────────────────────────────

function emitterDrift(ctx, F, cov) {
  // Cobalt and Reboot must ship byte-identical diagnostics emitters (DIAGNOSTICS_ARCHITECTURE §6).
  const pairs = ['diagnostics.cpp', 'diagnostics.h'].map(n => [path.join(ctx.paths.cobalt, 'Cobalt', n), path.join(ctx.paths.reboot, 'Project Reboot', n)]);
  const differ = pairs.filter(([a, b]) => exists(a) && exists(b) && md5(a) !== md5(b));
  cov.push({ area: 'shared diagnostics emitter (Cobalt vs Reboot)', status: 'checked', detail: differ.length ? `${differ.length} file(s) differ` : 'byte-identical' });
  for (const [a, b] of differ) {
    F.add({ id: 'native.emitter-drift', key: `native.emitter-drift:${path.basename(a)}`, module: M, component: 'cobalt', category: 'consistency',
      severity: 'P2', confidence: 'CONFIRMED', title: `${path.basename(a)} differs between Cobalt and Reboot`,
      explain: 'They must stay byte-identical or the dashboard loses the ability to compare a client failure with a host one. tests/build-and-run.cmd fails on this too.',
      evidence: [{ source: rel(ctx.repo, a), excerpt: md5(a) }, { source: rel(ctx.repo, b), excerpt: md5(b) }] });
  }
}

function staleTreeReferences(ctx, F, cov) {
  // Five Reboot checkouts exist on the dev PC; only Project-Reboot-DLL/ ships. References to the
  // out-of-repo `backends/_extracted` tree have caused two live bugs (KNOWN_ISSUES
  // reboot-authoritative-tree-was-not-the-one-referenced, reboot-dll-present-always-false-for-players).
  const files = [
    ...walk(ctx.paths.tools, n => /\.(mjs|js)$/.test(n)),
    ...walk(path.join(ctx.paths.tauri, 'src'), n => n.endsWith('.rs')),
    path.join(ctx.repo, 'RELEASING.md'), path.join(ctx.repo, 'BUILD_TARGETS.md'),
  ];
  let n = 0;
  for (const f of files) {
    const t = readText(f);
    if (!t) continue;
    const re = /backends[\\/]+_extracted[\\/]+Project-Reboot-main/g;
    let m;
    while ((m = re.exec(t))) {
      const ln = snippet(t, m.index);
      // Lines that only warn ABOUT the stale tree are fine.
      if (/not (?:the|what)|stale|NOT|wrong|fallback|DEV FALLBACK|do not|never/i.test(ln)) continue;
      n++;
      F.add({ id: 'native.stale-reboot-tree-reference', key: `native.stale-reboot-tree-reference:${rel(ctx.repo, f)}:${lineOf(t, m.index)}`, module: M,
        component: 'reboot', category: 'consistency', severity: 'P3', confidence: 'CONFIRMED',
        title: `${rel(ctx.repo, f)} points at the out-of-repo Reboot checkout`,
        explain: 'Only Project-Reboot-DLL/ in this repo produces what ships. A tool or doc reading the other tree silently describes a different gameserver.',
        kb: 'KNOWN_ISSUES.md#reboot-authoritative-tree-was-not-the-one-referenced',
        evidence: [{ source: rel(ctx.repo, f), line: lineOf(t, m.index), excerpt: ln }] });
    }
  }
  cov.push({ area: 'references to the stale Reboot tree', status: 'checked', detail: `${files.length} tool/launcher/doc files, ${n} live references` });
}

function forbiddenPayloadFiles(ctx, F, cov) {
  // stage-backend.mjs refuses these when STAGING, but --check never looks (tools exploration,
  // 2026-11-08). So check what is actually sitting in the payload and the installed copy.
  const roots = [['staged payload', ctx.paths.payload], ['installed launcher', ctx.paths.installedResources]];
  for (const [label, root] of roots) {
    if (!exists(root)) { cov.push({ area: `forbidden files: ${label}`, status: 'skipped', detail: 'not present' }); continue; }
    // The installed launcher's Backend-Coordinator/data is the local agent's RUNTIME state (its DB,
    // hotfixes generated from the live port) — not payload. Only the staged payload must lack it.
    const all = walk(root, () => true).filter(f => !/node_modules/.test(f))
      .filter(f => label !== 'installed launcher' || !/[\\/]Backend-Coordinator[\\/]data[\\/]/.test(f));
    const bad = all.filter(f => {
      const b = path.basename(f);
      if (/^\.env(\.|$)/.test(b) && b !== '.env.example') return true;
      if (/\.(key|pem|pfx)$/i.test(b)) return true;
      if (/\.(sqlite3?|db)$/i.test(b) && !/[\\/]data[\\/]nova\.db$/.test(f.replace(root, ''))) return true;
      if (/cloudstorage[\\/]DefaultEngine\.ini$/i.test(f)) return true;
      return false;
    });
    // A nova.db inside the installed launcher is its live local agent DB — expected there, never in the staged payload.
    const stagedDb = label === 'staged payload' ? all.filter(f => /[\\/]data[\\/][^\\/]*\.db$/i.test(f)) : [];
    const findings = [...bad, ...stagedDb];
    cov.push({ area: `forbidden files: ${label}`, status: 'checked', detail: `${all.length} files, ${findings.length} forbidden` });
    for (const f of findings) {
      F.add({ id: 'native.forbidden-payload-file', key: `native.forbidden-payload-file:${label}:${rel(root, f)}`, module: M, component: 'launcher', category: 'release',
        severity: /DefaultEngine/.test(f) ? 'P1' : 'P0', confidence: 'CONFIRMED',
        title: `${label} contains ${rel(root, f)}, which must never ship`,
        explain: /DefaultEngine/.test(f)
          ? 'A bundled cloudstorage DefaultEngine.ini wins permanently (seedCloudstorageDefaults never overwrites) and once pointed XMPP at a dead port (bundled-hotfix-wrong-xmpp-port).'
          : 'Secrets and live databases never go in the installer (RELEASING.md).',
        evidence: [{ source: f, excerpt: 'present' }] });
    }
  }
}

function nodeAbi(ctx, F, cov) {
  // The agent's SQLite driver is native: it must load under the node the launcher BUNDLES (v24,
  // ABI 137), not the developer's. A mismatch fails only on a player's machine, after install.
  for (const [label, root] of [['staged payload', ctx.paths.payload], ['installed launcher', ctx.paths.installedResources]]) {
    const node = path.join(root, 'node', 'node.exe');
    const mod = path.join(root, 'Backend-Coordinator', 'node_modules', 'better-sqlite3');
    if (!exists(node) || !exists(mod)) { cov.push({ area: `bundled node loads SQLite: ${label}`, status: 'skipped', detail: 'node.exe or better-sqlite3 not present' }); continue; }
    const r = run(node, ['-e', `const D=require(${JSON.stringify(mod)});const d=new D(':memory:');process.stdout.write(process.version+' abi '+process.versions.modules+' sqlite '+d.prepare('select sqlite_version() v').get().v)`]);
    cov.push({ area: `bundled node loads SQLite: ${label}`, status: 'checked', detail: r.ok ? r.stdout.trim() : `FAILED: ${r.stderr.trim().split('\n')[0]}` });
    if (!r.ok) {
      F.add({ id: 'native.bundled-node-cannot-load-sqlite', key: `native.bundled-node-cannot-load-sqlite:${label}`, module: M, component: 'backend', category: 'compatibility',
        severity: 'P0', confidence: 'CONFIRMED', title: `The ${label}'s bundled node cannot load better-sqlite3`,
        explain: 'The host agent would fail to open its database. Reinstall the module inside the payload with the bundled node (npm install --omit=dev) so the right ABI prebuild is fetched.',
        evidence: [{ source: node, excerpt: r.stderr.trim().slice(0, 300) }] });
    }
  }
}

function cobaltImports(ctx, F, cov) {
  // Cobalt replaces GFSDK_Aftermath_Lib.x64.dll and is resolved by the GAME's import table, so its
  // own import list must stay tiny. Adding ole32/shell32/winhttp statically is part of what crashed
  // the game in the 2026-07-25 rewrite; winmm is lazy-loaded on purpose.
  const dll = path.join(ctx.paths.cobalt, 'x64', 'Release', 'Cobalt.dll');
  if (!ctx.tools.dumpbin || !exists(dll)) { cov.push({ area: 'Cobalt import table', status: 'skipped', detail: !exists(dll) ? 'Cobalt.dll not built' : 'dumpbin not found' }); return; }
  const r = run(ctx.tools.dumpbin, ['/nologo', '/dependents', dll]);
  const deps = [...r.stdout.matchAll(/^\s+([\w.-]+\.dll)\s*$/gim)].map(m => m[1].toLowerCase());
  const forbidden = deps.filter(d => /^(ole32|shell32|winhttp|winmm|ws2_32|wininet|advapi32|user32)\.dll$/.test(d) && d !== 'user32.dll');
  cov.push({ area: 'Cobalt import table', status: 'checked', detail: `${deps.length} DLLs: ${deps.join(', ')}` });
  if (deps.length > 9 || forbidden.length) {
    F.add({ id: 'native.cobalt-imports-grew', module: M, component: 'cobalt', category: 'compatibility',
      severity: 'P1', confidence: 'CONFIRMED',
      title: forbidden.length ? `Cobalt statically imports ${forbidden.join(', ')}` : `Cobalt's import table grew to ${deps.length} DLLs (limit 9)`,
      explain: 'Cobalt loads through the game\'s own import table; enlarging that loader graph is its own crash risk. Resolve extras lazily with LoadLibrary/GetProcAddress.',
      evidence: [{ source: rel(ctx.repo, dll), excerpt: deps.join(', ') }], kb: 'memory: cobalt-component' });
  }
}

// ── backend route audit ───────────────────────────────────────────────────────────────────────────

/**
 * Nova's own API (/nova/api/*) routes that change state or expose cross-player data with no auth.
 * Epic-facing routes are exempt by design — the game calls them as it pleases.
 */
function routeAudit(ctx, F, cov) {
  const files = walk(path.join(ctx.paths.backend, 'src'), n => n.endsWith('.ts') && !n.endsWith('.test.ts'));
  const routes = [];
  for (const f of files) {
    const t = readText(f) || '';
    const re = /fastify\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]\s*,\s*(\{[^}]*\})?/g;
    let m;
    while ((m = re.exec(t))) {
      // The handler body: up to the next route registration, capped to keep this cheap.
      const next = t.indexOf('fastify.', m.index + 10);
      const body = t.slice(m.index, next < 0 ? m.index + 4000 : Math.min(next, m.index + 4000));
      routes.push({ file: f, line: lineOf(t, m.index), method: m[1].toUpperCase(), path: m[2], opts: m[3] || '', body });
    }
  }
  // Paths that are deliberately open, each for a stated reason.
  const OPEN_BY_DESIGN = [
    [/^\/nova\/api\/diagnostics\/local$/, 'localhost-only ingest for the DLLs (DIAGNOSTICS_ARCHITECTURE §2)'],
    [/^\/nova\/api\/diagnostics\/pending$/, 'localhost hand-off to the launcher (diagreport.rs)'],
    [/^\/nova\/api\/gameserver\/(register|unregister)$/, 'accepted-open; gated by NOVA_REGISTER_SECRET once the field signs (KNOWN_ISSUES)'],
    [/^\/nova\/api\/(info|components|news|status|version)/, 'public status'],
    [/^\/nova\/api\/launcher\/(register|login|available)$/, 'account creation/sign-in'],
    [/^\/nova\/api\/session\//, 'listen-server back-compat'],
    [/^\/nova\/api\/dashboard\/(login|logout)$/, 'the sign-in form itself (it checks the admin secret in the body)'],
  ];
  // authenticateLauncher = the route checks the account's current password in the body (rate-limited).
  const authed = r => /requireAuth|adminOk\(|adminRefused|registerGateRefuses|verifyToken|isLoopback|remoteAddress|x-nova-admin|authenticateLauncher\(/.test(r.opts + r.body);
  const sensitive = r => r.method !== 'GET' || /diagnostics|incidents|logs|anticheat|host\/|dashboard|launcher\/me|register-secret|tailnet/.test(r.path);
  let open = 0;
  for (const r of routes.filter(r => r.path.startsWith('/nova/api/'))) {
    if (authed(r) || !sensitive(r)) continue;
    const design = OPEN_BY_DESIGN.find(([re]) => re.test(r.path));
    if (design) continue;
    open++;
    F.add({
      id: 'native.route-without-auth', key: `native.route-without-auth:${r.method} ${r.path}`, module: M, component: 'backend', category: 'security',
      severity: r.method === 'DELETE' || r.method === 'POST' ? 'P1' : 'P2', confidence: 'PROBABLE',
      title: `${r.method} ${r.path} has no authentication`,
      explain: 'On players\' machines nova-proxy keeps local-control routes on loopback, but on the coordinator EVERY path is published to the internet through Tailscale Funnel (:8443 → 3551) — and Funnel traffic arrives from 127.0.0.1, so a loopback check cannot tell the two apart. Graded PROBABLE: the check reads the handler, and an auth step done elsewhere would not be seen.',
      evidence: [{ source: rel(ctx.repo, r.file), line: r.line, excerpt: `fastify.${r.method.toLowerCase()}('${r.path}'${r.opts ? ', ' + r.opts.replace(/\s+/g, ' ') : ''}` }],
      data: { method: r.method, path: r.path },
    });
  }
  cov.push({ area: 'backend route auth audit', status: 'checked', detail: `${routes.length} routes, ${routes.filter(r => r.path.startsWith('/nova/api/')).length} Nova API routes, ${open} sensitive without auth` });
}

// ── --build: compile and READ the diagnostics ─────────────────────────────────────────────────────

const MSVC_GRADES = {
  C4129: ['P2', 'unrecognised escape — the backslash is dropped (the bumper off-switch bug)'],
  C4172: ['P1', 'returns the address of a local or temporary'],
  C4700: ['P2', 'uninitialised local variable used'], C4701: ['P2', 'potentially uninitialised local used'],
  C4703: ['P2', 'potentially uninitialised pointer used'], C4715: ['P2', 'not all control paths return a value'],
  C4834: ['P3', 'discarding a [[nodiscard]] result'], C4996: ['P3', 'deprecated API'],
};

function msbuild(ctx, F, cov, name, sln, component) {
  if (!ctx.tools.msbuild || !exists(sln)) { cov.push({ area: `build: ${name}`, status: 'skipped', detail: !exists(sln) ? 'solution missing' : 'MSBuild not found' }); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `nova-doctor-${name}-`));
  const r = run(ctx.tools.msbuild, [sln, '/t:Rebuild', '/p:Configuration=Release', '/p:Platform=x64', `/p:OutDir=${tmp}\\out\\`, `/p:IntDir=${tmp}\\obj\\`, '/v:minimal', '/nologo', '/clp:NoSummary'], { timeout: 1_200_000 });
  const lines = (r.stdout + r.stderr).split(/\r?\n/);
  const diags = new Map();
  for (const l of lines) {
    const m = /^\s*(.+?)\((\d+)(?:,\d+)?\):\s*(warning|error)\s+(C\d{4}|LNK\d{4}|MSB\d{4}):\s*(.+?)(?:\s*\[.*\])?$/.exec(l);
    if (!m) continue;
    const [, file, line, kind, code, msg] = m;
    const k = `${code}:${path.basename(file)}:${line}`;
    if (!diags.has(k)) diags.set(k, { file, line: Number(line), kind, code, msg });
  }
  const errors = [...diags.values()].filter(d => d.kind === 'error');
  const warnings = [...diags.values()].filter(d => d.kind === 'warning');
  cov.push({ area: `build: ${name}`, status: 'checked', detail: `${r.ok ? 'built' : 'FAILED'} in ${Math.round(r.ms / 1000)}s to a temp dir; ${errors.length} errors, ${warnings.length} distinct warnings` });
  if (!r.ok && !errors.length) {
    F.add({ id: 'native.build-failed', key: `native.build-failed:${name}`, module: M, component, category: 'build', severity: 'P1', confidence: 'CONFIRMED',
      title: `${name} failed to build`, evidence: [{ source: sln, excerpt: lines.filter(Boolean).slice(-6).join(' | ') }] });
  }
  for (const d of [...errors, ...warnings]) {
    const [sev, why] = d.kind === 'error' ? ['P1', 'compile/link error'] : (MSVC_GRADES[d.code] || ['P3', 'compiler warning']);
    F.add({ id: `native.msvc-${d.kind}`, key: `native.msvc:${name}:${d.code}:${path.basename(d.file)}:${d.line}`, module: M, component, category: 'build',
      severity: sev, confidence: 'CONFIRMED', title: `${name}: ${d.code} ${why}`,
      evidence: [{ source: rel(ctx.repo, d.file), line: d.line, excerpt: d.msg }] });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

function cargoCheck(ctx, F, cov) {
  const r = run(ctx.tools.cargo, ['check', '--message-format=short'], { cwd: ctx.paths.tauri, timeout: 1_200_000 });
  const out = r.stdout + r.stderr;
  const diags = [...out.matchAll(/^(src[\\/][^:]+):(\d+):\d+:\s*(warning|error)(?:\[(\w+)\])?:\s*(.+)$/gm)];
  cov.push({ area: 'build: launcher (cargo check)', status: 'checked', detail: `${r.ok ? 'ok' : 'FAILED'} in ${Math.round(r.ms / 1000)}s; ${diags.length} diagnostics` });
  for (const d of diags) {
    F.add({ id: `native.rust-${d[3]}`, key: `native.rust:${d[1]}:${d[2]}:${d[5].slice(0, 60)}`, module: M, component: 'launcher', category: 'build',
      severity: d[3] === 'error' ? 'P1' : 'P3', confidence: 'CONFIRMED', title: `launcher: ${d[3]} ${d[5].slice(0, 100)}`,
      evidence: [{ source: `Launcher/src-tauri/${d[1].replace(/\\/g, '/')}`, line: Number(d[2]), excerpt: d[5] }] });
  }
  if (!r.ok && !diags.length) F.add({ id: 'native.rust-build-failed', module: M, component: 'launcher', category: 'build', severity: 'P1', confidence: 'CONFIRMED', title: 'cargo check failed', evidence: [{ source: 'Launcher/src-tauri', excerpt: out.trim().split('\n').slice(-5).join(' | ') }] });
}

function tscCheck(ctx, F, cov) {
  if (!ctx.tools.tscJs) { cov.push({ area: 'build: backend (tsc)', status: 'skipped', detail: 'typescript not installed in Main backend' }); return; }
  const r = run(ctx.tools.node, [ctx.tools.tscJs, '--noEmit', '-p', 'tsconfig.json'], { cwd: ctx.paths.backend, timeout: 600_000 });
  const diags = [...(r.stdout + r.stderr).matchAll(/^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/gm)];
  cov.push({ area: 'build: backend (tsc --noEmit)', status: 'checked', detail: `${r.ok ? 'clean' : 'FAILED'}; ${diags.length} errors` });
  for (const d of diags) {
    F.add({ id: 'native.ts-error', key: `native.ts:${d[1]}:${d[2]}:${d[3]}`, module: M, component: 'backend', category: 'build',
      severity: 'P1', confidence: 'CONFIRMED', title: `backend: ${d[3]} ${d[4].slice(0, 100)}`,
      evidence: [{ source: `Main backend/${d[1]}`, line: Number(d[2]), excerpt: d[4] }] });
  }
}

export default {
  id: M,
  title: 'Source & build analyzer',
  async run(ctx, F, opts) {
    const cov = [];
    staticCpp(ctx, F, cov);
    emitterDrift(ctx, F, cov);
    staleTreeReferences(ctx, F, cov);
    forbiddenPayloadFiles(ctx, F, cov);
    nodeAbi(ctx, F, cov);
    cobaltImports(ctx, F, cov);
    routeAudit(ctx, F, cov);
    if (opts.build) {
      tscCheck(ctx, F, cov);
      cargoCheck(ctx, F, cov);
      msbuild(ctx, F, cov, 'Cobalt', path.join(ctx.paths.cobalt, 'Cobalt.sln'), 'cobalt');
      msbuild(ctx, F, cov, 'Reboot', path.join(ctx.paths.reboot, 'Project Reboot.sln'), 'reboot');
    } else {
      cov.push({ area: 'builds (tsc, cargo, MSBuild)', status: 'skipped', detail: 'pass --build to compile everything and read the warnings' });
    }
    return { coverage: cov };
  },
};
