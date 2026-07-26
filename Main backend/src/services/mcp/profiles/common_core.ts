import { buildDeterministicGuid } from '../../../utils/uuid';
import { getCurrency, getInventory } from '../../../database';

// The locker's banner picker is populated from the HomebaseBannerIcon/HomebaseBannerColor items the
// player OWNS in common_core. Without them the "Edit banner" screen is empty and the banner cannot be
// changed. Full Chapter 1-era set, ported verbatim from the LawinServer common_core profile.
const BANNER_ICONS: string[] = [
  'BRSeason01', 'BRSeason02Bowling', 'BRSeason02Bush', 'BRSeason02Cake', 'BRSeason02CatSoldier', 'BRSeason02Crosshair',
  'BRSeason02Dragon', 'BRSeason02GasMask', 'BRSeason02IceCream', 'BRSeason02LionHerald', 'BRSeason02Log', 'BRSeason02MonsterTruck',
  'BRSeason02Planet', 'BRSeason02Salt', 'BRSeason02Sawhorse', 'BRSeason02Shark', 'BRSeason02Tank', 'BRSeason02Vulture',
  'BRSeason03Bee', 'BRSeason03Chick', 'BRSeason03Chicken', 'BRSeason03Crab', 'BRSeason03CrescentMoon', 'BRSeason03DeadFish',
  'BRSeason03DinosaurSkull', 'BRSeason03DogCollar', 'BRSeason03Donut', 'BRSeason03Eagle', 'BRSeason03Egg', 'BRSeason03Falcon',
  'BRSeason03Flail', 'BRSeason03HappyCloud', 'BRSeason03Lantern', 'BRSeason03Lightning', 'BRSeason03Paw', 'BRSeason03Shark',
  'BRSeason03ShootingStar', 'BRSeason03Snake', 'BRSeason03Sun', 'BRSeason03TeddyBear', 'BRSeason03TopHat', 'BRSeason03Whale',
  'BRSeason03Wing', 'BRSeason03Wolf', 'BRSeason03Worm', 'FounderTier1Banner1', 'FounderTier1Banner2', 'FounderTier1Banner3',
  'FounderTier1Banner4', 'FounderTier2Banner1', 'FounderTier2Banner2', 'FounderTier2Banner3', 'FounderTier2Banner4', 'FounderTier2Banner5',
  'FounderTier2Banner6', 'FounderTier3Banner1', 'FounderTier3Banner2', 'FounderTier3Banner3', 'FounderTier3Banner4', 'FounderTier3Banner5',
  'FounderTier4Banner1', 'FounderTier4Banner2', 'FounderTier4Banner3', 'FounderTier4Banner4', 'FounderTier4Banner5', 'FounderTier5Banner1',
  'FounderTier5Banner2', 'FounderTier5Banner3', 'FounderTier5Banner4', 'FounderTier5Banner5', 'InfluencerBanner1', 'InfluencerBanner10',
  'InfluencerBanner11', 'InfluencerBanner12', 'InfluencerBanner13', 'InfluencerBanner14', 'InfluencerBanner15', 'InfluencerBanner16',
  'InfluencerBanner17', 'InfluencerBanner18', 'InfluencerBanner19', 'InfluencerBanner2', 'InfluencerBanner20', 'InfluencerBanner21',
  'InfluencerBanner22', 'InfluencerBanner23', 'InfluencerBanner24', 'InfluencerBanner25', 'InfluencerBanner26', 'InfluencerBanner27',
  'InfluencerBanner28', 'InfluencerBanner29', 'InfluencerBanner3', 'InfluencerBanner30', 'InfluencerBanner31', 'InfluencerBanner32',
  'InfluencerBanner33', 'InfluencerBanner34', 'InfluencerBanner35', 'InfluencerBanner36', 'InfluencerBanner37', 'InfluencerBanner38',
  'InfluencerBanner39', 'InfluencerBanner4', 'InfluencerBanner40', 'InfluencerBanner41', 'InfluencerBanner42', 'InfluencerBanner43',
  'InfluencerBanner44', 'InfluencerBanner45', 'InfluencerBanner46', 'InfluencerBanner47', 'InfluencerBanner48', 'InfluencerBanner49',
  'InfluencerBanner5', 'InfluencerBanner50', 'InfluencerBanner51', 'InfluencerBanner52', 'InfluencerBanner53', 'InfluencerBanner54',
  'InfluencerBanner55', 'InfluencerBanner56', 'InfluencerBanner57', 'InfluencerBanner58', 'InfluencerBanner6', 'InfluencerBanner7',
  'InfluencerBanner8', 'InfluencerBanner9', 'NewsletterBanner', 'OT10Banner', 'OT11Banner', 'OT1Banner',
  'OT2Banner', 'OT3Banner', 'OT4Banner', 'OT5Banner', 'OT6Banner', 'OT7Banner',
  'OT8Banner', 'OT9Banner', 'OtherBanner1', 'OtherBanner10', 'OtherBanner11', 'OtherBanner12',
  'OtherBanner13', 'OtherBanner14', 'OtherBanner15', 'OtherBanner16', 'OtherBanner17', 'OtherBanner18',
  'OtherBanner19', 'OtherBanner2', 'OtherBanner20', 'OtherBanner21', 'OtherBanner22', 'OtherBanner23',
  'OtherBanner24', 'OtherBanner25', 'OtherBanner26', 'OtherBanner27', 'OtherBanner28', 'OtherBanner29',
  'OtherBanner3', 'OtherBanner30', 'OtherBanner31', 'OtherBanner32', 'OtherBanner33', 'OtherBanner34',
  'OtherBanner35', 'OtherBanner36', 'OtherBanner37', 'OtherBanner38', 'OtherBanner39', 'OtherBanner4',
  'OtherBanner40', 'OtherBanner41', 'OtherBanner42', 'OtherBanner43', 'OtherBanner44', 'OtherBanner45',
  'OtherBanner46', 'OtherBanner47', 'OtherBanner48', 'OtherBanner49', 'OtherBanner5', 'OtherBanner50',
  'OtherBanner51', 'OtherBanner52', 'OtherBanner53', 'OtherBanner54', 'OtherBanner55', 'OtherBanner56',
  'OtherBanner57', 'OtherBanner58', 'OtherBanner59', 'OtherBanner6', 'OtherBanner60', 'OtherBanner61',
  'OtherBanner62', 'OtherBanner63', 'OtherBanner64', 'OtherBanner65', 'OtherBanner66', 'OtherBanner67',
  'OtherBanner68', 'OtherBanner69', 'OtherBanner7', 'OtherBanner70', 'OtherBanner71', 'OtherBanner72',
  'OtherBanner73', 'OtherBanner74', 'OtherBanner75', 'OtherBanner76', 'OtherBanner77', 'OtherBanner78',
  'OtherBanner8', 'OtherBanner9', 'StandardBanner1', 'StandardBanner10', 'StandardBanner11', 'StandardBanner12',
  'StandardBanner13', 'StandardBanner14', 'StandardBanner15', 'StandardBanner16', 'StandardBanner17', 'StandardBanner18',
  'StandardBanner19', 'StandardBanner2', 'StandardBanner20', 'StandardBanner21', 'StandardBanner22', 'StandardBanner23',
  'StandardBanner24', 'StandardBanner25', 'StandardBanner26', 'StandardBanner27', 'StandardBanner28', 'StandardBanner29',
  'StandardBanner3', 'StandardBanner30', 'StandardBanner31', 'StandardBanner4', 'StandardBanner5', 'StandardBanner6',
  'StandardBanner7', 'StandardBanner8', 'StandardBanner9', 'SurvivalBannerCannyValleyComplete', 'SurvivalBannerHolidayEasy', 'SurvivalBannerHolidayHard',
  'SurvivalBannerHolidayMed', 'SurvivalBannerPlankertonComplete', 'SurvivalBannerStonewoodComplete', 'SurvivalBannerStorm2018Easy', 'SurvivalBannerStorm2018Hard', 'SurvivalBannerStorm2018Med',
];
const BANNER_COLORS: string[] = [
  'DefaultColor1', 'DefaultColor10', 'DefaultColor11', 'DefaultColor12', 'DefaultColor13', 'DefaultColor14',
  'DefaultColor15', 'DefaultColor16', 'DefaultColor17', 'DefaultColor18', 'DefaultColor19', 'DefaultColor2',
  'DefaultColor20', 'DefaultColor21', 'DefaultColor3', 'DefaultColor4', 'DefaultColor5', 'DefaultColor6',
  'DefaultColor7', 'DefaultColor8', 'DefaultColor9',
];
// Built once (keyed by templateId, matching the reference item shape) and spread into every
// common_core response; the objects are read-only (common_core is rebuilt per QueryProfile).
const BANNER_ITEMS: Record<string, any> = {};
for (const id of BANNER_ICONS) BANNER_ITEMS['HomebaseBannerIcon:' + id] = { templateId: 'HomebaseBannerIcon:' + id, attributes: { item_seen: true }, quantity: 1 };
for (const id of BANNER_COLORS) BANNER_ITEMS['HomebaseBannerColor:' + id] = { templateId: 'HomebaseBannerColor:' + id, attributes: { item_seen: true }, quantity: 1 };

