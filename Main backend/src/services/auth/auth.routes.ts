import { FastifyInstance } from 'fastify';
import { generateAccessToken, generateRefreshToken, generateClientToken, verifyToken } from './token.service';
import { ensureAccount, getAccount, storeToken, getLauncherAccountByLogin, authenticateLauncher } from '../../database';
import { Errors } from '../../utils/error-handler';
import { generateUUID } from '../../utils/uuid';
import crypto from 'crypto';

/**
 * Exchange codes issued by GET /account/api/oauth/exchange — single-use, 5 minute TTL.
 *
 * These used to be base64("accountId:displayName"), which meant two things: (a) any caller could
 * mint a login for ANY account by base64-encoding its id, and (b) because Buffer.from(x,'base64')
 * never throws, an unrecognised code did not fail — it fell through to a random UUID and silently
 * created a BRAND NEW account, so a launch with a stale/foreign code lost the player's locker,
 * stats and V-Bucks and left an orphan row behind.
 */
const exchangeCodes = new Map<string, { accountId: string; displayName: string; expires: number }>();

function takeExchangeCode(code: string): { accountId: string; displayName: string } | null {
  const entry = exchangeCodes.get(code);
  if (!entry) return null;
  exchangeCodes.delete(code); // single use
  if (entry.expires < Date.now()) return null;
  return { accountId: entry.accountId, displayName: entry.displayName };
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * POST /account/api/oauth/token
   * Core OAuth endpoint — the FIRST thing the client calls.
   * Must return a valid token or the client won't proceed past splash screen.
   */
  fastify.post('/account/api/oauth/token', async (request, reply) => {
    const body = request.body as Record<string, string>;
    const grantType = body?.grant_type;

    // Parse Basic auth header for client credentials
    let clientId = 'ec684b8c687f479fadea3cb2ad83f5c6'; // default Fortnite PC
    const authHeader = request.headers.authorization;
    if (authHeader && /^basic\s+/i.test(authHeader)) {
      // Fortnite sends a lowercase scheme ("Authorization: basic <base64>"), so match case-insensitively.
      try {
        const decoded = Buffer.from(authHeader.replace(/^basic\s+/i, ''), 'base64').toString('utf-8');
        const [id] = decoded.split(':');
        if (id) clientId = id;
      } catch {}
    }

    if (grantType === 'client_credentials') {
      const clientToken = generateClientToken(clientId);
      storeToken(clientToken.token, clientId, clientId, grantType, clientToken.expiresAt);

      return reply.send({
        access_token: clientToken.token,
        expires_in: clientToken.expiresIn,
        expires_at: clientToken.expiresAt,
        token_type: 'bearer',
        client_id: clientId,
        internal_client: true,
        client_service: 'fortnite',
      });
    }

    // Resolve a STABLE account identity per grant type. The critical invariant: the
    // SAME player must map to the SAME accountId every login AND on every mid-session
    // token refresh — otherwise the refreshed token's accountId no longer matches the
    // XMPP/party/MCP identity the session started on, and party / "Play" silently desync.
    let accountId: string;
    let displayName: string;

    if (grantType === 'refresh_token' && body?.refresh_token) {
      // Re-resolve the SAME account from the supplied refresh token.
      const rt = verifyToken(body.refresh_token);
      if (!rt?.sub) return Errors.invalidToken(reply);
      // Must actually BE a refresh token — otherwise a leaked 8h access token can be replayed here
      // forever to mint fresh tokens.
      if (rt.t !== 'eg1~r') return Errors.invalidToken(reply);
      accountId = rt.sub;
      displayName = getAccount(accountId)?.display_name || 'NovaPlayer';
    } else if (grantType === 'exchange_code' && body?.exchange_code) {
      // Only codes this server actually issued are accepted (see exchangeCodes above).
      const entry = takeExchangeCode(body.exchange_code);
      if (!entry) return Errors.invalidToken(reply);
      accountId = entry.accountId;
      displayName = entry.displayName;
    } else if (body?.password && verifyToken(body.password)?.sub) {
      // ── THE GAME'S OWN LOGIN ────────────────────────────────────────────────────────────────
      // The launcher starts Fortnite with `-AUTH_LOGIN=<accountId> -AUTH_PASSWORD=<session token>`,
      // and the client turns that into a password grant with username=<accountId>. The username
      // branch below would then hash that accountId into a SECOND, DIFFERENT account — so the
      // player's in-game locker, V-Bucks, stats and friends lived on an account the launcher never
      // shows, and their display name rendered as a 32-char hex string (the launcher's account id).
      // That is where the ~96 shadow accounts in the DB came from.
      //
      // The password IS the launcher's live session token, so it is the most trustworthy identity
      // in the request — and unlike the username it cannot be forged. Resolve it and use the REAL
      // account. A human logging in through the launcher sends a plaintext password here, which
      // never verifies as a token, so that path is unaffected and still falls through below.
      const gameAuth = verifyToken(body.password)!;
      accountId = gameAuth.sub;
      displayName = getAccount(accountId)?.display_name || gameAuth.dn || 'NovaPlayer';
      console.log(`[Auth] game login resolved to launcher account ${accountId} (${displayName})`);
    } else if (body?.username && getAccount(body.username)) {
      // Defence in depth: an existing account id passed as the username is that account, not a
      // seed to hash. (Covers a launcher that sends the id without a usable token.)
      accountId = body.username;
      displayName = getAccount(accountId)?.display_name || 'NovaPlayer';
    } else if (body?.account_id) {
      // device_auth / any grant that already carries the account id.
      accountId = body.account_id;
      displayName = getAccount(accountId)?.display_name || body?.username?.split('@')[0] || 'NovaPlayer';
    } else if (body?.username && getLauncherAccountByLogin(String(body.username))) {
      // ── A REAL ACCOUNT EXISTS FOR THIS LOGIN — THE PASSWORD MUST BE RIGHT ───────────────────
      // Without this, the launcher's own /nova/api/launcher/login could verify passwords all it
      // liked and anyone could still walk in through this older endpoint, which never checked one.
      // A registered login is only usable here with its actual password.
      const verified = authenticateLauncher(String(body.username), String(body.password || ''));
      if (!verified) {
        return reply.status(401).send({
          errorCode: 'errors.com.epicgames.account.invalid_account_credentials',
          errorMessage: 'Incorrect username or password.',
          numericErrorCode: 18031,
        });
      }
      accountId = verified.fortnite_account_id;
      displayName = getAccount(accountId)?.display_name || verified.username;
    } else if (body?.username) {
      // Human sign-in through the launcher: derive a DETERMINISTIC accountId from the login so the
      // same credentials are always the same account.
      const login = body.username.toLowerCase().trim();
      accountId = crypto.createHash('md5').update(login).digest('hex');
      displayName = body.username.split('@')[0] || 'NovaPlayer';
    } else {
      // No identifying field — last-resort random (rare).
      accountId = generateUUID().replace(/-/g, '');
      displayName = 'NovaPlayer';
    }

    // Ensure account exists in DB
    ensureAccount(accountId, displayName);

    const accessToken = generateAccessToken(accountId, displayName, clientId, grantType || 'password');
    const refreshToken = generateRefreshToken(accountId, clientId);

    storeToken(accessToken.token, accountId, clientId, grantType || 'password', accessToken.expiresAt);

    return reply.send({
      access_token: accessToken.token,
      expires_in: accessToken.expiresIn,
      expires_at: accessToken.expiresAt,
      token_type: 'bearer',
      refresh_token: refreshToken.token,
      refresh_expires: refreshToken.expiresIn,
      refresh_expires_at: refreshToken.expiresAt,
      account_id: accountId,
      client_id: clientId,
      internal_client: true,
      client_service: 'fortnite',
      displayName: displayName,
      app: 'fortnite',
      in_app_id: accountId,
      device_id: generateUUID(),
    });
  });

  /**
   * GET /account/api/oauth/verify
   * Client verifies its token is still valid
   */
  fastify.get('/account/api/oauth/verify', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader) return Errors.unauthorized(reply);

    const token = authHeader.replace(/^bearer\s+/i, '');
    const payload = verifyToken(token);

    if (!payload) return Errors.invalidToken(reply);

    return reply.send({
      token: token,
      session_id: payload.jti,
      token_type: 'bearer',
      client_id: payload.clid,
      internal_client: true,
      client_service: 'fortnite',
      account_id: payload.sub,
      expires_in: payload.exp - Math.floor(Date.now() / 1000),
      expires_at: new Date(payload.exp * 1000).toISOString(),
      auth_method: payload.am,
      display_name: payload.dn,
      app: 'fortnite',
      in_app_id: payload.sub,
      device_id: generateUUID(),
    });
  });

  /**
   * GET /account/api/oauth/exchange
   * Generate an exchange code from an existing token — used by launcher → game handoff
   */
  fastify.get('/account/api/oauth/exchange', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader) return Errors.unauthorized(reply);

    const token = authHeader.replace(/^bearer\s+/i, '');
    const payload = verifyToken(token);

    if (!payload) return Errors.invalidToken(reply);

    // Opaque, unguessable, single-use code bound to this account server-side.
    const exchangeCode = crypto.randomBytes(16).toString('hex');
    exchangeCodes.set(exchangeCode, {
      accountId: payload.sub,
      displayName: payload.dn || 'NovaPlayer',
      expires: Date.now() + 300_000,
    });
    // Opportunistically reap expired codes so the map can't grow without bound.
    if (exchangeCodes.size > 512) {
      const nowMs = Date.now();
      for (const [k, v] of exchangeCodes) if (v.expires < nowMs) exchangeCodes.delete(k);
    }

    return reply.send({
      expiresInSeconds: 300,
      code: exchangeCode,
      creatingClientId: payload.clid,
    });
  });

  /**
   * DELETE /account/api/oauth/sessions/kill
   * DELETE /account/api/oauth/sessions/kill/:token
   * Client calls this on logout — must succeed silently
   */
  fastify.delete('/account/api/oauth/sessions/kill', async (request, reply) => {
    reply.status(204).send();
  });

  fastify.delete('/account/api/oauth/sessions/kill/:token', async (request, reply) => {
    reply.status(204).send();
  });

  /**
   * GET /account/api/public/account/:accountId
   * Returns basic account info — needed for lobby display
   */
  fastify.get('/account/api/public/account/:accountId', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const account = getAccount(accountId);

    return reply.send({
      id: accountId,
      displayName: account?.display_name || 'NovaPlayer',
      name: account?.display_name || 'NovaPlayer',
      email: account?.email || `${accountId}@projectnova.local`,
      failedLoginAttempts: 0,
      lastLogin: new Date().toISOString(),
      numberOfDisplayNameChanges: 0,
      ageGroup: 'UNKNOWN',
      headless: false,
      country: 'US',
      lastName: 'Nova',
      preferredLanguage: 'en',
      canUpdateDisplayName: true,
      tfaEnabled: false,
      emailVerified: true,
      minorVerified: false,
      minorExpected: false,
      minorStatus: 'NOT_MINOR',
      cabinedMode: false,
      hasHashedEmail: false,
      externalAuths: {},
    });
  });

  /**
   * GET /account/api/public/account
   * Bulk account lookup (query param: accountId=xxx&accountId=yyy)
   */
  fastify.get('/account/api/public/account', async (request, reply) => {
    const query = request.query as Record<string, string | string[]>;
    let accountIds: string[] = [];

    if (typeof query.accountId === 'string') {
      accountIds = [query.accountId];
    } else if (Array.isArray(query.accountId)) {
      accountIds = query.accountId;
    }

    const accounts = accountIds.map(id => {
      const account = getAccount(id);
      return {
        id,
        displayName: account?.display_name || 'NovaPlayer',
        externalAuths: {},
      };
    });

    return reply.send(accounts);
  });

  /**
   * GET /account/api/public/account/:accountId/externalAuths
   */
  fastify.get('/account/api/public/account/:accountId/externalAuths', async (request, reply) => {
    return reply.send([]);
  });

  /**
   * Device Auth endpoints — used for persistent login
   */
  fastify.post('/account/api/public/account/:accountId/deviceAuth', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    return reply.send({
      deviceId: generateUUID(),
      accountId: accountId,
      secret: generateUUID(),
      userAgent: '',
      created: { dateTime: new Date().toISOString(), location: 'US' },
      lastAccess: { dateTime: new Date().toISOString(), location: 'US' },
    });
  });

  fastify.get('/account/api/public/account/:accountId/deviceAuth', async (request, reply) => {
    return reply.send([]);
  });

  fastify.delete('/account/api/public/account/:accountId/deviceAuth/:deviceId', async (request, reply) => {
    reply.status(204).send();
  });

  // EOS Connect, Anti-Cheat, Social Bans, and all other EOS endpoints
  // are now handled by the dedicated EOS translation layer in
  // services/eos/eos.routes.ts — registered separately in index.ts.

}
