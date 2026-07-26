import { Config } from '../../../config';
import { getAthenaProfileJson, saveAthenaProfileJson } from '../../../database';

/** All Chapter 1 Season 7/8 cosmetic IDs */
const CHARACTERS = [
  'CID_001_Athena_Commando_F_Default','CID_002_Athena_Commando_F_Default','CID_003_Athena_Commando_F_Default',
  'CID_004_Athena_Commando_F_Default','CID_005_Athena_Commando_M_Default','CID_006_Athena_Commando_M_Default',
  'CID_007_Athena_Commando_M_Default','CID_008_Athena_Commando_M_Default',
  'CID_009_Athena_Commando_M','CID_010_Athena_Commando_M','CID_011_Athena_Commando_M',
  'CID_012_Athena_Commando_M','CID_013_Athena_Commando_F','CID_014_Athena_Commando_F',
  'CID_015_Athena_Commando_F','CID_016_Athena_Commando_F','CID_017_Athena_Commando_M',
  'CID_018_Athena_Commando_M','CID_019_Athena_Commando_M','CID_020_Athena_Commando_M',
  'CID_021_Athena_Commando_F','CID_022_Athena_Commando_F','CID_023_Athena_Commando_F',
  'CID_024_Athena_Commando_Rambo','CID_025_Athena_Commando_Rambo_F',
  'CID_028_Athena_Commando_F','CID_029_Athena_Commando_F_Halloween','CID_030_Athena_Commando_M_Halloween',
  'CID_031_Athena_Commando_M_Halloween','CID_032_Athena_Commando_M_Medieval',
  'CID_033_Athena_Commando_F_Medieval','CID_034_Athena_Commando_F_Medieval',
  'CID_035_Athena_Commando_M_Medieval','CID_036_Athena_Commando_M_Holiday',
  'CID_037_Athena_Commando_F_Holiday','CID_038_Athena_Commando_M_Holiday',
  'CID_039_Athena_Commando_F_Disco','CID_040_Athena_Commando_M_Disco',
  'CID_041_Athena_Commando_F_District','CID_042_Athena_Commando_M_District',
  'CID_043_Athena_Commando_F_Teddy','CID_044_Athena_Commando_F_SciPop',
  'CID_045_Athena_Commando_M_HolidayElf','CID_046_Athena_Commando_F_HolidaySgt',
  'CID_047_Athena_Commando_F_HolidayGingerbread','CID_048_Athena_Commando_F_HolidayNutcracker',
  'CID_050_Athena_Commando_M_HolidayGingerbread','CID_051_Athena_Commando_M_HolidayNutcracker',
  'CID_052_Athena_Commando_F_PSBlue','CID_053_Athena_Commando_M_SkullTrooper',
  'CID_054_Athena_Commando_M_Easteregg','CID_055_Athena_Commando_F_Easteregg',
  'CID_056_Athena_Commando_F_Valentines','CID_057_Athena_Commando_M_Valentines',
  'CID_058_Athena_Commando_M_StreetRacer','CID_059_Athena_Commando_F_StreetRacer',
  'CID_060_Athena_Commando_M_StreetRacerHoliday','CID_061_Athena_Commando_F_StreetRacerHoliday',
  'CID_062_Athena_Commando_M_SuperHero','CID_063_Athena_Commando_F_SuperHero',
  'CID_064_Athena_Commando_M_Moose','CID_065_Athena_Commando_F_SnowBunny',
  'CID_066_Athena_Commando_F_SnowBunny2','CID_067_Athena_Commando_F_Skier',
  'CID_068_Athena_Commando_M_Skier','CID_069_Athena_Commando_F_PinkBear',
  'CID_070_Athena_Commando_M_Cupid','CID_071_Athena_Commando_M_Wukong',
  'CID_072_Athena_Commando_M_Scout','CID_073_Athena_Commando_F_Scuba',
  'CID_074_Athena_Commando_M_Scuba','CID_075_Athena_Commando_F_StPatty',
  'CID_076_Athena_Commando_F_Sup','CID_077_Athena_Commando_M_Sup',
  'CID_078_Athena_Commando_M_Space','CID_079_Athena_Commando_F_Space',
  'CID_080_Athena_Commando_M_Space2','CID_081_Athena_Commando_F_Space2',
  'CID_082_Athena_Commando_M_Vampire','CID_083_Athena_Commando_F_Tactical',
  'CID_084_Athena_Commando_M_Assassin','CID_085_Athena_Commando_M_Biker',
  'CID_086_Athena_Commando_F_Biker','CID_087_Athena_Commando_F_RockerPunk',
  'CID_088_Athena_Commando_M_RockerPunk','CID_089_Athena_Commando_M_Jetpack',
  'CID_090_Athena_Commando_M_Tactical','CID_091_Athena_Commando_M_RedRobot',
  'CID_092_Athena_Commando_M_Rogue','CID_093_Athena_Commando_F_Rogue',
  'CID_094_Athena_Commando_F_Villain','CID_095_Athena_Commando_M_Founder',
  'CID_096_Athena_Commando_F_Founder','CID_097_Athena_Commando_F_RockerPunk2',
  'CID_098_Athena_Commando_F_StPatty2','CID_099_Athena_Commando_F_Scathach',
  'CID_100_Athena_Commando_M_CuChuworker','CID_101_Athena_Commando_M_Stealth',
  'CID_102_Athena_Commando_M_Raven','CID_103_Athena_Commando_M_Bunny',
  'CID_104_Athena_Commando_F_Bunny','CID_105_Athena_Commando_F_SpyGirl',
  'CID_106_Athena_Commando_F_Taxi','CID_107_Athena_Commando_F_Pirate',
  'CID_108_Athena_Commando_M_Pirate','CID_109_Athena_Commando_F_SkullValkyrie',
  'CID_110_Athena_Commando_F_SkullBride','CID_113_Athena_Commando_M_BlueAce',
  'CID_114_Athena_Commando_F_TacticalWoodland','CID_116_Athena_Commando_M_CarbideBlack',
  'CID_175_Athena_Commando_M_Celestial','CID_174_Athena_Commando_F_CarbideWhite',
  'CID_183_Athena_Commando_M_ModernMilitary','CID_184_Athena_Commando_M_DarkViking',
  'CID_185_Athena_Commando_F_DarkViking','CID_200_Athena_Commando_M_DurrburgerWorker',
  'CID_207_Athena_Commando_M_BuffCat','CID_210_Athena_Commando_F_StreetFashionEclipse',
  'CID_212_Athena_Commando_F_SharpDresser','CID_214_Athena_Commando_F_Jumpshot',
  'CID_215_Athena_Commando_M_TomatoHead','CID_237_Athena_Commando_F_Cowgirl',
  'CID_238_Athena_Commando_F_Graffiti','CID_239_Athena_Commando_M_Graffiti',
  'CID_242_Athena_Commando_F_Bullseye','CID_243_Athena_Commando_M_StreetDemon',
  'CID_244_Athena_Commando_F_ShiNobi','CID_245_Athena_Commando_M_ShiNobi',
  'CID_249_Athena_Commando_F_IceMaiden','CID_250_Athena_Commando_M_IceKing',
  'CID_251_Athena_Commando_M_Snowfoot','CID_252_Athena_Commando_F_SnowGlobe',
  'CID_253_Athena_Commando_M_MalletBat','CID_254_Athena_Commando_F_MaskedMaiden',
  'CID_255_Athena_Commando_F_OnesieJonesy','CID_256_Athena_Commando_M_PowderShaker',
  'CID_260_Athena_Commando_F_StreetOps','CID_261_Athena_Commando_M_StreetOps',
  'CID_262_Athena_Commando_F_SamuraiRed','CID_263_Athena_Commando_F_MaskedFury',
  'CID_273_Athena_Commando_F_Flora','CID_274_Athena_Commando_F_PirateFemale',
  'CID_275_Athena_Commando_M_Pirate02','CID_276_Athena_Commando_M_BlackWidow',
  'CID_277_Athena_Commando_M_PirateProgressive','CID_278_Athena_Commando_M_PirateClown',
  'CID_279_Athena_Commando_F_PirateDark','CID_280_Athena_Commando_M_StrawBoss',
  'CID_281_Athena_Commando_F_StrawBoss','CID_282_Athena_Commando_M_Inferno',
  'CID_283_Athena_Commando_F_DinoBoneGirl','CID_284_Athena_Commando_M_DinoBoneGuy',
  'CID_285_Athena_Commando_F_StreetFashionRed','CID_286_Athena_Commando_M_RobotBoy',
];

