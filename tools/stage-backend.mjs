#!/usr/bin/env node
/**
 * Stage `Main backend` into the launcher installer payload — and refuse to let it silently rot.
 *
 * WHY THIS EXISTS
 * ---------------
 * The launcher ships a COMPILED copy of the backend at
 * `Launcher/src-tauri/resources/Backend-Coordinator/dist`, and `start_backend` in `main.rs` prefers
 * `dist/` over sources. So that copy — not `Main backend/src` — is what an installed launcher
 * actually runs as its local host agent.
 *
 * Keeping it current was a manual copy step in RELEASING.md §2. On 2026-09-05 the shipped bundle
 * was dated 1 August while the source had moved on by a month, which meant releases 1.5.x had been
 * shipping a backend that was missing, among other things:
 *
 *   - `services/nova/diagnostics.js`      the entire diagnostics subsystem (absent from the bundle)
 *   - `services/compat/latent.routes.js`  the 38 latent client endpoints (absent from the bundle)
 *   - the friends ownership guard         NOVA-AUDIT-007, a confirmed P1
 *   - the MCP `readOnly` guard            `mcp-unauth-mutation`, a confirmed P1
 *   - URL redaction in the request log    NOVA-AUDIT-001, a confirmed P1
 *
 * All three P1s were recorded as FIXED, and are — in source, and on the coordinator, which runs
 * `tsx src/` rather than this bundle. They had simply never reached an installed launcher. The
 * blast radius is bounded (`Config.HOST` is hard-coded to `127.0.0.1`, so the host agent is not
 * reachable off the machine) but "the fix shipped" was not true, and no test said so.
 *
 * A step that a human has to remember, across nine releases, is not a process. This is.
 *
 * USAGE
 *   node tools/stage-backend.mjs           compile and stage (use before building an installer)
 *   node tools/stage-backend.mjs --check   verify only; exit 1 if the bundle is stale
 *
 * `--check` is the one to wire into a release script or CI: it is fast, makes no changes, and turns
 * a silent month-old payload into a loud failure.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'Main backend', 'src');
const BUILT_DIR = path.join(ROOT, 'Main backend', 'dist');
const BUNDLE_DIR = path.join(ROOT, 'Launcher', 'src-tauri', 'resources', 'Backend-Coordinator', 'dist');
const BACKEND_DIR = path.join(ROOT, 'Main backend');

const checkOnly = process.argv.includes('--check');

/** Newest mtime under `dir`, ignoring tests and sourcemaps. */
function newestMtime(dir, filter = () => true) {
  let newest = 0;
  let newestFile = null;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!filter(full)) continue;
      const m = fs.statSync(full).mtimeMs;
      if (m > newest) { newest = m; newestFile = full; }
    }
  };
  walk(dir);
  return { newest, newestFile };
}

const isShippedSource = (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts');
const isJs = (f) => f.endsWith('.js');

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }

function describeStaleness() {
  const src = newestMtime(SRC_DIR, isShippedSource);
  const bundle = newestMtime(BUNDLE_DIR, isJs);
  if (!bundle.newest) return { stale: true, why: 'the bundle does not exist yet', src, bundle };
  if (src.newest > bundle.newest) {
    const days = Math.floor((src.newest - bundle.newest) / 86_400_000);
    return {
      stale: true,
      why: `the bundle is ${days} day(s) behind the source (newest source: ${rel(src.newestFile)})`,
      src, bundle,
    };
  }
  return { stale: false, why: 'up to date', src, bundle };
}

/** Modules whose ABSENCE from the bundle has previously shipped a security fix into a black hole. */
const MUST_BE_PRESENT = [
  'services/nova/diagnostics.js',
  'services/compat/latent.routes.js',
];