export function buildCommonCoreProfile(accountId: string): any {
  const now = new Date().toISOString();
  // CRITICAL: V-Bucks GUID must be deterministic — same account = same GUID every call
  const mtxGuid = buildDeterministicGuid(`${accountId}:Currency:MtxPurchased`);

  // Read real currency from DB
  const currency = getCurrency(accountId);
  const totalMtx = currency.mtx_purchased + currency.mtx_earned;

  return {
    _id: accountId,
    accountId,
    profileId: 'common_core',
    version: 'nova_backend',
    created: now,
    updated: now,
    rvn: 1,
    wipeNumber: 1,
    items: {
      // Owned banner icons/colors so the locker's banner picker is populated (not empty).
      ...BANNER_ITEMS,
      [mtxGuid]: {
        templateId: 'Currency:MtxPurchased',
        attributes: { platform: 'EpicPC' },
        quantity: totalMtx,
      },
    },
    stats: {
      attributes: {
        mtx_affiliate: '',
        mtx_affiliate_set_time: '',
        current_mtx_platform: 'EpicPC',
        mtx_purchase_history: { refundsUsed: 0, refundCredits: 3, purchases: [] },
        gift_history: { num_sent: 0, sentTo: {}, num_received: 0, receivedFrom: {} },
        allowed_to_send_gifts: true,
        mfa_enabled: true,
        allowed_to_receive_gifts: true,
        gift_reminder_cooldown: now,
        ban_history: { banCount: 0 },
        ban_status: { bRequiresUserAck: false, banReasons: [] },
        survey_data: {},
        personal_offers: {},
        intro_game_played: true,
        forced_intro_played: 'Coconut',
        permissions: [],
        inventory_limit_bonus: 0,
        import_friends_claimed: {},
        mtx_affiliate_id: '',
        undo_cooldowns: [],
        undo_timeout: 'min',
        in_app_purchases: { receipts: [], ignoredReceipts: [], fulfillmentCounts: {} },
        current_mtx_total: totalMtx,
        weekly_purchases: {},
        daily_purchases: {},
        monthly_purchases: {},
        homebase_name: 'Project Nova',
      },
    },
    commandRevision: 1,
  };
}