const BACKPACKS = [
  'BID_001_BlueSquire','BID_002_RoyaleKnight','BID_003_RedKnight','BID_004_Raptor',
  'BID_005_RustLord','BID_006_DarkVoyager','BID_007_HolidayElf','BID_008_NutCracker',
  'BID_010_GingerbreadM','BID_011_ValenFemale','BID_012_ValenMale','BID_013_CuddleTeamLeader',
  'BID_014_Raven','BID_015_DarkViking','BID_016_BattleHound','BID_017_Wukong',
  'BID_019_SpaceFemale','BID_020_SpaceMale','BID_021_Carbide','BID_022_Omega',
  'BID_023_Visitor','BID_024_Drift','BID_025_Ragnarok','BID_026_Calamity',
  'BID_027_DireMale','BID_028_IceKing','BID_029_Zenith','BID_030_Lynx',
  'BID_031_Onesie','BID_032_PowderShaker','BID_033_Snowfoot','BID_034_Prisoner',
  'BID_038_Blackheart','BID_039_HybridCat','BID_040_Luxe','BID_041_SidewayLarry',
  'BID_042_BananaDude','BID_043_Master','BID_044_BuccaneerFemale',
];

const PICKAXES = [
  'Pickaxe_ID_001_Default','Pickaxe_ID_002_Sawtooth','Pickaxe_ID_003_SickleBlade',
  'Pickaxe_ID_004_Flamingo','Pickaxe_ID_005_HolidayCandyCane','Pickaxe_ID_006_Spiky',
  'Pickaxe_ID_007_Scorcher','Pickaxe_ID_008_Glow','Pickaxe_ID_009_DrumMajor',
  'Pickaxe_ID_010_EyeofStorm','Pickaxe_ID_011_District','Pickaxe_ID_012_Brite',
  'Pickaxe_ID_013_Teslacoil','Pickaxe_ID_014_Scythe','Pickaxe_ID_015_HolidayGift',
  'Pickaxe_ID_016_Squash','Pickaxe_ID_017_Shark','Pickaxe_ID_018_Disco',
  'Pickaxe_ID_019_Heart','Pickaxe_ID_020_Keg','Pickaxe_ID_021_Megalodon',
  'Pickaxe_ID_022_Wukong','Pickaxe_ID_023_Space','Pickaxe_ID_024_Plunger',
  'Pickaxe_ID_025_Dragon','Pickaxe_ID_026_Biker','Pickaxe_ID_027_Viking',
  'Pickaxe_ID_028_DarkViking','Pickaxe_ID_029_IceKing','Pickaxe_ID_030_Lynx',
  'Pickaxe_ID_031_Prisoner','Pickaxe_ID_032_PirateHook','Pickaxe_ID_033_Inferno',
  'Pickaxe_ID_034_BananaDude','Pickaxe_ID_035_PirateFem',
];

