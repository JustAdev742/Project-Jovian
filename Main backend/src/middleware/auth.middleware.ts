import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../services/auth/token.service';
import { Errors } from '../utils/error-handler';

/**
 * Auth middleware — validates Bearer tokens on protected routes.
 * Attaches accountId and displayName to the request for downstream handlers.
 */
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('bearer ') && !authHeader.startsWith('Bearer ')) {
    // Some endpoints are called without auth (lightswitch, etc.)
    // Let them through but without user context
    (request as any).accountId = null;
    (request as any).displayName = null;
    return;
  }

  const token = authHeader.replace(/^bearer\s+/i, '');
  const payload = verifyToken(token);

  if (!payload) {
    return Errors.invalidToken(reply);
  }

  // Attach user info to request
  (request as any).accountId = payload.sub;
  (request as any).displayName = payload.dn || 'NovaPlayer';
  (request as any).clientId = payload.clid;
  (request as any).tokenType = payload.t;
  (request as any).isClientToken = payload.ic || false;
}

/**
 * Strict auth — rejects requests without valid user tokens
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authMiddleware(request, reply);

  if (reply.sent) return; // Error already sent

  if (!(request as any).accountId) {
    return Errors.unauthorized(reply, 'A valid access token is required.');
  }
}
