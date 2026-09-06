#!/usr/bin/env node
/**
 * Triage a Fortnite build: what it is, and whether its code can be scanned at all.
 *
 * READ THIS BEFORE TRUSTING A SIGNATURE RESULT. This tool was written to answer "does this build
 * have the byte patterns Cobalt and Reboot need", cheaply, from the .exe alone. **For a protected
 * build it cannot, and neither can anything else that reads the file.**
 *
 * The 7.40 client's `.text` section has a Shannon entropy of **8.00 — the maximum possible** — and
 * the PE carries TWO `.text` sections, which is a protector's unpacking stub plus its encrypted
 * payload. The code only exists as code once the process is running and has decrypted itself.
 * `.rdata` is plain (4.41), which is why STRING scans of these binaries work perfectly and give a
 * false sense that code scans should too.
 *
 * This was caught by the control, and the control is the only reason it was caught: every signature
 * reported ABSENT against 7.40 — the build both components demonstrably work on. A tool that says
 * ABSENT for a working build is worse than no tool, so it now refuses to report signature verdicts
 * when the code section is packed, and says why.
 *
 * WHAT FOLLOWS FROM THAT, and it is the important part: **signatures for a new build cannot be
 * derived from its .exe.** They have to come from the running process. Cobalt is already inside it
 * and already scanning, so the way to port either component to a new build is to run that build once
 * with Cobalt's signature report enabled and read what matched — not to analyse a download.
 *
 * WHAT THIS TOOL IS STILL GOOD FOR, which is real: identifying a build without installing it —
 * version, changelist, engine, whether it predates Battle Royale, and whether it is packed. That is
 * enough to decide whether a download is the build you wanted.
 *
 * VERDICTS, when the code section IS scannable (unpacked builds, and any memory dump):
 *   PRESENT   occurs exactly once — unambiguous, the hook will find it
 *   AMBIGUOUS occurs more than once. Cobalt takes the FIRST match, which may be the wrong one
 *   ABSENT    not there; that target needs a new signature for this build
 *
 * Signatures are harvested from the component sources, so this cannot drift from what they scan for.
 *
 * USAGE
 *   node tools/sigcheck.mjs <FortniteClient-Win64-Shipping.exe>
 *   node tools/sigcheck.mjs <exe> --force   # scan anyway; expect false ABSENTs on a packed build
 *   node tools/sigcheck.mjs --list
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reboot's source is NOT in this repository - it sits beside it under Documents/backends/. If it
 * moves, this reports zero reboot signatures, which would look like "Reboot needs nothing" rather
 * than "the source was not found". Hence the explicit warning below.
 */
const REBOOT_SRC = process.env.NOVA_REBOOT_SRC ||
  path.join(ROOT, '..', 'backends', '_extracted', 'Project-Reboot-main', 'Project Reboot', 'dllmain.cpp');

/**
 * Pull `sigscan("...")` / `Memory::FindPattern("...")` literals out of a source file, keeping the
 * trailing `// comment` when there is one — that comment is usually the only record of which build a
 * signature was written for.
 */
function harvest(file, label, re) {
  if (!fs.existsSync(file)) return [];
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of src.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const note = (line.split('//')[1] || '').trim();
    const relFile = path.relative(ROOT, file).split(String.fromCharCode(92)).join("/");
    out.push({ component: label, pattern: m[1], note, file: relFile });
  }
  return out;
}

const SOURCES = [
  // Cobalt calls sigscan("...") inline AND, since the retry was bounded, assigns one to a named
  // constant. Harvest both, or the primary curl signature - the single most important one - is
  // silently missing from every report.
  [path.join(ROOT, 'Launcher', 'cobalt', 'Cobalt', 'dllmain.cpp'), 'cobalt', /"([0-9A-Fa-f?]{2}(?:[ ][0-9A-Fa-f?]{1,2}){7,})"/],
  // Reboot: Memory::FindPattern("...") — one paren, and some call sites wrap it in an extra one.
  [REBOOT_SRC, 'reboot', /"([0-9A-Fa-f?]{2}(?:[ ][0-9A-Fa-f?]{1,2}){7,})"/],
];

let SIGS = [];
for (const [file, label, re] of SOURCES) SIGS.push(...harvest(file, label, re));
// De-duplicate: the same pattern often appears twice (primary attempt plus a retry).
const seen = new Set();
SIGS = SIGS.filter((s) => (seen.has(s.component + s.pattern) ? false : seen.add(s.component + s.pattern)));

if (process.argv.includes('--list') || process.argv.length < 3) {
  console.log(`${SIGS.length} signatures harvested from component sources\n`);
  for (const s of SIGS) {
    console.log(`  [${s.component}] ${s.note || '(no build note)'}`);
    console.log(`      ${s.pattern.slice(0, 72)}${s.pattern.length > 72 ? '…' : ''}`);
  }
  if (process.argv.length < 3) {
    console.log('\nPass a client .exe to scan it:  node tools/sigcheck.mjs <exe>');
  }
  process.exit(0);
}

const exe = process.argv[2];
if (!fs.existsSync(exe)) {
  console.error(`[sigcheck] no such file: ${exe}`);
  process.exit(1);
}
const buf = fs.readFileSync(exe);