const GLIDERS = [
  'Glider_ID_001_Default','Glider_ID_002_MedievalDark','Glider_ID_003_Holiday','Glider_ID_004_Disco',
  'Glider_ID_005_DistrictBlue','Glider_ID_006_Teddy','Glider_ID_007_SciPop','Glider_ID_008_Valentine',
  'Glider_ID_009_StreetRacer','Glider_ID_010_StPatty','Glider_ID_011_Space','Glider_ID_012_Tactical',
  'Glider_ID_013_Rogue','Glider_ID_014_Villain','Glider_ID_015_Founder','Glider_ID_016_Biker',
  'Glider_ID_017_RockerPunk','Glider_ID_018_Wukong','Glider_ID_019_Dragon','Glider_ID_020_Viking',
  'Glider_ID_021_DarkViking','Glider_ID_022_IceKing','Glider_ID_023_Snowfoot',
  'Glider_ID_024_Pirate','Glider_ID_025_BananaDude','Glider_ID_026_Inferno',
];

const DANCES = [
  'EID_DanceMovesDefault','EID_Floss','EID_TakeTheL','EID_RideThePony','EID_Dab',
  'EID_Electroshuffle','EID_Wiggle','EID_InfiniDab','EID_Hype','EID_Flapper',
  'EID_BestMates','EID_Robot','EID_Worm','EID_Wave','EID_RaiseDonger',
  'EID_FreshFunky','EID_BreakDance','EID_Disco','EID_Thriller','EID_OrangeJustice',
  'EID_GrittyGroove','EID_Scenario','EID_Conga','EID_TrueHeart','EID_LivingLarge',
  'EID_Sparkler','EID_ChickenWing','EID_Eagle','EID_RegalWave','EID_Twist',
  'EID_PopLock','EID_Intensity','EID_Zany','EID_GroovyMoves','EID_PureSalt',
  'EID_SlowClap','EID_WaveSad','EID_LaughItUp','EID_Facepalm','EID_GolfClap',
  'EID_PointIt','EID_Confused','EID_Salute','EID_HeelClick','EID_Accolades',
];

