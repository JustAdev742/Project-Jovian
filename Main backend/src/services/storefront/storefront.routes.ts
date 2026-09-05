import { FastifyInstance } from 'fastify';
import { keychainForBuild, buildString } from '../../version/keychain';

// Build the shop once at module load so both the catalog endpoint AND PurchaseCatalogEntry (MCP)
// resolve the SAME offers — the offer's itemGrants/finalPrice are the server-authoritative source
// of truth for a purchase, not anything the client sends in the request body.
const DAILY_ENTRIES = buildShopEntries('daily', 6);
// Start the weekly panel after the 6 skins the daily panel took, otherwise both storefronts sell
// the same first four skins under different offerIds.
const WEEKLY_ENTRIES = buildShopEntries('weekly', 4, 6);
const OFFERS_BY_ID = new Map<string, any>(
  [...DAILY_ENTRIES, ...WEEKLY_ENTRIES].map(e => [e.offerId, e])
);

export interface CatalogOffer {
  offerId: string;
  finalPrice: number;
  itemGrants: { templateId: string; quantity: number }[];
}

/** Look up a shop offer by its offerId (used by PurchaseCatalogEntry to grant the right items). */
export function findCatalogOffer(offerId: string): CatalogOffer | null {
  const e = OFFERS_BY_ID.get(offerId);
  if (!e) return null;
  const finalPrice = Array.isArray(e.prices) && e.prices[0] ? Number(e.prices[0].finalPrice) || 0 : 0;
  return { offerId: e.offerId, finalPrice, itemGrants: e.itemGrants || [] };
}

export async function storefrontRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/fortnite/api/storefront/v2/catalog', async (request, reply) => {
    return reply.send({
      refreshIntervalHrs: 24,
      dailyPurchaseHrs: 24,
      expiration: new Date(Date.now() + 86400000).toISOString(),
      storefronts: [
        { name: 'BRDailyStorefront', catalogEntries: DAILY_ENTRIES },
        { name: 'BRWeeklyStorefront', catalogEntries: WEEKLY_ENTRIES },
      ],
    });
  });

  /**
   * Keychain — the AES keys that decrypt a build's encrypted cosmetic pak chunks.
   *
   * PER-BUILD, because the keys are. Chunk keys do not carry forward between builds: serving 7.40's
   * to an 8.00 client hands it keys for chunks that build does not have, which is worse than serving
   * none because it presents as a decryption failure rather than a missing key. So the lookup is
   * exact, and an unknown build gets an empty array — the same thing it got before this endpoint
   * knew about any build but 7.40.
   *
   * Data: `version/keychain.ts`, generated from the Fortnite-Aes-Keys-Archive corpus — 75 builds,
   * 634 keys, CONFIRMED. 66 chunks are recorded there as `???` and are omitted rather than guessed;
   * the cosmetics inside them stay undecryptable, which is an evidence gap and not a defect.
   *
   * This is the first endpoint in the project whose response genuinely differs by build. Before it,
   * every client got 7.40's two keys.
   */
  fastify.get('/fortnite/api/storefront/v2/keychain', async (request, reply) => {
    const v = (request as any).gameVersion as { major?: number; minor?: number } | undefined;
    const build =
      Number.isFinite(v?.major) && Number.isFinite(v?.minor)
        ? buildString(v!.major!, v!.minor!)
        : null;

    const chain = build ? keychainForBuild(build) : null;
    if (!chain) {
      // Unknown or unparseable build. An empty keychain means "no encrypted chunks I can help with",
      // which the client handles; a wrong key would not be.
      return reply.send([]);
    }
    return reply.send(chain.entries);
  });
}

function buildShopEntries(type: string, count: number, offset: number = 0): any[] {
  const skins = ['CID_030_Athena_Commando_M_Halloween','CID_053_Athena_Commando_M_SkullTrooper',
    'CID_029_Athena_Commando_F_Halloween','CID_035_Athena_Commando_M_Medieval',
    'CID_071_Athena_Commando_M_Wukong','CID_082_Athena_Commando_M_Vampire',
    'CID_102_Athena_Commando_M_Raven','CID_175_Athena_Commando_M_Celestial',
    'CID_207_Athena_Commando_M_BuffCat','CID_242_Athena_Commando_F_Bullseye'];

  const entries: any[] = [];
  for (let i = 0; i < count; i++) {
    const skin = skins[(i + offset) % skins.length];
    const templateId = `AthenaCharacter:${skin}`;
    entries.push({
      offerId: `nova-offer-${type}-${i}`,
      devName: `Nova_${type}_${i}`,
      offerType: 'StaticPrice',
      prices: [{ currencyType: 'MtxCurrency', currencySubType: '', regularPrice: 1500, finalPrice: 1500, saleExpiration: '9999-12-31T23:59:59.999Z', basePrice: 1500 }],
      categories: [],
      dailyLimit: -1, weeklyLimit: -1, monthlyLimit: -1,
      refundable: true,
      appStoreId: [],
      // NO DenyOnItemOwnership here. buildSeedProfile grants every cosmetic in ALL_COSMETICS at
      // first profile load, and all of these shop skins are in that list — so an ownership
      // requirement matches on every account and the client greys out the entire shop, every tile,
      // permanently. Re-granting is idempotent, so allowing the purchase is harmless.
      requirements: [],
      // TileSize drives the small-vs-large tile layout in the C1 shop panel; without it the
      // featured row loses its large tiles.
      metaInfo: [
        { key: 'SectionId', value: type === 'daily' ? 'Daily' : 'Featured' },
        { key: 'TileSize', value: type === 'daily' ? 'Small' : 'Normal' },
      ],
      meta: { SectionId: type === 'daily' ? 'Daily' : 'Featured', TileSize: type === 'daily' ? 'Small' : 'Normal' },
      catalogGroup: '',
      catalogGroupPriority: 0,
      sortPriority: i,
      title: `Shop Item ${i + 1}`,
      itemGrants: [{ templateId: `AthenaCharacter:${skin}`, quantity: 1 }],
      giftInfo: { bIsEnabled: true, forcedGiftBoxTemplateId: '', purchaseRequirements: [], giftRecordIds: [] },
      fulfillmentIds: [],
      filterWeight: 0,
      displayAssetPath: '',
    });
  }
  return entries;
}
