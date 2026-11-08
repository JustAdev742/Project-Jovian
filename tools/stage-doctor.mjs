#!/usr/bin/env node
/**
 * Copy the doctor into the installer payload (Launcher/src-tauri/resources/doctor), where an
 * installed launcher runs it as `nova-doctor live` on every player's PC.
 *
 * WHY A SCRIPT WITH A --check: every artefact built in one place and loaded from another has gone
 * stale here — the backend payload, Cobalt, Project Reboot (RELEASING.md). The rule this project
 * learned is to add the --check in the same commit as the artefact. This is that.
 *
 *   node tools/stage-doctor.mjs           copy doctor/{nova-doctor.mjs, lib, modules, rules}
 *   node tools/stage-doctor.mjs --check   exit 1 if any staged file differs from the source
 *
 * Tests and reports (doctor/test, doctor/out) are never shipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(repo, 'doctor');
const dst = path.join(repo, 'Launcher', 'src-tauri', 'resources', 'doctor');
const SHIP = ['nova-doctor.mjs', 'lib', 'modules', 'rules'];
const check = process.argv.includes('--check');

function files(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...files(root, r));
    else if (e.name.endsWith('.mjs')) out.push(r);
  }
  return out;
}
const md5 = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

const wanted = SHIP.flatMap(s => (fs.statSync(path.join(src, s)).isDirectory() ? files(src, s) : [s]));

if (check) {
  const stale = [];
  for (const f of wanted) {
    const d = path.join(dst, f);
    if (!fs.existsSync(d)) stale.push(`MISSING ${f}`);
    else if (md5(d) !== md5(path.join(src, f))) stale.push(`STALE   ${f}`);
  }
  const extra = fs.existsSync(dst) ? files(dst).filter(f => !wanted.includes(f)) : [];
  for (const f of extra) stale.push(`EXTRA   ${f} (no longer in doctor/)`);
  if (stale.length) {
    console.error(`[stage-doctor] STALE INSTALLER PAYLOAD — run node tools/stage-doctor.mjs\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`[stage-doctor] ${wanted.length} files, staged copy matches doctor/`);
  process.exit(0);
}

fs.rmSync(dst, { recursive: true, force: true });
for (const f of wanted) {
  const d = path.join(dst, f);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(path.join(src, f), d);
}
console.log(`[stage-doctor] staged ${wanted.length} files -> ${path.relative(repo, dst)}`);
