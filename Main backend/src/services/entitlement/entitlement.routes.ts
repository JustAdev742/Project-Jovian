import { FastifyInstance } from 'fastify';

/**
 * Entitlement Routes — The client checks entitlements to verify game ownership.
 * Without these, the client may refuse to load or show "You do not own this game".
 */
export async function entitlementRoutes(fastify: FastifyInstance): Promise<void> {

  /** GET /entitlement/api/account/:accountId/entitlements — game ownership check */
  fastify.get('/entitlement/api/account/:accountId/entitlements', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const query = request.query as Record<string, string>;

    return reply.send([
      {
        id: '1',
        entitlementName: 'Fortnite_Access',
        namespace: 'fn',
        catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da8',
        entitlementType: 'EXECUTABLE',
        grantDate: '2018-01-01T00:00:00.000Z',
        consumable: false,
        count: 1,
        country: 'US',
        active: true,
      },
      {
        id: '2',
        entitlementName: 'Fortnite_BattleRoyale',
        namespace: 'fn',
        catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da8',
        entitlementType: 'EXECUTABLE',
        grantDate: '2018-01-01T00:00:00.000Z',
        consumable: false,
        count: 1,
        country: 'US',
        active: true,
      },
    ]);
  });

  /** GET /fortnite/api/storeaccess/v1/request_access/:accountId — store access check */
  fastify.get('/fortnite/api/storeaccess/v1/request_access/:accountId', async (request, reply) => {
    return reply.send({});
  });

  /** GET /catalog/api/shared/bulk/offers — catalog offers (empty OK) */
  fastify.get('/catalog/api/shared/bulk/offers', async (request, reply) => {
    return reply.send({});
  });

  /** GET /launcher/api/public/distributionpoints — launcher distribution points */
  fastify.get('/launcher/api/public/distributionpoints', async (request, reply) => {
    return reply.send({
      distributions: ['https://launcher-public-service-prod06.ol.epicgames.com'],
    });
  });

  /** GET /launcher/api/public/assets/:platform/:catalogItemId/:appName — launcher assets */
  fastify.get('/launcher/api/public/assets/:platform/:catalogItemId/:appName', async (request, reply) => {
    return reply.send({
      appName: 'Fortnite',
      labelName: 'Live',
      buildVersion: '++Fortnite+Release-7.40-CL-5046157-Windows',
      catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da8',
      namespace: 'fn',
    });
  });
}
