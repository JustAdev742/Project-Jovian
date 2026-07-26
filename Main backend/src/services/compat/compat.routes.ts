import { FastifyInstance } from 'fastify';
import { generateUUID } from '../../utils/uuid';
import { getAccount, getAccountIdByDisplayName, getPlayerStats, seedDefaultStats } from '../../database';

/**
 * Epic-API compatibility stubs — endpoints the S7/S8 client calls that Nova had no route for, so
 * they fell through to the not-found handler and returned `{}`/204. An empty object where the client
 * expects an array or a `.stats`/`.stash` shape produces client-side parse errors and log spam (and,
 * for a few, a missing feature). Shapes ported from the Reload-Backend reference.
 */
export async function compatRoutes(fastify: FastifyInstance): Promise<void> {

  // Player "stash" (Chapter 1 has no gold economy, but the client reads stash.globalcash).
  fastify.get('/fortnite/api/game/v2/br-inventory/account/:accountId', async (_req, reply) => {
    return reply.send({ stash: { globalcash: 0 } });
  });

  // Career/stats screen reads `.stats` off this — must not be `{}`. It was returning a hardcoded
  // empty object even though the DB already holds these stats, so the career tab showed zeroes for
  // players with real recorded matches.
  fastify.get('/fortnite/api/stats/accountId/:accountId/bulk/window/:window', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    seedDefaultStats(accountId);
    return reply.send({ startTime: 0, endTime: 9999999999, stats: getPlayerStats(accountId), accountId });
  });

  // SSO domains — the client expects an ARRAY.
  fastify.get('/account/api/epicdomains/ssodomains', async (_req, reply) => {
    return reply.send(['unrealengine.com', 'unrealtournament.com', 'fortnite.com', 'epicgames.com']);
  });

  // Look up an account by display name (DB-backed — Nova already tracks display names).
  fastify.get('/account/api/public/account/displayName/:displayName', async (request, reply) => {
    const { displayName } = request.params as { displayName: string };
    const accountId = getAccountIdByDisplayName(displayName);
    if (!accountId) {
      return reply.status(404).send({
        errorCode: 'errors.com.epicgames.account.account_not_found',
        errorMessage: `Sorry, we couldn't find an account for ${displayName}`,
        messageVars: [displayName], numericErrorCode: 18007,
        originatingService: 'com.epicgames.account.public', intent: 'prod',
      });
    }
    const account = getAccount(accountId);
    return reply.send({ id: accountId, displayName: account?.display_name || displayName, externalAuths: {} });
  });

  // Public-key exchange — the client posts here during login; it reads back a key_guid object.
  const publicKey = async (request: any, reply: any) => {
    const body = (request.body || {}) as any;
    return reply.send({
      key: body.key,
      accountId: (request.query as any)?.accountId,
      key_guid: generateUUID(),
      expiration: '9999-12-31T23:59:59.999Z',
      jwt: 'nova',
      type: 'legacy',
    });
  };
  // The app is built with ignoreTrailingSlash, so this single registration covers both
  // /publickey/v2/publickey and /publickey/v2/publickey/. Registering both explicitly would now
  // throw FST_ERR_DUPLICATED_ROUTE at startup.
  fastify.post('/publickey/v2/publickey', publicKey);

  // Geo-IP region fallback (the client normally uses QoS pings; this is a backstop). US/NAE default.
  fastify.get('/region', async (_req, reply) => {
    return reply.send({
      continent: { code: 'NA', geoname_id: 6255149, names: { en: 'North America' } },
      country: { geoname_id: 6252001, is_in_european_union: false, iso_code: 'US', names: { en: 'United States' } },
      subdivisions: [],
    });
  });

  // BR "Message of the Day" surface — empty is valid (no popup).
  fastify.post('/api/v1/fortnite-br/surfaces/motd/target', async (_req, reply) => {
    return reply.send({ contentItems: [] });
  });

  // ── Creative island codes (S7 introduced Creative). Without these, typing a code returns `{}`
  //    and the island never resolves. Minimal valid linkData echoing the code as a playlist. ──
  function islandLink(code: string): any {
    const now = new Date().toISOString();
    return {
      namespace: 'fn',
      accountId: 'nova',
      creatorName: 'Nova',
      mnemonic: code,
      linkType: 'Creative:Island',
      metadata: { title: code, matchmaking: { playersPerTeam: 16, maximumNumberOfPlayers: 16 } },
      version: 1, active: true, disabled: false, created: now, published: now,
      descriptionTags: [], moderationStatus: 'Approved',
    };
  }
  fastify.get('/links/api/fn/mnemonic/:code/related', async (_req, reply) => {
    return reply.send({ parentLinks: [], links: {} });
  });
  fastify.get('/links/api/fn/mnemonic/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    return reply.send(islandLink(code));
  });
  fastify.post('/links/api/fn/mnemonic', async (_req, reply) => {
    return reply.send([]);
  });
}
