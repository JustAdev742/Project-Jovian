/**
 * The build registry — which chapter and season a Fortnite major version belongs to.
 *
 * WHY THIS EXISTS. `middleware/version-router.ts` set `season = major`, with the comment "In Ch1,
 * major version = season number". That is true, and only true, for Chapter 1. From 11.00 onward the
 * major version keeps counting while the season number restarts each chapter, so every consumer of
 * `gameVersion.season` was wrong by construction outside Chapter 1 — which mattered the moment this
 * project claimed a cross-version scope.
 *
 * WHERE THE DATA COMES FROM — CONFIRMED. Derived mechanically from the `fortnite-archives` corpus
 * (`Full documentation/Full .zips/fortnite-archives-main.zip`), which stores per-build map data
 * under `chapter_<n>/season_<n>/<major>_<minor>/`. 246 build directories were enumerated and
 * collapsed to major → (chapter, season).
 *
 * The result is self-consistent, which is the reason to trust it:
 *   - 42 majors, 1 through 42
 *   - ZERO gaps in the major sequence
 *   - ZERO conflicts — no major ever appeared under two different (chapter, season) pairs
 *
 * A single miscategorised directory would have shown up as a conflict. None did.
 *
 * THE EXCEPTION WORTH KNOWING: Chapter 6 Season 4 spans **two** majors (36 and 37). Do not assume
 * one major per season — the table is the authority, not the arithmetic.
 *
 * Regenerate with:
 *   node tools/build-registry.mjs
 */

/** One row of the registry. `knownBuilds` are the build directories the corpus actually contains. */
export interface BuildEra {
  /** Fortnite major version, e.g. 7 for 7.40. */
  major: number;
  /** Chapter, 1-based. */
  chapter: number;
  /** Season WITHIN the chapter, 1-based. Not the same as `major` outside Chapter 1. */
  season: number;
  /** Build ids seen in the corpus for this major. Evidence, not an exhaustive release list. */
  knownBuilds: string[];
}

