/**
 * When each cosmetic Nova grants first entered the game.
 *
 * GENERATED — do not edit by hand. Regenerate with:
 *   node tools/cosmetics-registry.mjs --registry <Fortnite-Datamining data/items/registry.json>
 *
 * Source: that corpus's `introduction: { chapter, season }` field. CONFIRMED — 15,025 of its
 * 23,532 records carry it, spanning Chapter 1 Season 1 to Chapter 7 Season 4.
 *
 * Covers only the ids the backend actually grants (335); 97 of them are in the corpus and
 * 238 are not. An id with no entry here is treated as ALWAYS AVAILABLE, which preserves the
 * previous behaviour for anything the corpus does not know about — the filter's job is to remove
 * items that provably post-date a build, not to remove everything it cannot vouch for.
 *
 * Special seasons ("X", "OG", "Remix") carry `season: null`. They are never granted by an era
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
  ["BID_001_BlueSquire", { chapter: 1, season: 2 }],
  ["BID_002_RoyaleKnight", { chapter: 1, season: 2 }],
  ["BID_003_RedKnight", { chapter: 1, season: 3 }],
  ["CID_001_Athena_Commando_F_Default", { chapter: 1, season: 1 }],
  ["CID_002_Athena_Commando_F_Default", { chapter: 1, season: 1 }],
  ["CID_003_Athena_Commando_F_Default", { chapter: 1, season: 1 }],
  ["CID_004_Athena_Commando_F_Default", { chapter: 1, season: 1 }],
  ["CID_005_Athena_Commando_M_Default", { chapter: 1, season: 1 }],
  ["CID_006_Athena_Commando_M_Default", { chapter: 1, season: 1 }],
  ["CID_007_Athena_Commando_M_Default", { chapter: 1, season: 1 }],
  ["CID_008_Athena_Commando_M_Default", { chapter: 1, season: 1 }],
  ["CID_009_Athena_Commando_M", { chapter: 1, season: 1 }],
  ["CID_010_Athena_Commando_M", { chapter: 1, season: 1 }],
  ["CID_011_Athena_Commando_M", { chapter: 1, season: 1 }],
  ["CID_012_Athena_Commando_M", { chapter: 1, season: 1 }],
  ["CID_013_Athena_Commando_F", { chapter: 1, season: 1 }],
  ["CID_014_Athena_Commando_F", { chapter: 1, season: 1 }],
  ["CID_015_Athena_Commando_F", { chapter: 1, season: 1 }],
  ["CID_016_Athena_Commando_F", { chapter: 1, season: 1 }],
  ["CID_017_Athena_Commando_M", { chapter: 1, season: 1 }],
  ["CID_018_Athena_Commando_M", { chapter: 1, season: 1 }],
  ["CID_019_Athena_Commando_M", { chapter: 1, season: 1 }],
  ["CID_020_Athena_Commando_M", { chapter: 1, season: 1 }],
  ["CID_021_Athena_Commando_F", { chapter: 1, season: 1 }],
  ["CID_022_Athena_Commando_F", { chapter: 1, season: 1 }],
  ["CID_023_Athena_Commando_F", { chapter: 1, season: 1 }],
  ["CID_028_Athena_Commando_F", { chapter: 1, season: 1 }],
  ["CID_029_Athena_Commando_F_Halloween", { chapter: 1, season: 1 }],
  ["CID_030_Athena_Commando_M_Halloween", { chapter: 1, season: 1 }],
  ["CID_032_Athena_Commando_M_Medieval", { chapter: 1, season: 2 }],
  ["CID_033_Athena_Commando_F_Medieval", { chapter: 1, season: 2 }],
  ["CID_034_Athena_Commando_F_Medieval", { chapter: 1, season: 1 }],
  ["CID_035_Athena_Commando_M_Medieval", { chapter: 1, season: 2 }],
  ["CID_039_Athena_Commando_F_Disco", { chapter: 1, season: 2 }],
  ["CID_041_Athena_Commando_F_District", { chapter: 1, season: 1 }],
  ["CID_044_Athena_Commando_F_SciPop", { chapter: 1, season: 1 }],
  ["CID_052_Athena_Commando_F_PSBlue", { chapter: 1, season: 2 }],
  ["CID_069_Athena_Commando_F_PinkBear", { chapter: 1, season: 2 }],
  ["CID_070_Athena_Commando_M_Cupid", { chapter: 1, season: 2 }],
  ["CID_071_Athena_Commando_M_Wukong", { chapter: 1, season: 2 }],
  ["CID_072_Athena_Commando_M_Scout", { chapter: 1, season: 2 }],
  ["CID_073_Athena_Commando_F_Scuba", { chapter: 1, season: 2 }],
  ["CID_076_Athena_Commando_F_Sup", { chapter: 1, season: 2 }],
  ["CID_077_Athena_Commando_M_Sup", { chapter: 1, season: 2 }],
  ["CID_083_Athena_Commando_F_Tactical", { chapter: 1, season: 3 }],
  ["CID_084_Athena_Commando_M_Assassin", { chapter: 1, season: 3 }],
  ["CID_090_Athena_Commando_M_Tactical", { chapter: 1, season: 3 }],
  ["CID_095_Athena_Commando_M_Founder", { chapter: 1, season: 3 }],
  ["CID_096_Athena_Commando_F_Founder", { chapter: 1, season: 3 }],
  ["CID_099_Athena_Commando_F_Scathach", { chapter: 1, season: 3 }],
  ["CID_101_Athena_Commando_M_Stealth", { chapter: 1, season: 3 }],
  ["CID_102_Athena_Commando_M_Raven", { chapter: 1, season: 3 }],
  ["CID_103_Athena_Commando_M_Bunny", { chapter: 1, season: 3 }],
  ["CID_104_Athena_Commando_F_Bunny", { chapter: 1, season: 3 }],
  ["CID_106_Athena_Commando_F_Taxi", { chapter: 1, season: 3 }],
  ["CID_113_Athena_Commando_M_BlueAce", { chapter: 1, season: 4 }],
  ["CID_114_Athena_Commando_F_TacticalWoodland", { chapter: 1, season: 4 }],
  ["CID_116_Athena_Commando_M_CarbideBlack", { chapter: 1, season: 4 }],
  ["CID_174_Athena_Commando_F_CarbideWhite", { chapter: 1, season: 6 }],
  ["CID_175_Athena_Commando_M_Celestial", { chapter: 1, season: 5 }],
  ["CID_237_Athena_Commando_F_Cowgirl", { chapter: 1, season: 6 }],
  ["CID_242_Athena_Commando_F_Bullseye", { chapter: 1, season: 6 }],
  ["CID_260_Athena_Commando_F_StreetOps", { chapter: 1, season: 6 }],
  ["EID_Accolades", { chapter: 1, season: 7 }],
  ["EID_BestMates", { chapter: 1, season: 3 }],
  ["EID_BreakDance", { chapter: 1, season: 3 }],
  ["EID_Confused", { chapter: 1, season: 3 }],
  ["EID_Conga", { chapter: 1, season: 8 }],
  ["EID_Dab", { chapter: 1, season: 1 }],
  ["EID_Facepalm", { chapter: 1, season: 3 }],
  ["EID_Flapper", { chapter: 1, season: 2 }],
  ["EID_Floss", { chapter: 1, season: 2 }],
  ["EID_GolfClap", { chapter: 1, season: 7 }],
  ["EID_HeelClick", { chapter: 1, season: 3 }],
  ["EID_Hype", { chapter: 1, season: 4 }],
  ["EID_Intensity", { chapter: 1, season: 5 }],
  ["EID_LivingLarge", { chapter: 1, season: 5 }],
  ["EID_PopLock", { chapter: 1, season: 4 }],
  ["EID_PureSalt", { chapter: 1, season: 2 }],
  ["EID_RegalWave", { chapter: 1, season: 6 }],
  ["EID_Robot", { chapter: 1, season: 3 }],
  ["EID_Salute", { chapter: 1, season: 3 }],
  ["EID_SlowClap", { chapter: 1, season: 1 }],
  ["EID_Sparkler", { chapter: 1, season: 4 }],
  ["EID_TakeTheL", { chapter: 1, season: 3 }],
  ["EID_Twist", { chapter: 1, season: 5 }],
  ["EID_Wave", { chapter: 1, season: 2 }],
  ["EID_Wiggle", { chapter: 1, season: 3 }],
  ["EID_Worm", { chapter: 1, season: 2 }],
  ["Glider_ID_004_Disco", { chapter: 1, season: 2 }],
  ["Pickaxe_ID_013_Teslacoil", { chapter: 1, season: 2 }],
  ["Pickaxe_ID_017_Shark", { chapter: 1, season: 1 }],
  ["Pickaxe_ID_019_Heart", { chapter: 1, season: 2 }],
  ["Pickaxe_ID_020_Keg", { chapter: 1, season: 1 }],
  ["Pickaxe_ID_021_Megalodon", { chapter: 1, season: 1 }],
  ["Pickaxe_ID_024_Plunger", { chapter: 1, season: 2 }],
  ["Pickaxe_ID_025_Dragon", { chapter: 1, season: 2 }],
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
