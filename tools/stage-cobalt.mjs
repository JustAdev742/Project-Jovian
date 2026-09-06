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
 * USAGE
 *   node tools/stage-cobalt.mjs           # copy the build output everywhere it is consumed
 *   node tools/stage-cobalt.mjs --check   # exit 1 if any consumed copy differs from the build
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'Launcher', 'cobalt', 'x64', 'Release', 'Cobalt.dll');

/**
 * Every path that can win `carter.rs`'s resolution, in the order it tries them.
 * `required` marks the ones whose absence is itself a bug rather than just an unbuilt tree.
 */
const TARGETS = [
  { p: path.join(ROOT, 'Launcher', 'src-tauri', 'resources', 'Cobalt.dll'),                    required: true,  why: 'bundled by tauri.conf.json — what an INSTALLED launcher loads' },
  { p: path.join(ROOT, 'Launcher', 'src-tauri', 'Cobalt.dll'),                                 required: false, why: 'loose dev-tree copy' },
  { p: path.join(ROOT, 'Launcher', 'src-tauri', 'target', 'release', 'Cobalt.dll'),            required: false, why: 'beside the dev exe — what a DEV-TREE launcher loads first' },
  { p: path.join(ROOT, 'Launcher', 'src-tauri', 'target', 'release', 'resources', 'Cobalt.dll'), required: false, why: 'resources beside the dev exe' },
  { p: path.join(ROOT, 'Launcher', 'src-tauri', 'target', 'debug', 'Cobalt.dll'),              required: false, why: 'beside the debug exe' },
];

const rel = (p) => path.relative(ROOT, p).split(String.fromCharCode(92)).join("/");
const hash = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 12);

if (!fs.existsSync(SOURCE)) {
  console.error(`[stage-cobalt] no build output at ${rel(SOURCE)}`);
  console.error('[stage-cobalt] Build it first:  cd Launcher/cobalt && ./build.ps1');
  process.exit(1);
}

const checkOnly = process.argv.includes('--check');
const want = hash(SOURCE);
const stat = fs.statSync(SOURCE);
console.log(`[stage-cobalt] built  ${want}  ${stat.size} bytes  ${stat.mtime.toISOString().slice(0, 16)}`);

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
    console.error(`[stage-cobalt] STALE  ${detail}  ${rel(t.p)}`);
    console.error(`[stage-cobalt]        ${t.why}`);
    stale++;
    continue;
  }

  fs.mkdirSync(path.dirname(t.p), { recursive: true });
  fs.copyFileSync(SOURCE, t.p);
  console.log(`[stage-cobalt] staged ${rel(t.p)}`);
  copied++;
}

if (checkOnly) {
  if (stale) {
    console.error(`[stage-cobalt] ${stale} consumed copy/copies differ from the build output.`);
    console.error('[stage-cobalt] Run: node tools/stage-cobalt.mjs');
    console.error('[stage-cobalt] Shipping now would load a Cobalt older than the one just built.');
    process.exit(1);
  }
  console.log('[stage-cobalt] every consumed copy matches the build output');
  process.exit(0);
}

console.log(copied ? `[stage-cobalt] ${copied} copy/copies updated.` : '[stage-cobalt] nothing to do.');
