import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recordDiagnostic } from '../nova/diagnostics';
import { getAccount, getLauncherAccountByEmail } from '../../database';

/**
 * Latent client endpoints — everything the 7.40 client CAN call that had no route.
 *
 * WHERE THIS LIST COMES FROM
 * --------------------------
 * Not from guesswork. Every `api/...` string literal was extracted from
 * FortniteClient-Win64-Shipping.exe (7.40) in both ASCII and UTF-16LE — see tools/binscan.js and
 * VERSION_COMPATIBILITY.md §2a. That yields 83 path fragments the build knows about; 44 already had
 * a route, and the 39 handled here did not. None of the 39 appeared in the six retained sessions,
 * so all of them were previously answered by the catch-all in index.ts.
 *
 * THE RULE THIS FILE FOLLOWS
 * --------------------------
 * A route that returns the WRONG shape is worse than no route at all. An unrouted GET currently
 * gets `200 {}` and an unrouted POST gets `204`, and the client tolerates both; a plausible-looking
 * but wrong body can be parsed and then fail somewhere further away from the cause. So:
 *
 *   - Tier 1 — a documented or reference-backed shape exists  -> return THAT shape.
 *   - Tier 2 — no authoritative shape                          -> return EXACTLY what the catch-all
 *                                                                 already returned, and record a
 *                                                                 diagnostic so we find out it was
 *                                                                 called.
 *
 * Nothing here is invented. Where the evidence runs out, the behaviour is unchanged by construction.
 *
 * WHY THE `/:service/` PREFIX ON SOME ROUTES
 * ------------------------------------------
 * The client stores path FRAGMENTS and prepends a service base URL at runtime — the binary contains
 * `%s/api/accesscontrol/status`, never the whole URL — so for endpoints the documentation does not
 * cover, the owning service is genuinely UNKNOWN. Rather than invent a prefix (and route nothing at
 * all, because the guess would not match), those are registered with a parametric first segment so
 * they match whichever service the client actually uses. Fastify resolves static segments before
 * parametric ones, so these can never shadow a real route.
 *
 * WHEN EVIDENCE ARRIVES for any Tier 2 entry, move it up: replace the stub with the real shape and
 * note it in VERSION_COMPATIBILITY.md.
 */

/** Answer exactly as the catch-all would, but leave a countable trace that it happened.
 *
 *  Recorded as UNKNOWN rather than MISSING on purpose: MISSING means "no route matched and we have
 *  no idea what this is", and these are the opposite — known client endpoints whose response shape
 *  is undocumented. Keeping them in separate categories is what stops this file from silently
 *  swallowing the diagnostic signal it was built alongside. */
function stub(label: string) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    recordDiagnostic({
      category: 'UNKNOWN',
      method: request.method,
      url: request.url,
      version: (request as any).gameVersion?.id,
      accountId: (request as any).accountId,
      status: request.method === 'GET' ? 200 : 204,
      detail: `routed stub (${label}) — known 7.40 client endpoint, no documented response shape; answering as the catch-all did`,
    });
    if (request.method === 'GET') return reply.send({});
    return reply.status(204).send();
  };
}

