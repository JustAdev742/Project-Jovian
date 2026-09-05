#!/usr/bin/env node
/**
 * Generate `Main backend/src/version/cosmetics.ts` — when each cosmetic entered the game.
 *
 * WHY. Nova granted the same 335 cosmetics to every account regardless of build. That is wrong in
 * one direction and merely stingy in the other:
 *
 *   - An item introduced AFTER the client's build does not exist in that build's assets, so it
 *     renders as a blank tile in the locker. Real and found by this data: `EID_Conga` is a Chapter 1
 *     Season 8 emote and was being granted to 7.40, a Season 7 build.
 *   - An item introduced before the client's build is fine, just not everything that era had.
 *
 * Only the first is a defect, so the backend filters rather than expands (see cosmetics.ts).
 *
 * SOURCE AND ITS TRAPS. `Fortnite-Datamining data/items/registry.json`, field
 * `introduction: { chapter, season }`. 15,025 of 23,532 records carry it, spanning C1S1 to C7S4.
 *
 * Two sibling fields in the same file are DECOYS and are deliberately not used here:
 *   - `first_seen` — 22,198 of 23,532 records say `2026-05-02`, the day the scraper started. It is
 *     an ingest date, not a game date.
 *   - `added` (in the sibling br.json) — ranges back to 2019 and looks like history, but 2,722
 *     records collapse onto a single 2019-11 bulk backfill.
 * `introduction` is the only trustworthy era field.
 *
 * SEASON IS NOT ALWAYS A NUMBER. Special seasons appear as `"X"` (Chapter 1 Season X), `"OG"`,
 * `"Remix"`. Those are emitted with a null ordinal and are never granted by an era filter, because
 * placing them in sequence would be a guess.
 *
 * USAGE
 *   node tools/cosmetics-registry.mjs --registry <path to registry.json>
 *   node tools/cosmetics-registry.mjs --check --registry <path>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'Main backend', 'src', 'version', 'cosmetics.ts');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const regPath = argv.includes('--registry') ? argv[argv.indexOf('--registry') + 1] : null;
if (!regPath || !fs.existsSync(regPath)) {
  console.error('[cosmetics-registry] pass --registry <path to Fortnite-Datamining data/items/registry.json>');
  process.exit(1);
}

const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));

/** Which cosmetic ids the backend actually grants. Only those need an era, so only those are emitted. */
function novaGrantedIds() {
  const src = fs.readFileSync(path.join(ROOT, 'Main backend', 'src', 'services', 'mcp', 'profiles', 'athena.ts'), 'utf8');
  const lists = ['CHARACTERS', 'BACKPACKS', 'PICKAXES', 'GLIDERS', 'DANCES', 'WRAPS', 'LOADING_SCREENS', 'CONTRAILS', 'MUSIC_PACKS'];
  const out = [];
  for (const name of lists) {
    const i = src.indexOf(`const ${name} = [`);
    if (i < 0) continue;
    const j = src.indexOf('];', i);
    for (const m of src.slice(i, j).matchAll(/'([^']+)'/g)) out.push(m[1]);
  }
  return [...new Set(out)];
}

const granted = novaGrantedIds();
if (granted.length < 100) {
  console.error(`[cosmetics-registry] REFUSING — only found ${granted.length} granted ids; the parser is probably broken`);
  process.exit(1);
}

const rows = [];
let known = 0;
let unknown = 0;
let special = 0;

for (const id of granted.sort()) {
  const intro = reg[id]?.introduction;
  if (!intro?.chapter) {
    // Not in the corpus at all. Common for very early or never-released ids, and NOT an error: the
    // filter treats an unknown era as "always available", which preserves current behaviour.
    unknown++;
    continue;
  }
  const chapter = Number(intro.chapter);
  const seasonRaw = String(intro.season);
  const season = /^\d+$/.test(seasonRaw) ? Number(seasonRaw) : null;
  if (season === null) special++;
  known++;
  rows.push({ id, chapter, season, seasonRaw });
}

console.log(`[cosmetics-registry] ${granted.length} granted ids · ${known} with a known era · ${unknown} not in the corpus · ${special} special seasons`);

const body = rows
  .map((r) =>
    r.season === null
      ? `  ["${r.id}", { chapter: ${r.chapter}, season: null, label: ${JSON.stringify(r.seasonRaw)} }],`
      : `  ["${r.id}", { chapter: ${r.chapter}, season: ${r.season} }],`,
  )
  .join('\n');

const out = `/**
 * When each cosmetic Nova grants first entered the game.
 *
 * GENERATED — do not edit by hand. Regenerate with:
 *   node tools/cosmetics-registry.mjs --registry <Fortnite-Datamining data/items/registry.json>
 *
 * Source: that corpus's \`introduction: { chapter, season }\` field. CONFIRMED — 15,025 of its
 * 23,532 records carry it, spanning Chapter 1 Season 1 to Chapter 7 Season 4.
 *
 * Covers only the ids the backend actually grants (${granted.length}); ${known} of them are in the corpus and
 * ${unknown} are not. An id with no entry here is treated as ALWAYS AVAILABLE, which preserves the
 * previous behaviour for anything the corpus does not know about — the filter's job is to remove
 * items that provably post-date a build, not to remove everything it cannot vouch for.
 *
 * Special seasons ("X", "OG", "Remix") carry \`season: null\`. They are never granted by an era
 * filter, because placing them in a numeric sequence would be a guess.
 */

export interface CosmeticEra {
  chapter: number;
  /** Season within the chapter, or null for a special season that has no ordinal. */
  season: number | null;
  /** The corpus's own spelling, when it is not a number. */
  label?: string;
}

/** id → when it was introduced. */
export const COSMETIC_ERA = new Map<string, CosmeticEra>([
${body}
]);

/**
 * Could a build at (chapter, season) have this cosmetic?
 *
 * Unknown ids return true — see the module comment. Special seasons return false, because their
 * position in the sequence is not established.
 */
export function existsByEra(id: string, chapter: number, season: number): boolean {
  const era = COSMETIC_ERA.get(id);
  if (!era) return true;
  if (era.season === null) return false;
  if (era.chapter !== chapter) return era.chapter < chapter;
  return era.season <= season;
}
`;

if (checkOnly) {
  const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== out) {
    console.error('[cosmetics-registry] cosmetics.ts is OUT OF DATE. Run without --check.');
    process.exit(1);
  }
  console.log('[cosmetics-registry] cosmetics.ts matches the corpus');
  process.exit(0);
}

fs.writeFileSync(TARGET, out);
console.log(`[cosmetics-registry] wrote ${path.relative(ROOT, TARGET).replace(/\\/g, '/')}`);