function missingModules() {
  return MUST_BE_PRESENT.filter((m) => !fs.existsSync(path.join(BUNDLE_DIR, m)));
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ── check mode ──────────────────────────────────────────────────────────────────────────────────
if (checkOnly) {
  const { stale, why } = describeStaleness();
  const missing = missingModules();
  if (stale || missing.length) {
    console.error('[stage-backend] STALE INSTALLER PAYLOAD');
    console.error(`[stage-backend]   ${why}`);
    for (const m of missing) console.error(`[stage-backend]   missing module: ${m}`);
    console.error(`[stage-backend] Run: node tools/stage-backend.mjs`);
    console.error('[stage-backend] Shipping now would install a backend older than the source.');
    process.exit(1);
  }
  console.log(`[stage-backend] bundle is up to date (${rel(BUNDLE_DIR)})`);
  process.exit(0);
}

// ── stage mode ──────────────────────────────────────────────────────────────────────────────────
console.log('[stage-backend] compiling Main backend -> dist/ ...');
// Run the compiler's own JS entrypoint under this Node rather than going through `npx`. On Windows
// `npx` is a .cmd and `execFileSync` cannot spawn one without a shell (EINVAL), and a shell would
// drag in quoting rules for a repo path that contains a space. This form has neither problem.
const TSC = path.join(BACKEND_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(TSC)) {
  console.error(`[stage-backend] TypeScript not installed at ${rel(TSC)} — run \`npm install\` in "Main backend" first`);
  process.exit(1);
}
execFileSync(process.execPath, [TSC, '-p', 'tsconfig.build.json'], {
  cwd: BACKEND_DIR,
  stdio: 'inherit',
});

if (!fs.existsSync(path.join(BUILT_DIR, 'index.js'))) {
  console.error('[stage-backend] compile produced no dist/index.js — refusing to stage');
  process.exit(1);
}

// Replace rather than merge. A merge leaves behind modules that were deleted or renamed upstream,
// and a stale orphan in the payload is exactly the class of problem this script exists to end.
console.log(`[stage-backend] staging -> ${rel(BUNDLE_DIR)}`);
fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
copyDir(BUILT_DIR, BUNDLE_DIR);

const missing = missingModules();
if (missing.length) {
  console.error('[stage-backend] staged bundle is missing expected modules:');
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

// Never ship live data or secrets. RELEASING.md records that `data/nova.db` — a real account
// database — once made it into a build because a test run created it inside the staging folder.
//
// Match on FILES, not directory names. RELEASING.md says "never ship data/", but that is shorthand:
// `Backend-Coordinator/data/cloudstorage/*.ini` is the bundled hotfix payload and is *supposed* to
// ship — standalone/LAN mode serves those files. Blocking the directory flagged them as a leak on
// the first run of this script. What must never ship is the database and anything secret.
const isForbiddenFile = (name) =>
  name === '.env' ||
  /\.(db|db-wal|db-shm|sqlite|sqlite3|log)$/i.test(name) ||
  /\.(key|pem|pfx)$/i.test(name) ||
  // DefaultEngine.ini must NOT be bundled — it must be GENERATED.
  //
  // It carries the XMPP address, and `seedCloudstorageDefaults()` writes it from the port the
  // backend is actually listening on. That function deliberately never overwrites an existing file,
  // so a bundled copy wins permanently and the generated-from-the-real-port guarantee is void.
  //
  // The bundled copy said `ServerPort=3596`. Nothing listens there in either mode — standalone is
  // 3551, agent mode 3552 — so in standalone/LAN the client got an XMPP address pointing at nothing
  // and force-logged-out ~400ms after a successful login, reporting "Fortnite was not started
  // correctly". That exact symptom has been chased twice before from two different causes; see the
  // comment on seedCloudstorageDefaults.
  //
  // The other three hotfix .ini files carry no port and are fine to ship.
  name === 'DefaultEngine.ini';

const resources = path.join(ROOT, 'Launcher', 'src-tauri', 'resources');
const leaked = [];
const scanForLeaks = (dir, depth = 0) => {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') scanForLeaks(full, depth + 1);
    } else if (isForbiddenFile(e.name)) {
      leaked.push(rel(full));
    }
  }
};
scanForLeaks(resources);
if (leaked.length) {
  console.error('[stage-backend] REFUSING TO SHIP — files that must not be in the payload:');
  for (const l of leaked) {
    // Two different reasons land here and they need different remedies, so say which.
    const why = path.basename(l) === 'DefaultEngine.ini'
      ? 'must be GENERATED from the live port by seedCloudstorageDefaults(), not bundled — delete it'
      : 'live data or a secret — delete it and check how it got there';
    console.error(`  - ${l}`);
    console.error(`      ${why}`);
  }
  process.exit(1);
}

const count = (function countJs(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    n += e.isDirectory() ? countJs(f) : (e.name.endsWith('.js') ? 1 : 0);
  }
  return n;
})(BUNDLE_DIR);

console.log(`[stage-backend] staged ${count} modules. Bundle is now current.`);
