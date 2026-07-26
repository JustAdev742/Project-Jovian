import { FastifyInstance } from 'fastify';
import { generateUUID } from '../../utils/uuid';

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

  // Keychain endpoint — returns the AES keys for decryption
  fastify.get('/fortnite/api/storefront/v2/keychain', async (request, reply) => {
    // Fortnite expects keys in the format: "GUID:Base64EncodedKey"
    return reply.send([
      // pakchunk1003
      "91C415954BF27B6E43970FB8A75FE8BB:YhHyxIA+Ru33r3pThiWqKNYdvDbL05yXSxKarRuMSxw=",
      // pakchunk1004
      "D776CA2A40FD9EC1F8522E9E13E99031:uRYulzQ2zdGG9UisQw2wM9OOM/9JsSWFwFt5d/3okng="
    ]);
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