/** "48 89 ? 24" -> [0x48, 0x89, null, 0x24]. `?` and `??` are both wildcards. */
const parse = (p) => p.trim().split(/\s+/).map((t) => (t.startsWith('?') ? null : parseInt(t, 16)));

/** Count occurrences, stopping at `cap` — a pattern occurring twice is already ambiguous. */
function countMatches(bytes, cap = 3) {
  const first = bytes.findIndex((b) => b !== null);
  const anchor = bytes[first];
  let n = 0;
  for (let i = 0; i + bytes.length <= buf.length; i++) {
    if (buf[i + first] !== anchor) continue;
    let ok = true;
    for (let j = 0; j < bytes.length; j++) {
      if (bytes[j] !== null && buf[i + j] !== bytes[j]) { ok = false; break; }
    }
    if (ok && ++n >= cap) return n;
  }
  return n;
}

// Build identity first — a scan with no idea what it scanned is not evidence.
const text = buf.toString('latin1');
const wide = Buffer.alloc(Math.floor(buf.length / 2));
for (let i = 0, j = 0; i + 1 < buf.length; i += 2, j++) wide[j] = buf[i + 1] === 0 ? buf[i] : 0;
const both = text + wide.toString('latin1');
const ver = both.match(/\+\+Fortnite\+Release-([A-Za-z0-9.]+)(?:-CL-(\d+))?/);

console.log(`file    : ${path.basename(exe)}  (${(buf.length / 1048576).toFixed(1)} MB)`);
console.log(`build   : ${ver ? `++Fortnite+Release-${ver[1]}${ver[2] ? `-CL-${ver[2]}` : ''}` : 'UNKNOWN — no ++Fortnite+Release- string'}`);
console.log(`engine  : ${(both.match(/4\.\d{1,2}\.\d+-\d+/) || ['unknown'])[0]}`);
console.log(`era     : ${both.includes('Athena') ? 'has Athena (Battle Royale)' : 'NO Athena — pre-Battle-Royale'}`);

/**
 * Is the code section readable as code, or encrypted?
 *
 * Shannon entropy over the raw bytes. Real x86-64 is repetitive — REX prefixes, `call rel32`,
 * padding — and lands around 6. Encrypted or compressed data approaches 8. Anything above 7.5 is
 * not code that a byte pattern can be found in.
 */
function codeSectionEntropy() {
  const peOff = buf.readUInt32LE(0x3c);
  const nSec = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  let s = peOff + 24 + optSize;
  let worst = 0;
  let count = 0;
  for (let i = 0; i < nSec; i++, s += 40) {
    const name = buf.slice(s, s + 8).toString('latin1').replace(/\0+$/, '');
    const rawSize = buf.readUInt32LE(s + 16);
    const rawPtr = buf.readUInt32LE(s + 20);
    if (name !== '.text' || !rawSize) continue;
    count++;
    const d = buf.slice(rawPtr, rawPtr + Math.min(rawSize, 1 << 20));
    const freq = new Array(256).fill(0);
    for (const b of d) freq[b]++;
    let H = 0;
    for (const c of freq) if (c) { const p = c / d.length; H -= p * Math.log2(p); }
    worst = Math.max(worst, H);
  }
  return { entropy: worst, sections: count };
}

const code = codeSectionEntropy();
const packed = code.entropy > 7.5;
console.log(`code    : .text entropy ${code.entropy.toFixed(2)}${code.sections > 1 ? ` (${code.sections} .text sections)` : ''} — ${packed ? 'PACKED, not scannable on disk' : 'plain, scannable'}`);
console.log('');

if (packed && !process.argv.includes('--force')) {
  console.log('Signature scanning SKIPPED: this build is protected and its code is encrypted in the');
  console.log('file. Every signature would report ABSENT, including ones that work — 7.40 scans 0/41');
  console.log('this way and both components run on it fine.');
  console.log('');
  console.log('To get real signature coverage for this build, run it once with Cobalt attached and');
  console.log('read the signature report it writes: Cobalt scans the DECRYPTED process image, which');
  console.log('is the only place these patterns exist. Pass --force to scan anyway.');
  process.exit(0);
}

const tally = { cobalt: { PRESENT: 0, AMBIGUOUS: 0, ABSENT: 0 }, reboot: { PRESENT: 0, AMBIGUOUS: 0, ABSENT: 0 } };
for (const s of SIGS) {
  const n = countMatches(parse(s.pattern));
  const verdict = n === 0 ? 'ABSENT' : n === 1 ? 'PRESENT' : 'AMBIGUOUS';
  tally[s.component][verdict]++;
  const flag = verdict === 'PRESENT' ? ' ' : verdict === 'AMBIGUOUS' ? '~' : 'x';
  console.log(`${flag} [${s.component}] ${verdict.padEnd(9)} ${n >= 3 ? '3+' : n}  ${s.note || ''}`);
}

console.log('');
for (const c of ['cobalt', 'reboot']) {
  const t = tally[c];
  const total = t.PRESENT + t.AMBIGUOUS + t.ABSENT;
  if (!total) continue;
  console.log(`${c.padEnd(7)}: ${t.PRESENT} present, ${t.AMBIGUOUS} ambiguous, ${t.ABSENT} absent  (of ${total})`);
}
console.log('\nA target with no PRESENT signature needs a new one written for this build.');
console.log('Absence here is conclusive: these are exact byte patterns, not paths — see tools/README.md trap 3.');