export function buildCommonPublicProfile(accountId: string): any {
  return {
    _id: accountId, accountId, profileId: 'common_public',
    version: 'nova_backend', created: new Date().toISOString(),
    updated: new Date().toISOString(), rvn: 1, wipeNumber: 1,
    items: {}, stats: { attributes: { banner_icon: 'BRSeason01', banner_color: 'DefaultColor1', homebase_name: 'Project Nova' } },
    commandRevision: 1,
  };
}

/** Campaign (Save the World) stub profile — client queries this even in BR mode */
export function buildCampaignProfile(accountId: string): any {
  const now = new Date().toISOString();
  return {
    _id: accountId, accountId, profileId: 'campaign',
    version: 'nova_backend', created: now, updated: now,
    rvn: 1, wipeNumber: 1, items: {},
    stats: {
      attributes: {
        node_costs: {},
        mission_alert_redemption_record: { claimData: [] },
        twitch: {},
        client_settings: { pinnedQuestInstances: [] },
        level: 310,
        named_counters: {},
        default_hero_squad_id: '',
        collection_book: {},
        quest_manager: { dailyLoginInterval: now, dailyQuestRerolls: 1 },
        campaign_stats: [],
        gameplay_stats: [],
        event_currency: {},
        matches_played: 0,
        daily_rewards: { nextDefaultReward: 365, totalDaysLoggedIn: 365, lastClaimDate: now },
        mode_loadouts: [],
        inventory_limit_bonus: 0,
        current_mtx_platform: 'EpicPC',
        weekly_profile_token_grant: {},
      },
    },
    commandRevision: 1,
  };
}

/** Metadata profile — internal Epic profile, needs stub */
export function buildMetadataProfile(accountId: string): any {
  return {
    _id: accountId, accountId, profileId: 'metadata',
    version: 'nova_backend', created: new Date().toISOString(),
    updated: new Date().toISOString(), rvn: 1, wipeNumber: 1,
    items: {}, stats: { attributes: {} },
    commandRevision: 1,
  };
}

/** Collection book / theater / outpost stubs */
export function buildStubProfile(accountId: string, profileId: string): any {
  return {
    _id: accountId, accountId, profileId,
    version: 'nova_backend', created: new Date().toISOString(),
    updated: new Date().toISOString(), rvn: 1, wipeNumber: 1,
    items: {}, stats: { attributes: {} },
    commandRevision: 1,
  };
}
