#!/usr/bin/env node
/**
 * Copy the freshly built Cobalt.dll to every place that actually loads one.
 *
 * WHY THIS EXISTS. Cobalt is built to `Launcher/cobalt/x64/Release/Cobalt.dll`, but nothing loads it
 * from there by preference. `carter.rs` resolves the DLL with `beside_exe("Cobalt.dll")` FIRST, and
 * only falls back to the build output if that finds nothing — and it always finds something. So the
 * build output is the one copy guaranteed NOT to be used.
 *
 * Measured 2026-09-06, three different builds were live in the tree at once:
 *
 *   a62d20cc  2026-09-06  cobalt/x64/Release/            just built, loaded by nobody
 *   22c87f01  2026-09-05  src-tauri/resources/           what release 1.6.0 shipped
 *   84622a61  2026-07-25  src-tauri/target/release/      SIX WEEKS STALE — and this is the one a
 *                                                        dev-tree launcher actually loads
 *
 * This is the same failure as the backend payload (see tools/stage-backend.mjs and
 * REGRESSION_HISTORY.md): the build writes one path, the runtime reads another, and nothing compares
 * them. "Rebuilt Cobalt" and "the game loads the rebuilt Cobalt" were never the same statement.
 *
 * BOTH NATIVE DLLs, same machinery. Reboot has the identical defect: the launcher injects the copy
 * beside the exe, so the dev machine ran a 26 July build while players got the 5 September bundle.
 * Its authoritative source is Project-Reboot-DLL/ IN THIS REPO — not any of the four other Project
 * Reboot checkouts under Documents/backends/, none of which is what ships.
 *
 * USAGE
 *   node tools/stage-cobalt.mjs                  # Cobalt: copy the build output everywhere
 *   node tools/stage-cobalt.mjs --check          # Cobalt: exit 1 if any consumed copy differs
 *   node tools/stage-cobalt.mjs reboot           # same, for Project Reboot.dll
 *   node tools/stage-cobalt.mjs reboot --check
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPONENT = process.argv.find((a) => a === 'reboot') ? 'reboot' : 'cobalt';

/**
 * The two native DLLs, and every path that can win the launcher's resolution for each.
 *
 * BOTH have had the same defect, found on the same day. `beside_exe()` in host.rs is asked FIRST for
 * both, so in a dev tree the copy beside the exe wins and the build output is the one guaranteed not
 * to load. Measured 2026-09-06:
 *
 *   Cobalt  — three live builds, the one a dev launcher loaded was SIX WEEKS old
 *   Reboot  — the one a dev launcher injects is from 26 July; players get the 5 September bundle
 *
 * `required` marks paths whose absence is itself a bug rather than merely an unbuilt tree.
 */
const T = (...seg) => path.join(ROOT, 'Launcher', 'src-tauri', ...seg);

/**
 * Pick the most recently written of several candidate build outputs, and report when they disagree.
 *
 * Returns the first path when none exist, so the "no build output" message names something sensible.
 */
function newestOf(candidates) {
  const found = candidates
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (found.length === 0) return candidates[0];
  if (found.length > 1) {
    console.log(`[stage] NOTE: ${found.length} build outputs exist for this component; using the newest.`);
    for (const f of found) {
      console.log(`[stage]   ${new Date(f.t).toISOString().slice(0, 16)}  ${path.relative(ROOT, f.p).split(String.fromCharCode(92)).join('/')}`);
    }
  }
  return found[0].p;
}