const WRAPS = [
  'Wrap_001_Default','Wrap_002_Flames','Wrap_003_Arctic','Wrap_004_Dino',
  'Wrap_005_Pirate','Wrap_006_Dark','Wrap_007_Red','Wrap_008_Magma',
  'Wrap_009_Galaxy','Wrap_010_BananaDude','Wrap_011_Lava','Wrap_012_DiscoPurple',
];

const LOADING_SCREENS = [
  'LSID_001_Default','LSID_002_S3','LSID_003_S4','LSID_004_S5',
  'LSID_005_S6','LSID_006_S7','LSID_007_S8','LSID_008_Pirate',
];

const CONTRAILS = [
  'Trails_ID_001_Default','Trails_ID_002_Hearts','Trails_ID_003_TP',
  'Trails_ID_004_Flames','Trails_ID_005_Ice','Trails_ID_006_Stars',
  'Trails_ID_007_Lightning','Trails_ID_008_Pirate',
];

const MUSIC_PACKS = [
  'MusicPack_001_Default','MusicPack_002_S3','MusicPack_003_S4','MusicPack_004_S5',
  'MusicPack_005_S6','MusicPack_006_S7','MusicPack_007_S8','MusicPack_008_FestiveStar',
];

/** Template ID prefixes for each cosmetic type */
const TEMPLATE_MAP: Record<string, string> = {
  CID: 'AthenaCharacter',
  BID: 'AthenaBackpack',
  Pickaxe: 'AthenaPickaxe',
  Glider: 'AthenaGlider',
  EID: 'AthenaDance',
  Wrap: 'AthenaItemWrap',
  LSID: 'AthenaLoadingScreen',
  Trails: 'AthenaSkyDiveContrail',
  MusicPack: 'AthenaMusicPack',
};

function getTemplatePrefix(id: string): string {
  for (const [prefix, template] of Object.entries(TEMPLATE_MAP)) {
    if (id.startsWith(prefix)) return template;
  }
  return 'AthenaCharacter';
}

// ─────────────────────────────────────────────────────────────────────────────
//  LAWINSERVER-STYLE BLOB STORE
//  The athena profile is ONE JSON object per account. Ops mutate it in place and
//  persist it; QueryProfile hands the exact same object back. Items are keyed by
//  their templateId (LawinServer's convention), so the client sends templateIds as
//  `itemToSlot` and there is zero GUID<->templateId translation anywhere. This
//  replaces the old dynamic-rebuild model that caused the locker not to save.
// ─────────────────────────────────────────────────────────────────────────────

/** Bare cosmetic id from a templateId ("AthenaCharacter:CID_035_x" -> "CID_035_x"). */
function bareId(templateOrId: string): string {
  if (!templateOrId) return '';
  if (/random/i.test(templateOrId)) return '';
  return templateOrId.includes(':') ? templateOrId.split(':')[1] : templateOrId;
}

/** Load the account's athena profile, seeding it from the template on first access. */
function loadProfile(accountId: string): any {
  const json = getAthenaProfileJson(accountId);
  if (json) {
    try { return JSON.parse(json); } catch { /* corrupt — reseed below */ }
  }
  const seed = buildSeedProfile(accountId);
  saveAthenaProfileJson(accountId, JSON.stringify(seed));
  return seed;
}

/** Persist the whole profile blob (debounced atomic write in the DB layer). */
function persist(accountId: string, profile: any): void {
  saveAthenaProfileJson(accountId, JSON.stringify(profile));
}

export function getEquippedCharacterId(accountId: string): string {
  return bareId(loadProfile(accountId).stats?.attributes?.favorite_character || '');
}

/**
 * Every equipped cosmetic the gameserver can apply, as bare ids, read straight out of the stored
 * profile's favorite_* stats. The gameserver can't load a player's AthenaProfile itself, so this is
 * how it learns the FULL loadout. Emote/wrap/loadingscreen/musicpack are omitted — not shown on the pawn.
 */
export function getEquippedCosmetics(accountId: string): Record<string, string> {
  const a = loadProfile(accountId).stats?.attributes || {};
  return {
    character: bareId(a.favorite_character || ''),
    backpack: bareId(a.favorite_backpack || ''),
    pickaxe: bareId(a.favorite_pickaxe || ''),
    glider: bareId(a.favorite_glider || ''),
    contrail: bareId(a.favorite_skydivecontrail || ''),
  };
}

