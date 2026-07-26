import { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.middleware';
import { handleQueryProfile } from './operations/QueryProfile';
import {
  queryAthenaProfile,
  equipBattleRoyaleCustomization,
  setCosmeticLockerSlot,
  setCosmeticLockerBanner,
  setBattleRoyaleBanner,
  setItemFavorite,
  markItemSeen,
  grantAthenaItems,
} from './profiles/athena';
import { findCatalogOffer } from '../storefront/storefront.routes';
import { Errors } from '../../utils/error-handler';
import { getCurrency, updateCurrency } from '../../database';
import { buildDeterministicGuid } from '../../utils/uuid';

/** Minimal valid MCP envelope for ops that don't mutate a profile. */
function emptyEnvelope(profileId: string, rvn: number): any {
  const r = rvn > 0 ? rvn : 1;
  return {
    profileRevision: r,
    profileId,
    profileChangesBaseRevision: r,
    profileChanges: [],
    profileCommandRevision: r,
    serverTime: new Date().toISOString(),
    responseVersion: 1,
  };
}

/**
 * MCP Routes — Handles ALL profile operations.
 * POST /fortnite/api/game/v2/profile/:accountId/client/:operation
 */
export async function mcpRoutes(fastify: FastifyInstance): Promise<void> {

  /** Core MCP handler — shared by client + dedicated_server + public routes */
  async function handleMcpOperation(request: any, reply: any, isPublic: boolean = false) {
    const { accountId, operation } = request.params as { accountId: string; operation: string };
    const query = request.query as Record<string, string>;
    const profileId = query.profileId || (isPublic ? 'common_public' : 'athena');
    const rvn = parseInt(query.rvn || '-1', 10);
    const body = request.body || {};

    try {
      let response: any;

      switch (operation) {
        case 'QueryProfile':
        case 'SetMCPEnabled':
          response = profileId === 'athena'
            ? queryAthenaProfile(accountId, rvn)
            : handleQueryProfile(accountId, profileId, rvn);
          break;
        case 'ClientQuestLogin':
          // Route through the real profile path. The standalone handler echoed the client's own
          // rvn back (rvn=-1 => profileRevision:-1, since `rvn || 1` does not filter -1), so the
          // client cached a negative revision and every later op force-resynced.
          response = profileId === 'athena'
            ? queryAthenaProfile(accountId, rvn)
            : handleQueryProfile(accountId, profileId, rvn);
          break;

        // ── Locker / cosmetics — LawinServer-style blob handlers (athena) ──
        case 'EquipBattleRoyaleCustomization':
          response = equipBattleRoyaleCustomization(accountId, rvn, body);
          break;
        case 'SetCosmeticLockerSlot':
          response = setCosmeticLockerSlot(accountId, rvn, body);
          break;
        case 'SetCosmeticLockerBanner':
          response = setCosmeticLockerBanner(accountId, rvn, body);
          break;
        case 'SetBattleRoyaleBanner':
          response = setBattleRoyaleBanner(accountId, rvn, body);
          break;
        case 'SetItemFavoriteStatus':
        case 'SetItemFavoriteStatusBatch':
          response = setItemFavorite(accountId, rvn, body);
          break;
        case 'MarkItemSeen':
          response = profileId === 'athena'
            ? markItemSeen(accountId, rvn, body)
            : emptyEnvelope(profileId, rvn);
          break;

        // ═══════════════════════════════════════════════
        //  REAL OPERATIONS (DB-backed)
        // ═══════════════════════════════════════════════

        case 'PurchaseCatalogEntry': {
          const offerId = body.offerId || '';
          const quantity = Math.max(1, Number(body.purchaseQuantity) || 1);
          // The catalog offer — NOT the request body — is the authority on what is granted and what
          // it costs. The client's PurchaseCatalogEntry payload carries only offerId/quantity/price;
          // it never sends itemGrants, and its expectedTotalPrice must not be trusted as the charge.
          const offer = findCatalogOffer(offerId);
          const purchasePrice = offer ? offer.finalPrice * quantity : (Number(body.expectedTotalPrice) || 0);
          const currency = getCurrency(accountId);
          const totalMtx = currency.mtx_purchased + currency.mtx_earned;
          const baseRvn = rvn > 0 ? rvn : 1;

          if (purchasePrice > 0 && totalMtx < purchasePrice) {
            response = {
              profileRevision: baseRvn,
              profileId,
              profileChangesBaseRevision: baseRvn,
              profileChanges: [],
              profileCommandRevision: baseRvn,
              serverTime: new Date().toISOString(),
              responseVersion: 1,
              errorCode: 'errors.com.epicgames.modules.gamesubcatalog.purchase_not_allowed',
              errorMessage: 'Insufficient V-Bucks',
            };
            break;
          }

          if (purchasePrice > 0) updateCurrency(accountId, -purchasePrice);

          // Grant the offer's items into the athena blob (the locker's source of truth), delivered
          // to the client as a `multiUpdate` athena entry. The currency delta stays on this
          // common_core response and a CatalogPurchase notification drives the reward popup.
          const templateIds = (offer?.itemGrants || []).map(g => g.templateId).filter(Boolean);
          const grant = templateIds.length ? grantAthenaItems(accountId, templateIds) : null;

          const newCurrency = getCurrency(accountId);
          const mtxGuid = buildDeterministicGuid(`${accountId}:Currency:MtxPurchased`);

          response = {
            profileRevision: baseRvn + 1,
            profileId,
            profileChangesBaseRevision: baseRvn,
            profileChanges: [{
              changeType: 'itemQuantityChanged',
              itemId: mtxGuid,
              quantity: newCurrency.mtx_purchased + newCurrency.mtx_earned,
            }],
            profileCommandRevision: baseRvn + 1,
            serverTime: new Date().toISOString(),
            responseVersion: 1,
            notifications: [{
              type: 'CatalogPurchase',
              primary: true,
              lootResult: {
                items: (offer?.itemGrants || []).map(g => ({
                  itemType: g.templateId,
                  itemGuid: g.templateId,
                  itemProfile: 'athena',
                  quantity: g.quantity || 1,
                })),
              },
            }],
            ...(grant ? {
              multiUpdate: [{
                profileRevision: grant.profileRevision,
                profileId: 'athena',
                profileChangesBaseRevision: grant.baseRevision,
                profileChanges: grant.changes,
                profileCommandRevision: grant.commandRevision,
              }],
            } : {}),
          };
          console.log(`[MCP] Purchase: ${accountId} bought ${offerId || '(unknown offer)'} for ${purchasePrice} V-Bucks (${templateIds.length} item(s))`);
          break;
        }

        case 'RefundMtxPurchase': {
          // Credit V-Bucks back (simplified — no real purchase history tracking yet)
          // Refund only what the request actually states. `|| 1500` credited a flat 1500 V-Bucks on
          // every refund regardless of the item's price, so refunding an 800 V-Buck item netted +700.
          const refundAmount = Math.max(0, Number(body.expectedTotalPrice) || 0);
          updateCurrency(accountId, refundAmount);
          const newCurrencyAfterRefund = getCurrency(accountId);
          const refundMtxGuid = buildDeterministicGuid(`${accountId}:Currency:MtxPurchased`);

          response = {
            profileRevision: (rvn > 0 ? rvn : 1) + 1,
            profileId,
            profileChangesBaseRevision: rvn > 0 ? rvn : 1,
            profileChanges: [{
              changeType: 'itemQuantityChanged',
              itemId: refundMtxGuid,
              quantity: newCurrencyAfterRefund.mtx_purchased + newCurrencyAfterRefund.mtx_earned,
            }],
            profileCommandRevision: (rvn > 0 ? rvn : 1) + 1,
            serverTime: new Date().toISOString(),
            responseVersion: 1,
          };
          console.log(`[MCP] Refund: ${accountId} refunded ${refundAmount} V-Bucks`);
          break;
        }

        // Operations that just need an empty valid MCP response
        case 'MarkNewQuestNotificationSent':
        case 'FortRerollDailyQuest':
        case 'AthenaPinQuest':
        case 'RefreshExpeditions':
        case 'GetMcpTimeForLogin':
        case 'IncrementNamedCounterStat':
        case 'SetAffiliateName':
        case 'SetReceiveGiftsEnabled':
        case 'RemoveGiftBox':
        case 'GiftCatalogEntry':
        case 'ClaimMfaEnabled':
        case 'CopyCosmeticLoadout':
        case 'DeleteCosmeticLoadout':
        case 'PopulatePrerolledOffers':
        case 'ClaimLoginReward':
        case 'VerifyRealMoneyPurchase':
        case 'SetMatchmakingBans':
        case 'SetHardcoreModifier':
        case 'AssignGadgetToLoadout':
        case 'SetPinnedQuests':
        case 'CompletePlayerSurvey':
        case 'ApplyConsumable':
          // These are no-ops on Nova (progression is already maxed / everything unlocked), so they
          // must NOT advance the revision. Bumping profileRevision by +1 without persisting a change
          // (the old behaviour) pushed the client's rvn ahead of the stored profile, forcing a full
          // fullProfileUpdate resync on the very next real op. Echo the current revision unchanged.
          response = emptyEnvelope(profileId, rvn);
          break;

        default:
          // CRITICAL: Never return a 404 for unknown operations — return empty success
          console.warn(`[MCP] Unknown operation: ${operation} for profile ${profileId}`);
          response = {
            profileRevision: rvn > 0 ? rvn : 1,
            profileId,
            profileChangesBaseRevision: rvn > 0 ? rvn : 1,
            profileChanges: [],
            profileCommandRevision: rvn > 0 ? rvn : 1,
            serverTime: new Date().toISOString(),
            responseVersion: 1,
          };
      }

      return reply.send(response);
    } catch (error) {
      console.error(`[MCP] Error in operation ${operation}:`, error);
      return Errors.serverError(reply, `MCP operation ${operation} failed`);
    }
  }

  // Client operations (requires auth)
  // requireAuth only proves the caller holds *a* valid token — it does NOT prove the token belongs
  // to :accountId. Without this check any player's token could read or mutate any other account:
  // verified exploitable by rewriting a second account's locker via EquipBattleRoyaleCustomization
  // (and the same route reaches PurchaseCatalogEntry, i.e. draining their V-Bucks).
  fastify.post('/fortnite/api/game/v2/profile/:accountId/client/:operation', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const tokenAccountId = (request as any).accountId as string | null;
    const { accountId } = request.params as { accountId: string };
    if (tokenAccountId && accountId !== tokenAccountId) {
      return Errors.unauthorized(reply, 'Token does not grant access to this account.');
    }
    return handleMcpOperation(request, reply);
  });

  // Dedicated server operations (game server → backend)
  fastify.post('/fortnite/api/game/v2/profile/:accountId/dedicated_server/:operation', async (request, reply) => {
    return handleMcpOperation(request, reply);
  });

  // Public operations (no auth required)
  fastify.post('/fortnite/api/game/v2/profile/:accountId/public/:operation', async (request, reply) => {
    return handleMcpOperation(request, reply, true);
  });
}