const COMPONENTS = {
  cobalt: {
    source: path.join(ROOT, 'Launcher', 'cobalt', 'x64', 'Release', 'Cobalt.dll'),
    build: 'cd Launcher/cobalt && ./build.ps1',
    targets: [
      { p: T('resources', 'Cobalt.dll'),                       required: true,  why: 'bundled by tauri.conf.json — what an INSTALLED launcher loads' },
      { p: T('Cobalt.dll'),                                    required: false, why: 'loose dev-tree copy' },
      { p: T('target', 'release', 'Cobalt.dll'),               required: false, why: 'beside the dev exe — what a DEV-TREE launcher loads FIRST' },
      { p: T('target', 'release', 'resources', 'Cobalt.dll'),  required: false, why: 'resources beside the dev exe' },
      { p: T('target', 'debug', 'Cobalt.dll'),                 required: false, why: 'beside the debug exe' },
    ],
  },
  reboot: {
    // The authoritative tree is IN THIS REPO. There are four other Project Reboot checkouts under
    // Documents/backends/ and none of them is what ships — a fact that cost real time to establish,
    // and which host.rs's DEFAULT_REBOOT_DLL still pointed at.
    // TWO OUTPUT PATHS IN ONE TREE, and they disagree. A solution-level build
    // (`msbuild "Project Reboot.sln"`) writes to `Project-Reboot-DLL/x64/Release/`, while a
    // project-level build writes to `Project-Reboot-DLL/Project Reboot/x64/Release/`. Whoever cut
    // the 5 September build used the second; the documented command produces the first. Hardcoding
    // either one silently stages a stale DLL depending on how it was built — which is this project's
    // signature failure, now for the fourth time.
    //
    // Take the NEWEST of the two and say so when they differ, rather than pretending there is one.
    source: newestOf([
      path.join(ROOT, 'Project-Reboot-DLL', 'x64', 'Release', 'Project Reboot.dll'),
      path.join(ROOT, 'Project-Reboot-DLL', 'Project Reboot', 'x64', 'Release', 'Project Reboot.dll'),
    ]),
    build: 'msbuild "Project-Reboot-DLL/Project Reboot.sln" /p:Configuration=Release /p:Platform=x64',
    targets: [
      { p: T('resources', 'Project Reboot.dll'),                      required: true,  why: 'bundled by tauri.conf.json — what an INSTALLED launcher injects' },
      { p: T('target', 'release', 'Project Reboot.dll'),              required: false, why: 'beside the dev exe — what a DEV-TREE launcher injects FIRST' },
      { p: T('target', 'release', 'resources', 'Project Reboot.dll'), required: false, why: 'resources beside the dev exe' },
      { p: T('target', 'debug', 'resources', 'Project Reboot.dll'),   required: false, why: 'resources beside the debug exe' },
    ],
  },
};

const SOURCE = COMPONENTS[COMPONENT].source;
const TARGETS = COMPONENTS[COMPONENT].targets;

const rel = (p) => path.relative(ROOT, p).split(String.fromCharCode(92)).join("/");
const hash = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 12);

if (!fs.existsSync(SOURCE)) {
  console.error(`[stage-${COMPONENT}] no build output at ${rel(SOURCE)}`);
  console.error(`[stage-${COMPONENT}] Build it first:  ${COMPONENTS[COMPONENT].build}`);
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');
const want = hash(SOURCE);
const stat = fs.statSync(SOURCE);
console.log(`[stage-${COMPONENT}] built  ${want}  ${stat.size} bytes  ${stat.mtime.toISOString().slice(0, 16)}`);

let stale = 0;
let copied = 0;

for (const t of TARGETS) {
  const exists = fs.existsSync(t.p);

  if (!exists && !t.required) continue;             // an unbuilt target is not a defect
  if (exists && hash(t.p) === want) continue;       // already current

  if (checkOnly) {
    const detail = exists
      ? `${hash(t.p)}  ${fs.statSync(t.p).mtime.toISOString().slice(0, 10)}`
      : 'MISSING';
    console.error(`[stage-${COMPONENT}] STALE  ${detail}  ${rel(t.p)}`);
    console.error(`[stage-${COMPONENT}]        ${t.why}`);
    stale++;
    continue;
  }

  fs.mkdirSync(path.dirname(t.p), { recursive: true });
  fs.copyFileSync(SOURCE, t.p);
  console.log(`[stage-${COMPONENT}] staged ${rel(t.p)}`);
  copied++;
}

if (checkOnly) {
  if (stale) {
    console.error(`[stage-${COMPONENT}] ${stale} consumed copy/copies differ from the build output.`);
    console.error(`[stage-${COMPONENT}] Run: node tools/stage-cobalt.mjs${COMPONENT === 'cobalt' ? '' : ' ' + COMPONENT}`);
    console.error(`[stage-${COMPONENT}] Shipping now would load a ${COMPONENT} older than the one just built.`);
    process.exit(1);
  }
  console.log(`[stage-${COMPONENT}] every consumed copy matches the build output`);
  process.exit(0);
}

console.log(
  copied
    ? `[stage-${COMPONENT}] ${copied} copy/copies updated.`
    : `[stage-${COMPONENT}] nothing to do.`,
);