/** Build past_seasons data for seasons before the current one — client expects this for XP/level display. */
function buildPastSeasons(): any[] {
  const seasons = [];
  for (let s = 1; s < Config.SEASON_NUMBER; s++) {
    seasons.push({
      seasonNumber: s, numWins: 50, numHighBracket: 500, numLowBracket: 500,
      seasonXp: 999999, seasonLevel: 100, bookXp: 999999, bookLevel: 100,
      purchasedVIP: true, numRoyalRoyales: 0, survivorTier: 0, survivorPrestige: 0,
    });
  }
  return seasons;
}

const ALL_COSMETICS = [
  ...CHARACTERS, ...BACKPACKS, ...PICKAXES, ...GLIDERS,
  ...DANCES, ...WRAPS, ...LOADING_SCREENS, ...CONTRAILS, ...MUSIC_PACKS,
];

const LOCKER_ID = 'sandbox_loadout';                     // the CosmeticLocker item's key
const DEFAULT_CHARACTER = `AthenaCharacter:${CHARACTERS[0]}`;
const DEFAULT_PICKAXE = `AthenaPickaxe:${PICKAXES[0]}`;
const DEFAULT_GLIDER = `AthenaGlider:${GLIDERS[0]}`;

/**
 * Build the initial athena blob (LawinServer template shape): every cosmetic owned and keyed by its
 * templateId, plus one CosmeticLocker item holding the equipped slots, plus the lobby-critical stats.
 * Written once on first access; after that the stored blob is the source of truth.
 */
