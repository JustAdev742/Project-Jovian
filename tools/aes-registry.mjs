#!/usr/bin/env node
/**
 * Generate `Main backend/src/version/keychain.ts` from the Fortnite-Aes-Keys-Archive corpus.
 *
 * WHAT THE KEYCHAIN ENDPOINT ACTUALLY SERVES. `GET /fortnite/api/storefront/v2/keychain` returns
 * the per-CHUNK (secondary) keys that decrypt encrypted cosmetic pak chunks, as
 * `GUID:base64(key)` strings. The PRIMARY key — the one that mounts the main paks — is not served
 * here; the build already has it. So this generator only emits secondary keys, and deliberately
 * does not put the primary keys anywhere the backend can accidentally serve them.
 *
 * WHY THIS IS THE FIRST REAL CROSS-VERSION DATA. Nova served 7.40's two chunk keys to every caller.
 * That is correct for 7.40 and wrong for everything else, and it was one of the reasons zero
 * features varied by build. The archive covers 75 builds with usable chunk keys, so this is the
 * best-evidenced per-build behaviour available — CONFIRMED, from a source that lists the keys
 * themselves rather than describing them.
 *
 * KEYS RECORDED AS `???` ARE SKIPPED, NOT GUESSED. The archive marks 66 chunk keys as unknown; a
 * build that has some known and some unknown gets the known ones and a recorded gap. Serving an
 * invented key would not merely fail, it would fail in a way that looks like a decryption bug.
 *
 * USAGE
 *   node tools/aes-registry.mjs --archive <path to extracted Fortnite-Aes-Keys-Archive-main>
 *   node tools/aes-registry.mjs --check --archive <path>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'Main backend', 'src', 'version', 'keychain.ts');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const archiveArg = argv.includes('--archive') ? argv[argv.indexOf('--archive') + 1] : null;
if (!archiveArg) {
  console.error('[aes-registry] pass --archive <extracted Fortnite-Aes-Keys-Archive-main>');
  process.exit(1);
}
const README = path.join(archiveArg, 'README.md');
if (!fs.existsSync(README)) {
  console.error(`[aes-registry] no README.md under ${archiveArg}`);
  process.exit(1);
}

const md = fs.readFileSync(README, 'utf8');

/** `### 7.40` … then rows `1003 | \`GUID\`<br/>\`KEY\` | notes` */
const sections = [...md.matchAll(/###\s*(\d+\.\d+)\s*\n([\s\S]*?)(?=###\s*\d|\n##\s|$)/g)];

const HEX32 = /^[0-9A-Fa-f]{32}$/;
const HEX64 = /^[0-9A-Fa-f]{64}$/;

const builds = [];
let usable = 0;
let skipped = 0;

for (const [, build, body] of sections) {
  const rows = [...body.matchAll(/^\s*(\S+)\s*\|\s*`([^`]+)`<br\/>`([^`]+)`\s*\|([^\n]*)/gm)];
  const keys = [];
  let unknownHere = 0;
  for (const [, chunk, guid, key, notes] of rows) {
    if (!HEX32.test(guid) || !HEX64.test(key)) {
      // `???` or a malformed row. Recorded as a gap; never guessed.
      unknownHere++;
      skipped++;
      continue;
    }
    keys.push({
      chunk: chunk.trim(),
      guid: guid.toUpperCase(),
      key: Buffer.from(key, 'hex').toString('base64'),
      note: (notes || '').replace(/\|/g, '').trim() || undefined,
    });
    usable++;
  }
  if (keys.length || unknownHere) {
    builds.push({ build, keys, unknown: unknownHere });
  }
}

builds.sort((a, b) => {
  const [am, an] = a.build.split('.').map(Number);
  const [bm, bn] = b.build.split('.').map(Number);
  return am - bm || an - bn;
});

console.log(
  `[aes-registry] ${builds.length} builds, ${usable} usable chunk keys, ${skipped} recorded as unknown`,
);

// Sanity: 7.40's two keys are the ones verified by hand on 2026-09-05 and pinned by a test. If this
// generator ever stops producing them, it has broken and the test will say so — but fail loudly here
// too rather than writing a file that quietly drops them.
const b740 = builds.find((b) => b.build === '7.40');
if (!b740 || b740.keys.length !== 2) {
  console.error('[aes-registry] REFUSING — 7.40 must yield exactly 2 usable chunk keys, got',
    b740 ? b740.keys.length : 'no section');
  process.exit(1);
}
if (b740.keys[0].guid !== '91C415954BF27B6E43970FB8A75FE8BB') {
  console.error('[aes-registry] REFUSING — 7.40 chunk 1003 GUID does not match the verified value');
  process.exit(1);
}

const header = `/**
 * Per-build cosmetic chunk keys for GET /fortnite/api/storefront/v2/keychain.
 *
 * GENERATED — do not edit by hand. Regenerate with:
 *   node tools/aes-registry.mjs --archive <extracted Fortnite-Aes-Keys-Archive-main>
 *
 * Source: Fortnite-Aes-Keys-Archive (supplied corpus). CONFIRMED — the archive lists the keys
 * themselves, and 7.40's two were verified by hand against the running backend on 2026-09-05.
 *
 * These are the SECONDARY (per-chunk) keys the keychain endpoint serves as \`GUID:base64(key)\`.
 * The primary key that mounts the main paks is NOT here and is not served by this endpoint — the
 * build already has it — so it is deliberately kept out of reach of a route.
 *
 * Keys the archive records as \`???\` are omitted and counted in \`unknownChunks\`. A build with
 * gaps serves what is known; the cosmetics in the unknown chunks stay undecryptable, which is an
 * evidence gap rather than a defect. Inventing a key would fail in a way that looks like a
 * decryption bug rather than a missing key.
 *
 * ${builds.length} builds · ${usable} keys · ${skipped} recorded unknown.
 */

export interface BuildKeychain {
  /** Build string as the archive spells it, e.g. "7.40". */
  build: string;
  /** Ready to serve verbatim: "GUID:base64key". */
  entries: string[];
  /** Chunks whose key the archive records as unknown. Informational; nothing is invented. */
  unknownChunks: number;
}

export const KEYCHAINS: readonly BuildKeychain[] = [
`;

const rows = builds
  .map((b) => {
    const entries = b.keys.map((k) => `      ${JSON.stringify(`${k.guid}:${k.key}`)},`).join('\n');
    const comment = b.keys
      .map((k) => `    // chunk ${k.chunk}${k.note ? ` — ${k.note}` : ''}`)
      .join('\n');
    return `  {\n    build: ${JSON.stringify(b.build)},\n${comment ? comment + '\n' : ''}    entries: [\n${entries}\n    ],\n    unknownChunks: ${b.unknown},\n  },`;
  })
  .join('\n');

const footer = `
];

const BY_BUILD = new Map<string, BuildKeychain>(KEYCHAINS.map((k) => [k.build, k]));

/**
 * Keys for an exact build, or null.
 *
 * Deliberately exact. Chunk keys are per-build and do not carry forward — serving 8.00's keys to an
 * 8.10 client would hand it keys for chunks that build does not have, which is worse than serving
 * none because it looks like a decryption failure rather than a missing key.
 */
export function keychainForBuild(build: string): BuildKeychain | null {
  return BY_BUILD.get(build) ?? null;
}

/** \`major.minor\` in the archive's spelling, e.g. (7, 40) -> "7.40". */
export function buildString(major: number, minor: number): string {
  return \`\${major}.\${String(minor).padStart(2, '0')}\`;
}
`;

const next = header + rows + footer;

if (checkOnly) {
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
  if (current.replace(/\r\n/g, '\n') !== next) {
    console.error('[aes-registry] keychain.ts is OUT OF DATE with the archive.');
    process.exit(1);
  }
  console.log('[aes-registry] keychain.ts matches the archive');
  process.exit(0);
}

fs.writeFileSync(TARGET, next);
console.log(`[aes-registry] wrote ${path.relative(ROOT, TARGET).replace(/\\/g, '/')}`);