export async function latentRoutes(fastify: FastifyInstance): Promise<void> {

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // TIER 1 — documented or reference-backed shapes
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /** Documented: `Status 204` means "has entitlement". Returning `{}` (what the catch-all did) is a
   *  200 with a body where the client expects an empty 204. */
  fastify.get('/fortnite/api/entitlementCheck', async (_request, reply) => reply.status(204).send());

  /** Documented alongside entitlementCheck: 204 on success. `redeem_access` is the form the 7.40
   *  binary carries (`%s/api/storeaccess/v1/redeem_access/%s`); `request_access` is the form the
   *  endpoint documentation carries. Both answered the same way — same family, same success shape. */
  fastify.post('/fortnite/api/storeaccess/v1/request_access/:accountId', async (_request, reply) => reply.status(204).send());
  fastify.post('/fortnite/api/storeaccess/v1/redeem_access/:accountId', async (_request, reply) => reply.status(204).send());
  fastify.get('/fortnite/api/storeaccess/v1/redeem_access/:accountId', async (_request, reply) => reply.status(204).send());

  /** Documented shape: {accountId, totalStorage, totalUsed}. `totalStorage` is Int64.MAX in Epic's
   *  own example — this backend imposes no quota either, so the same value is the honest answer.
   *
   *  SERIALISED BY HAND, and it has to be. 9223372036854775807 cannot be represented as a JavaScript
   *  double: the nearest value is 9223372036854775808, which `JSON.stringify` emits as
   *  9223372036854776000 — a number strictly GREATER than Int64.MAX. A client parsing that field
   *  into an int64 overflows on a value we invented by rounding. Writing the literal into the body
   *  keeps the exact documented integer on the wire. */
  fastify.get('/fortnite/api/cloudstorage/storage/:accountId/info', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .send(`{"accountId":${JSON.stringify(accountId)},"totalStorage":9223372036854775807,"totalUsed":0}`);
  });

  /** Reference implementation (LawinServerV3 `routes/matchmaking.js:102`) returns an empty array.
   *  That reference serves builds 3.5–14.50, which brackets 7.40. */
  fastify.post('/fortnite/api/matchmaking/session/matchMakingRequest', async (_request, reply) => reply.send([]));

  // NOT here: `/fortnite/api/stats/accountId/:accountId/bulk/window/:window`. The binary fragment
  // `api/stats/%s` read as unrouted because the real route has a literal `accountId` segment before
  // the parameter, which the fragment match missed. Fastify caught the duplicate at startup.
  // compat.routes.ts:21 already implements it, and better than the reference does — it seeds and
  // returns real player stats where LawinServerV3 returns an empty object. Left alone.

  /** Reference implementation (LawinServerV3 `routes/affiliate.js:9`): a known slug returns the
   *  record, an unknown one returns 404 with `{}`. Nova has no creator-code store, so every slug is
   *  unknown — which is the correct answer here, not a missing one. Nova already answers the v2
   *  `slug/validate` form in social.routes.ts; this is the v1 form the 7.40 binary carries. */
  fastify.get('/affiliate/api/public/affiliates/slug/:slug', async (_request, reply) => {
    return reply.status(404).send({});
  });

  /** Documented: {id, displayName, externalAuths}. Backed by the launcher account store, which is
   *  the only place this backend holds an email. An unknown email gets the documented not-found
   *  shape rather than a fabricated account.
   *
   *  Note the endpoint documentation records this as deprecated by Epic in 2023 for data-protection
   *  reasons. It is implemented because the 7.40 build predates that and still carries the literal;
   *  it is not a route anything here is expected to use. */
  fastify.get('/account/api/public/account/email/:email', async (request, reply) => {
    const { email } = request.params as { email: string };
    const launcher: any = getLauncherAccountByEmail(email);
    if (!launcher?.fortnite_account_id) return reply.status(404).send({});
    const account: any = getAccount(launcher.fortnite_account_id);
    if (!account) return reply.status(404).send({});
    return reply.send({ id: account.id, displayName: account.display_name, externalAuths: {} });
  });

  /** Documented as an ARRAY of account records. Nova links no external auth providers, so the
   *  correct answer is an empty array — note this is the one case where the catch-all's `{}` was
   *  actively the wrong TYPE, and a client that iterates the result would have been handed an
   *  object. */
  fastify.get('/account/api/public/account/lookup/externalAuth/:externalAuthType/displayName/:displayName',
    async (_request, reply) => reply.send([]));

  /** Documented as a POST returning an object keyed by the external id. With no external auths
   *  linked, every requested id is simply absent, so an empty object is the documented shape. */
  fastify.post('/account/api/public/account/lookup/externalId', async (_request, reply) => reply.send({}));
  fastify.post('/account/api/public/account/lookup/externalDisplayName', async (_request, reply) => reply.send({}));

  /** Documented account metadata endpoints. Nova stores no per-account metadata; an empty object is
   *  the shape, and PUT/DELETE acknowledge without persisting. */
  fastify.get('/account/api/accounts/:accountId/metadata', async (_request, reply) => reply.send({}));
  fastify.get('/account/api/accounts/:accountId/metadata/:key', async (_request, reply) => reply.send({}));
  fastify.get('/account/api/accounts/:accountId/email', async (_request, reply) => reply.status(204).send());

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // TIER 2 — known client endpoints, NO documented shape. Behaviour identical to the catch-all.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  // Save the World. Nova routes world/info already; validate has no documented body and this
  // deployment is Battle Royale only.
  fastify.get('/fortnite/api/game/v2/world/validate', stub('stw-world-validate'));
  fastify.post('/fortnite/api/game/v2/world/validate', stub('stw-world-validate'));

  // Matchmaking: the SESSION ticket variant. Nova implements the `player` variant, which is the one
  // 7.40 was observed to use. Do not infer this one's body from the player ticket — they are
  // different calls and a wrong ticket body is exactly what makes the client drop out of
  // matchmaking with "Ticket ID mismatch".
  fastify.get('/fortnite/api/game/v2/matchmakingservice/ticket/session/*', stub('mms-session-ticket'));
  fastify.post('/fortnite/api/game/v2/matchmakingservice/ticket/session/*', stub('mms-session-ticket'));

  // Access gating / platform entitlement handshakes.
  fastify.get('/fortnite/api/game/v2/exchange_access/*', stub('exchange-access'));
  fastify.post('/fortnite/api/game/v2/exchange_access/*', stub('exchange-access'));

  // Twitch account linking. Nova answers the base `/twitch/:accountId`; these are the mutating pair.
  fastify.post('/fortnite/api/game/v2/twitch/:accountId/register', stub('twitch-register'));
  fastify.post('/fortnite/api/game/v2/twitch/:accountId/update', stub('twitch-update'));

  // Client-side diagnostic upload. stats.routes.ts:76 already answers the single-segment form
  // `/fortnite/api/feedback/:type` with {success:true}; only the deeper `log-snapshot/<id>` path the
  // binary carries falls past it, so that is the only one added here. A generic
  // `/fortnite/api/feedback/*` was tried and removed as redundant.
  fastify.post('/fortnite/api/feedback/log-snapshot/*', stub('feedback-log-snapshot'));

  // Fulfillment (code redemption) and launcher plumbing — documented paths, undocumented bodies.
  fastify.post('/fulfillment/api/public/accounts/:accountId/codes/:code', stub('fulfillment-code'));
  fastify.get('/launcher/api/public/assets/info/launcher/:version', stub('launcher-asset-info'));
  fastify.get('/launcher/api/public/payment/accounts/:accountId/billingaccounts/default', stub('billing-account'));

  // Catalog service siblings. Nova already routes `/catalog/api/shared/bulk/offers`; these are the
  // rest of that family the client knows about. Storefront purchases are not part of this
  // deployment, so none is expected to be called.
  fastify.get('/catalog/api/shared/categories', stub('catalog-categories'));
  fastify.get('/catalog/api/shared/currencies', stub('catalog-currencies'));
  fastify.get('/catalog/api/shared/offers/price', stub('catalog-offer-price'));
  fastify.post('/catalog/api/shared/offers/price', stub('catalog-offer-price'));
  fastify.get('/catalog/api/shared/bulk/items', stub('catalog-bulk-items'));
  fastify.post('/catalog/api/shared/bulk/items', stub('catalog-bulk-items'));
  fastify.get('/catalog/api/shared/namespace/*', stub('catalog-namespace'));
  fastify.get('/catalog/api/shared/code/*', stub('catalog-code'));
  fastify.get('/catalog/api/shared/accounts/*', stub('catalog-accounts'));

  // ── Owning service UNKNOWN ────────────────────────────────────────────────────────────────
  // The binary carries these as `%s/api/...`, so the service base is substituted at runtime and the
  // prefix is not recoverable from the build. A parametric first segment matches whichever service
  // the client actually uses; Fastify prefers static routes, so nothing real is shadowed.

  fastify.get('/:service/api/accesscontrol/status', stub('accesscontrol-status'));
  fastify.get('/:service/api/endpoints', stub('service-endpoints'));
  fastify.get('/:service/api/3/timestamp', stub('timestamp'));
  fastify.get('/:service/api/public/imagetypes', stub('imagetypes'));
  fastify.get('/:service/api/public/lookup/*', stub('public-lookup'));
  fastify.get('/:service/api/public/sources/*', stub('public-sources'));
  fastify.get('/:service/api/messaging/*', stub('messaging'));
  fastify.post('/:service/api/messaging/*', stub('messaging'));
  fastify.get('/:service/api/dss/v1/*', stub('dss'));
  fastify.get('/:service/api/v1/config/*', stub('v1-config'));
  fastify.get('/:service/api/v1/groups/*', stub('v1-groups'));
  fastify.get('/:service/api/v1/groups/in/*', stub('v1-groups-in'));
  fastify.get('/:service/api/v1/recent/*', stub('v1-recent'));
  fastify.get('/:service/api/v1/user/in/*', stub('v1-user-in'));
}
