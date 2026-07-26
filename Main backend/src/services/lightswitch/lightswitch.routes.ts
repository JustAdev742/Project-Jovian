import { FastifyInstance } from 'fastify';
import { getAccount } from '../../database';
import { authMiddleware } from '../../middleware/auth.middleware';

/**
 * Lightswitch is where a Chapter 1 client asks "am I allowed to play?", so it is the one place a
 * ban actually takes effect. Both handlers used to hardcode `banned: false`, which meant
 * setAccountBanned() (admin route + anti-cheat autoban) wrote a flag nothing ever read: a banned
 * player logged in and played normally. The only other reader is the EOS sanctions endpoint, which
 * a C1 build never calls.
 *
 * authMiddleware (not requireAuth): lightswitch is also polled without a token, and those callers
 * must still get a normal UP response.
 */
function banStatus(request: any): boolean {
  const accountId = request.accountId as string | null;
  return accountId ? getAccount(accountId)?.banned === 1 : false;
}

export async function lightswitchRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/lightswitch/api/service/bulk/status', { preHandler: authMiddleware }, async (request, reply) => {
    const banned = banStatus(request);
    return reply.send([{
      serviceInstanceId: 'fortnite',
      status: banned ? 'DOWN' : 'UP',
      message: banned ? 'You have been banned from Project Nova.' : 'Project Nova is operational.',
      maintenanceUri: null,
      overrideCatalogIds: ['a7f138b2e51945ffbfdacc1af0541053'],
      allowedActions: banned ? [] : ['PLAY', 'DOWNLOAD'],
      banned,
      launcherInfoDTO: { appName: 'Fortnite', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da8', namespace: 'fn' },
    }]);
  });

  fastify.get('/lightswitch/api/service/Fortnite/status', { preHandler: authMiddleware }, async (request, reply) => {
    const banned = banStatus(request);
    return reply.send({
      serviceInstanceId: 'fortnite', status: banned ? 'DOWN' : 'UP',
      message: banned ? 'You have been banned from Project Nova.' : 'Nova OK',
      maintenanceUri: null, allowedActions: banned ? [] : ['PLAY', 'DOWNLOAD'], banned,
    });
  });
}