export function buildSeedProfile(accountId: string): any {
  const now = new Date().toISOString();
  const items: Record<string, any> = {};
  for (const id of ALL_COSMETICS) {
    const templateId = `${getTemplatePrefix(id)}:${id}`;
    items[templateId] = {
      templateId,
      attributes: { favorite: false, item_seen: true, level: 1, max_level_bonus: 0, rnd_sel_cnt: 0, variants: [], xp: 0 },
      quantity: 1,
    };
  }
  // The CosmeticLocker item — SetCosmeticLockerSlot/EquipBattleRoyaleCustomization write locker_slots_data here.
  items[LOCKER_ID] = {
    templateId: 'CosmeticLocker:cosmeticlocker_athena',
    attributes: {
      locker_slots_data: {
        slots: {
          Pickaxe:         { items: [DEFAULT_PICKAXE], activeVariants: [null] },
          Dance:           { items: ['', '', '', '', '', ''], activeVariants: [] },
          Glider:          { items: [DEFAULT_GLIDER], activeVariants: [null] },
          Character:       { items: [DEFAULT_CHARACTER], activeVariants: [null] },
          Backpack:        { items: [''], activeVariants: [null] },
          ItemWrap:        { items: ['', '', '', '', '', '', ''], activeVariants: [null, null, null, null, null, null, null] },
          LoadingScreen:   { items: [''], activeVariants: [null] },
          MusicPack:       { items: [''], activeVariants: [null] },
          SkyDiveContrail: { items: [''], activeVariants: [null] },
        },
      },
      use_count: 0,
      banner_icon_template: 'BRSeason01',
      banner_color_template: 'DefaultColor1',
      locker_name: '',
      item_seen: true,
      favorite: false,
    },
    quantity: 1,
  };

  return {
    _id: accountId,
    accountId,
    profileId: 'athena',
    version: 'nova_lawin_ch1s7',
    created: now,
    updated: now,
    rvn: 1,
    wipeNumber: 1,
    items,
    stats: {
      attributes: {
        past_seasons: buildPastSeasons(),
        season_match_boost: 999,
        loadouts: [LOCKER_ID],
        mfa_reward_claimed: true,
        rested_xp_overflow: 0,
        current_mtx_platform: 'EpicPC',
        last_xp_interaction: now,
        quest_manager: { dailyLoginInterval: now, dailyQuestRerolls: 1 },
        book_level: Config.BATTLE_PASS_LEVEL,
        season_num: Config.SEASON_NUMBER,
        book_xp: 0,
        creative_dynamic_xp: {},
        season: { numWins: 999, numHighBracket: 999, numLowBracket: 999 },
        lifetime_wins: 999,
        book_purchased: true,
        purchased_battle_pass_tier_offers: [],
        rested_xp_exchange: 1,
        level: Config.BATTLE_PASS_LEVEL,
        xp_overflow: 0,
        rested_xp: 204800,
        rested_xp_mult: 4.55,
        accountLevel: Config.ACCOUNT_LEVEL,
        competitive_identity: {},
        inventory_limit_bonus: 0,
        last_applied_loadout: LOCKER_ID,
        active_loadout_index: 0,
        daily_rewards: { nextDefaultReward: 365, totalDaysLoggedIn: 365, lastClaimDate: now },
        xp: 0,
        season_friend_match_boost: 0,
        // Equipped selections as templateIds, matching the item keys and locker_slots_data.
        // Exact array lengths are load-bearing (client crashes otherwise): dance 6, wraps 7.
        favorite_character: DEFAULT_CHARACTER,
        favorite_backpack: '',
        favorite_pickaxe: DEFAULT_PICKAXE,
        favorite_glider: DEFAULT_GLIDER,
        favorite_skydivecontrail: '',
        favorite_dance: ['', '', '', '', '', ''],
        favorite_itemwraps: ['', '', '', '', '', '', ''],
        favorite_loadingscreen: '',
        favorite_musicpack: '',
        banner_icon: 'BRSeason01',
        banner_color: 'DefaultColor1',
        party_assist_quest: '',
        purchased_bp_offers: [],
        last_match_end_datetime: '',
        mtx_purchase_history_copy: [],
        permissions: [],
        season_update: 1,
      },
    },
    commandRevision: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MCP OPERATION HANDLERS (ported from LawinServer v1/v3)
//  7.40 is engine build < 12.20, so the revision the client sends in ?rvn is the
//  profile rvn. A change is delivered as a granular delta only when the client is
//  exactly in sync; otherwise it gets a fullProfileUpdate (self-healing resync).
// ─────────────────────────────────────────────────────────────────────────────

function envelope(profile: any, baseRevision: number, queryRevision: number, changes: any[]): any {
  const applyChanges = queryRevision !== baseRevision
    ? [{ changeType: 'fullProfileUpdate', profile }]
    : changes;
  return {
    profileRevision: profile.rvn || 0,
    profileId: 'athena',
    profileChangesBaseRevision: baseRevision,
    profileChanges: applyChanges,
    profileCommandRevision: profile.commandRevision || 0,
    serverTime: new Date().toISOString(),
    responseVersion: 1,
  };
}

/** Run a mutation against the account's profile, bump rvn/commandRevision if it changed, persist. */
function runOp(accountId: string, queryRevision: number, mutate: (p: any) => any[]): any {
  const profile = loadProfile(accountId);
  const baseRevision = profile.rvn;            // client's pre-op revision (7.40 build)
  const changes = mutate(profile) || [];
  if (changes.length > 0) {
    profile.rvn += 1;
    profile.commandRevision += 1;
    profile.updated = new Date().toISOString();
    persist(accountId, profile);
  }
  return envelope(profile, baseRevision, queryRevision, changes);
}

export function queryAthenaProfile(accountId: string, queryRevision: number): any {
  const profile = loadProfile(accountId);
  // Safety guard (LawinServer v3): if rvn ever equals commandRevision, nudge rvn so the client
  // re-syncs. After seeding they differ by 1 and each op bumps both, so this rarely fires.
  if (profile.rvn === profile.commandRevision) {
    profile.rvn += 1;
    const a = profile.stats.attributes;
    if (!a.last_applied_loadout && a.loadouts?.length) a.last_applied_loadout = a.loadouts[0];
    persist(accountId, profile);
  }
  return envelope(profile, profile.rvn, queryRevision, []);
}

/** Apply variantUpdates to an owned item, returning the itemAttrChanged change (or null). */
function applyVariants(profile: any, itemKey: string, variantUpdates: any[]): any | null {
  if (!Array.isArray(variantUpdates) || variantUpdates.length === 0) return null;
  const item = profile.items[itemKey];
  if (!item) return null;
  const vs = item.attributes.variants || (item.attributes.variants = []);
  for (const u of variantUpdates) {
    if (!u || !u.channel) continue;
    const ex = vs.find((v: any) => (v.channel || '').toLowerCase() === u.channel.toLowerCase());
    if (ex) ex.active = u.active;
    else vs.push({ channel: u.channel, active: u.active, owned: [] });
  }
  return { changeType: 'itemAttrChanged', itemId: itemKey, attributeName: 'variants', attributeValue: vs };
}

/** EquipBattleRoyaleCustomization — the Chapter 1 / 7.40 equip path. Writes favorite_* (statModified). */
export function equipBattleRoyaleCustomization(accountId: string, queryRevision: number, body: any): any {
  return runOp(accountId, queryRevision, (profile) => {
    const changes: any[] = [];
    const slotName: string = body.slotName;
    if (!slotName) return changes;
    const itemToSlot: string = body.itemToSlot || '';
    const index: number = typeof body.indexWithinSlot === 'number' ? body.indexWithinSlot : -1;
    const attrs = profile.stats.attributes;
    const locker = profile.items[attrs.loadouts[attrs.active_loadout_index]];
    const slots = locker?.attributes?.locker_slots_data?.slots || {};
    // Items are keyed by templateId, so itemToSlot IS the templateId.
    const templateId = profile.items[itemToSlot]?.templateId ?? itemToSlot;

    const v = applyVariants(profile, itemToSlot, body.variantUpdates);
    if (v) changes.push(v);

    if (slotName === 'Dance') {
      if (index >= 0 && index <= 5) {
        attrs.favorite_dance[index] = itemToSlot;
        if (slots.Dance) slots.Dance.items[index] = templateId;
      }
      changes.push({ changeType: 'statModified', name: 'favorite_dance', value: attrs.favorite_dance });
    } else if (slotName === 'ItemWrap') {
      if (index === -1) {
        for (let i = 0; i < 7; i++) { attrs.favorite_itemwraps[i] = itemToSlot; if (slots.ItemWrap) slots.ItemWrap.items[i] = templateId; }
      } else if (index >= 0 && index <= 7) {
        attrs.favorite_itemwraps[index] = itemToSlot;
        if (slots.ItemWrap) slots.ItemWrap.items[index] = templateId;
      }
      changes.push({ changeType: 'statModified', name: 'favorite_itemwraps', value: attrs.favorite_itemwraps });
    } else {
      const key = `favorite_${slotName.toLowerCase()}`;
      attrs[key] = itemToSlot;
      if (slots[slotName]) slots[slotName].items = [templateId];
      changes.push({ changeType: 'statModified', name: key, value: attrs[key] });
    }
    return changes;
  });
}

/** SetCosmeticLockerSlot — Chapter 2+ locker path. Writes locker_slots_data (itemAttrChanged). */
export function setCosmeticLockerSlot(accountId: string, queryRevision: number, body: any): any {
  return runOp(accountId, queryRevision, (profile) => {
    const changes: any[] = [];
    const category: string = body.category;
    const lockerItem: string = body.lockerItem;
    if (!category || !lockerItem) return changes;
    const locker = profile.items[lockerItem];
    if (!locker?.attributes?.locker_slots_data) return changes;
    const slots = locker.attributes.locker_slots_data.slots;
    const itemToSlot: string = body.itemToSlot || '';          // templateId
    const index: number = typeof body.slotIndex === 'number' ? body.slotIndex : -1;
    const attrs = profile.stats.attributes;

    const v = applyVariants(profile, itemToSlot, body.variantUpdates);
    if (v) changes.push(v);

    if (category === 'Dance') {
      if (index >= 0 && index <= 5) { if (slots.Dance) slots.Dance.items[index] = itemToSlot; attrs.favorite_dance[index] = itemToSlot; }
    } else if (category === 'ItemWrap') {
      if (index === -1) {
        for (let i = 0; i < 7; i++) { if (slots.ItemWrap) slots.ItemWrap.items[i] = itemToSlot; attrs.favorite_itemwraps[i] = itemToSlot; }
      } else if (index >= 0 && index <= 7) {
        if (slots.ItemWrap) slots.ItemWrap.items[index] = itemToSlot;
        attrs.favorite_itemwraps[index] = itemToSlot;
      }
    } else {
      if (slots[category]) slots[category].items = [itemToSlot];
      attrs[`favorite_${category.toLowerCase()}`] = itemToSlot;
    }
    changes.push({ changeType: 'itemAttrChanged', itemId: lockerItem, attributeName: 'locker_slots_data', attributeValue: locker.attributes.locker_slots_data });
    return changes;
  });
}

/** SetItemFavoriteStatus / ...Batch — mark owned items favorite. */
export function setItemFavorite(accountId: string, queryRevision: number, body: any): any {
  return runOp(accountId, queryRevision, (profile) => {
    const changes: any[] = [];
    const ids: string[] = Array.isArray(body.itemIds) ? body.itemIds : (body.targetItemId ? [body.targetItemId] : []);
    const statuses: any[] = Array.isArray(body.itemFavStatus) ? body.itemFavStatus : [body.bFavorite !== undefined ? body.bFavorite : body.favorite];
    for (let i = 0; i < ids.length; i++) {
      const item = profile.items[ids[i]];
      if (!item) continue;
      const fav = typeof statuses[i] === 'boolean' ? statuses[i] : !!statuses[0];
      item.attributes.favorite = fav;
      changes.push({ changeType: 'itemAttrChanged', itemId: ids[i], attributeName: 'favorite', attributeValue: fav });
    }
    return changes;
  });
}

/** MarkItemSeen — clear the "new" flash on owned items. */
export function markItemSeen(accountId: string, queryRevision: number, body: any): any {
  return runOp(accountId, queryRevision, (profile) => {
    const changes: any[] = [];
    const ids: string[] = Array.isArray(body.itemIds) ? body.itemIds : [];
    for (const id of ids) {
      const item = profile.items[id];
      if (!item) continue;
      item.attributes.item_seen = true;
      changes.push({ changeType: 'itemAttrChanged', itemId: id, attributeName: 'item_seen', attributeValue: true });
    }
    return changes;
  });
}

/** SetBattleRoyaleBanner — old stats-based banner (writes banner_icon/banner_color stats). */
export function setBattleRoyaleBanner(accountId: string, queryRevision: number, body: any): any {
  return runOp(accountId, queryRevision, (profile) => {
    const attrs = profile.stats.attributes;
    attrs.banner_icon = body.homebaseBannerIconId || attrs.banner_icon;
    attrs.banner_color = body.homebaseBannerColorId || attrs.banner_color;
    const locker = profile.items[attrs.loadouts[attrs.active_loadout_index]];
    if (locker) { locker.attributes.banner_icon_template = attrs.banner_icon; locker.attributes.banner_color_template = attrs.banner_color; }
    return [
      { changeType: 'statModified', name: 'banner_icon', value: attrs.banner_icon },
      { changeType: 'statModified', name: 'banner_color', value: attrs.banner_color },
    ];
  });
}

/** SetCosmeticLockerBanner — Chapter 2+ per-locker-item banner (itemAttrChanged). */
export function setCosmeticLockerBanner(accountId: string, queryRevision: number, body: any): any {
  return runOp(accountId, queryRevision, (profile) => {
    const lockerItem: string = body.lockerItem;
    const locker = lockerItem ? profile.items[lockerItem] : null;
    if (!locker) return [];
    locker.attributes.banner_icon_template = body.bannerIconTemplateName || locker.attributes.banner_icon_template;
    locker.attributes.banner_color_template = body.bannerColorTemplateName || locker.attributes.banner_color_template;
    profile.stats.attributes.banner_icon = body.bannerIconTemplateName || profile.stats.attributes.banner_icon;
    profile.stats.attributes.banner_color = body.bannerColorTemplateName || profile.stats.attributes.banner_color;
    return [
      { changeType: 'itemAttrChanged', itemId: lockerItem, attributeName: 'banner_icon_template', attributeValue: locker.attributes.banner_icon_template },
      { changeType: 'itemAttrChanged', itemId: lockerItem, attributeName: 'banner_color_template', attributeValue: locker.attributes.banner_color_template },
    ];
  });
}

/**
 * Grant cosmetic items into the athena blob (the locker's source of truth) — used by
 * PurchaseCatalogEntry / gifting. Idempotent: an already-owned item is left in place but still
 * reported so the client renders the reward. Returns the itemAdded deltas plus the post-grant
 * revisions so the MCP layer can build the `multiUpdate` athena entry alongside the common_core
 * (currency) response.
 */
export function grantAthenaItems(accountId: string, templateIds: string[]): {
  changes: any[]; profileRevision: number; commandRevision: number; baseRevision: number;
} {
  const profile = loadProfile(accountId);
  const baseRevision = profile.rvn;
  const changes: any[] = [];
  let mutated = false;
  for (const raw of templateIds) {
    const templateId = String(raw || '');
    if (!templateId) continue;
    if (!profile.items[templateId]) {
      profile.items[templateId] = {
        templateId,
        attributes: { favorite: false, item_seen: false, level: 1, max_level_bonus: 0, rnd_sel_cnt: 0, variants: [], xp: 0 },
        quantity: 1,
      };
      mutated = true;
    }
    changes.push({ changeType: 'itemAdded', itemId: templateId, item: profile.items[templateId] });
  }
  if (mutated) {
    profile.rvn += 1;
    profile.commandRevision += 1;
    profile.updated = new Date().toISOString();
    persist(accountId, profile);
  }
  return { changes, profileRevision: profile.rvn, commandRevision: profile.commandRevision, baseRevision };
}

/** Back-compat wrapper: the non-athena QueryProfile path and anything importing buildAthenaProfile. */
export function buildAthenaProfile(accountId: string): any {
  return loadProfile(accountId);
}
