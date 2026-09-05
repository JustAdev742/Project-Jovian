#!/usr/bin/env node
/**
 * Regenerate `Main backend/src/version/builds.ts` from the `fortnite-archives` corpus.
 *
 * The registry answers "which chapter and season is major version N?", which the backend previously
 * got wrong outside Chapter 1 by assuming `season === major`. The answer is not derivable by
 * arithmetic — Chapter 6 Season 4 spans two majors — so it has to come from data.
 *
 * The corpus stores per-build map data as `chapter_<c>/season_<s>/<major>_<minor>/`. This walks that
 * tree, collapses it to major → (chapter, season), and refuses to emit anything if the result is not
 * self-consistent. Those checks are the reason the output is trustworthy:
 *
 *   - no major may appear under two different (chapter, season) pairs
 *   - the major sequence must have no gaps
 *
 * A single miscategorised directory in the corpus would trip one of them.
 *
 * USAGE
 *   node tools/build-registry.mjs [--archive <path-to-extracted-fortnite-archives-main>]
 *   node tools/build-registry.mjs --check     verify the committed file matches the corpus
 *
 * The archive is 933 MB and is NOT in the repository. Extract just the metadata:
 *   unzip -q 'fortnite-archives-main.zip' 'fortnite-archives-main/chapter_*∕*∕*∕*.json' -d <dir>
 * (only the JSON is needed — the rest is map imagery.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'Main backend', 'src', 'version', 'builds.ts');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const archiveArg = argv[argv.indexOf('--archive') + 1];
const ARCHIVE = argv.includes('--archive') ? archiveArg : null;

function findArchive() {
  if (ARCHIVE) return ARCHIVE;
  // Common extraction spots, newest first. Kept short on purpose: if it is not one of these, pass
  // --archive rather than having this guess harder.
  const candidates = [
    path.join(ROOT, 'Full documentation', '_extracted', 'fortnite-archives-main'),
    path.join(process.env.TEMP || '/tmp', 'fortnite-archives-main'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function collect(archive) {
  const byMajor = new Map();
  const conflicts = [];
  for (const ch of fs.readdirSync(archive).filter((d) => d.startsWith('chapter_'))) {
    const chapter = Number(ch.split('_')[1]);
    const chDir = path.join(archive, ch);
    if (!fs.statSync(chDir).isDirectory()) continue;
    for (const se of fs.readdirSync(chDir)) {
      const season = Number(se.split('_')[1]);
      const seDir = path.join(chDir, se);
      if (!fs.statSync(seDir).isDirectory()) continue;
      for (const build of fs.readdirSync(seDir)) {
        const m = /^(\d+)[._-]/.exec(build);
        if (!m) continue;
        const major = Number(m[1]);
        const existing = byMajor.get(major);
        if (!existing) {
          byMajor.set(major, { major, chapter, season, knownBuilds: new Set([build]) });
        } else {
          if (existing.chapter !== chapter || existing.season !== season) {
            conflicts.push(`major ${major}: Ch${existing.chapter}S${existing.season} vs Ch${chapter}S${season}`);
          }
          existing.knownBuilds.add(build);
        }
      }
    }
  }
  const rows = [...byMajor.values()]
    .sort((a, b) => a.major - b.major)
    .map((r) => ({ ...r, knownBuilds: [...r.knownBuilds].sort() }));
  return { rows, conflicts };
}

const archive = findArchive();
if (!archive) {
  console.error('[build-registry] corpus not found. Pass --archive <extracted fortnite-archives-main>.');
  process.exit(1);
}

const { rows, conflicts } = collect(archive);

if (conflicts.length) {
  console.error('[build-registry] REFUSING — the corpus is not self-consistent:');
  for (const c of conflicts) console.error(`  ${c}`);
  process.exit(1);
}
const gaps = rows.filter((r, i) => i > 0 && r.major !== rows[i - 1].major + 1);
if (gaps.length) {
  console.error(`[build-registry] REFUSING — gaps in the major sequence before: ${gaps.map((g) => g.major).join(', ')}`);
  process.exit(1);
}

console.log(`[build-registry] ${rows.length} majors, chapters ${rows[0].chapter}-${rows[rows.length - 1].chapter}, no gaps, no conflicts`);

// The header is preserved from the existing file so the prose explaining the data is not clobbered
// by a regeneration; only the table between the markers is rewritten.
const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
const START = 'export const BUILD_ERAS: readonly BuildEra[] = [';
const END = '];';
const startIdx = current.indexOf(START);
if (startIdx < 0) {
  console.error(`[build-registry] could not find the table marker in ${TARGET}`);
  process.exit(1);
}
const endIdx = current.indexOf(END, startIdx);

const table = rows
  .map((r) => `  { major: ${String(r.major).padStart(2)}, chapter: ${r.chapter}, season: ${r.season}, knownBuilds: [${r.knownBuilds.map((b) => JSON.stringify(b)).join(', ')}] },`)
  .join('\n');

const next = current.slice(0, startIdx + START.length) + '\n' + table + '\n' + current.slice(endIdx);

if (checkOnly) {
  if (next !== current) {
    console.error('[build-registry] builds.ts is OUT OF DATE with the corpus. Run without --check.');
    process.exit(1);
  }
  console.log('[build-registry] builds.ts matches the corpus');
  process.exit(0);
}

fs.writeFileSync(TARGET, next);
console.log(`[build-registry] wrote ${path.relative(ROOT, TARGET).replace(/\\/g, '/')}`);