/** major → (chapter, season). CONFIRMED; see the module comment for provenance. */
export const BUILD_ERAS: readonly BuildEra[] = [
  { major:  1, chapter: 1, season: 1, knownBuilds: ["1_11", "1_6_0", "1_8_0", "1_8_2", "1_9_0"] },
  { major:  2, chapter: 1, season: 2, knownBuilds: ["2_1_0", "2_2_0", "2_3_0", "2_4_0", "2_5_0"] },
  { major:  3, chapter: 1, season: 3, knownBuilds: ["3_1_0", "3_2_0", "3_3_0", "3_5_0"] },
  { major:  4, chapter: 1, season: 4, knownBuilds: ["4_0", "4_1", "4_2", "4_4", "4_5"] },
  { major:  5, chapter: 1, season: 5, knownBuilds: ["5_10", "5_20", "5_21", "5_30", "5_40", "5_41"] },
  { major:  6, chapter: 1, season: 6, knownBuilds: ["6_01", "6_10", "6_20", "6_21", "6_30", "6_31"] },
  { major:  7, chapter: 1, season: 7, knownBuilds: ["7_00", "7_01", "7_10", "7_10-snow", "7_20", "7_30", "7_40"] },
  { major:  8, chapter: 1, season: 8, knownBuilds: ["8_00", "8_01", "8_10", "8_20", "8_30", "8_40", "8_50", "8_51"] },
  { major:  9, chapter: 1, season: 9, knownBuilds: ["9_00", "9_01", "9_10", "9_20", "9_21", "9_30", "9_40", "9_41"] },
  { major: 10, chapter: 1, season: 10, knownBuilds: ["10_10", "10_20", "10_30", "10_31", "10_40"] },
  { major: 11, chapter: 2, season: 1, knownBuilds: ["11_00", "11_10", "11_30", "11_31", "11_40"] },
  { major: 12, chapter: 2, season: 2, knownBuilds: ["12_00", "12_20", "12_50", "12_60"] },
  { major: 13, chapter: 2, season: 3, knownBuilds: ["13_00", "13_20", "13_20-(water-lvl-4)", "13_20-(water-lvl-5)", "13_20-(water-lvl-6)", "13_20-(water-lvl-7)", "13_30", "13_30-(water-lvl-1)", "13_30-(water-lvl-2)", "13_30-(water-lvl-3)"] },
  { major: 14, chapter: 2, season: 4, knownBuilds: ["14_00", "14_10", "14_20", "14_40"] },
  { major: 15, chapter: 2, season: 5, knownBuilds: ["15_00", "15_10", "15_10-snow", "15_10-snow-2", "15_20", "15_21", "15_30", "15_40"] },
  { major: 16, chapter: 2, season: 6, knownBuilds: ["16_00", "16_10", "16_20", "16_30", "16_40", "16_50"] },
  { major: 17, chapter: 2, season: 7, knownBuilds: ["17_00", "17_10", "17_20", "17_21", "17_30", "17_40", "17_50"] },
  { major: 18, chapter: 2, season: 8, knownBuilds: ["18_00", "18_10", "18_20", "18_21", "18_30", "18_40"] },
  { major: 19, chapter: 3, season: 1, knownBuilds: ["19_00", "19_01", "19_10", "19_20", "19_30", "19_40"] },
  { major: 20, chapter: 3, season: 2, knownBuilds: ["20_00", "20_10", "20_20", "20_30", "20_40"] },
  { major: 21, chapter: 3, season: 3, knownBuilds: ["21_00", "21_10", "21_20", "21_30", "21_40", "21_50", "21_51"] },
  { major: 22, chapter: 3, season: 4, knownBuilds: ["22_00", "22_10", "22_20", "22_30", "22_40"] },
  { major: 23, chapter: 4, season: 1, knownBuilds: ["23_00", "23_10", "23_20", "23_30", "23_40", "23_50"] },
  { major: 24, chapter: 4, season: 2, knownBuilds: ["24_00", "24_01", "24_10", "24_20", "24_30", "24_40"] },
  { major: 25, chapter: 4, season: 3, knownBuilds: ["25_00", "25_10", "25_11", "25_20", "25_30"] },
  { major: 26, chapter: 4, season: 4, knownBuilds: ["26_00", "26_10", "26_20", "26_30"] },
  { major: 27, chapter: 4, season: 5, knownBuilds: ["27_00", "27_00-stage-2", "27_10", "27_11"] },
  { major: 28, chapter: 5, season: 1, knownBuilds: ["28_00", "28_01", "28_10", "28_20", "28_30"] },
  { major: 29, chapter: 5, season: 2, knownBuilds: ["29_00", "29_01", "29_10", "29_20", "29_30", "29_40"] },
  { major: 30, chapter: 5, season: 3, knownBuilds: ["30_00", "30_10", "30_20", "30_30", "30_40"] },
  { major: 31, chapter: 5, season: 4, knownBuilds: ["31_00", "31_10", "31_20", "31_30", "31_40", "31_41"] },
  { major: 32, chapter: 5, season: 5, knownBuilds: ["32-week-2", "32-week-3", "32-week-4", "32_00", "32_11"] },
  { major: 33, chapter: 6, season: 1, knownBuilds: ["33_00", "33_10", "33_11", "33_20", "33_30"] },
  { major: 34, chapter: 6, season: 2, knownBuilds: ["34_00", "34_10", "34_20", "34_30", "34_40"] },
  { major: 35, chapter: 6, season: 3, knownBuilds: ["35_00", "35_20"] },
  { major: 36, chapter: 6, season: 4, knownBuilds: ["36_00", "36_30"] },
  { major: 37, chapter: 6, season: 4, knownBuilds: ["37_00", "37_40", "37_50"] },
  { major: 38, chapter: 6, season: 5, knownBuilds: ["38_10"] },
  { major: 39, chapter: 7, season: 1, knownBuilds: ["39_40", "39_50", "39_51"] },
  { major: 40, chapter: 7, season: 2, knownBuilds: ["40_00", "40_10", "40_20", "40_40"] },
  { major: 41, chapter: 7, season: 3, knownBuilds: ["41_00", "41_10", "41_20", "41_30"] },
  { major: 42, chapter: 7, season: 4, knownBuilds: ["42_00"] },
];

const BY_MAJOR = new Map<number, BuildEra>(BUILD_ERAS.map((e) => [e.major, e]));

/** The highest major the registry knows about. Beyond this we are guessing, and say so. */
export const NEWEST_KNOWN_MAJOR = BUILD_ERAS[BUILD_ERAS.length - 1].major;

/**
 * Resolve a major version to its chapter and season.
 *
 * Returns `null` for anything the corpus does not cover, rather than extrapolating. A caller that
 * needs a number anyway must decide what to do with the absence — silently inventing a chapter is
 * how `season = major` survived as long as it did.
 */
export function eraForMajor(major: number): BuildEra | null {
  return BY_MAJOR.get(major) ?? null;
}
