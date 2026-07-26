import { FastifyInstance } from 'fastify';
import { generateUUID, generateHex } from '../../utils/uuid';
import {
  ensureAccount, getAccount, getPlayerStats, seedDefaultStats, setPlayerStat,
  incrementPlayerStat, getLeaderboard, getAchievements, unlockAchievement,
  getFriends, addFriend, acceptFriend, removeFriend, blockUser,
  getCurrency, getInventory, storeToken, validateToken,
} from '../../database';
import { generateAccessToken, verifyToken } from '../auth/token.service';
import { Config } from '../../config';
import fs from 'fs';
import path from 'path';
// Static import (resolveJsonModule is on) so tsc copies this into dist/ — a bare require() inside
// the handler was invisible to the compiler and 500'd in any built deployment.
import sdkConfig from '../../responses/sdkv1.json';

// ═══════════════════════════════════════════════════════════════════
//  EOS TRANSLATION LAYER
//
//  The Fortnite client's EOS SDK calls these endpoints. This module
//  translates every EOS API call into the existing backend's data
//  layer so the client thinks it's talking to real Epic Online Services.
//
//  All routes accept :deploymentId as a parameter but ignore it —
//  we serve the same data regardless of deployment context.
// ═══════════════════════════════════════════════════════════════════

// ─── In-memory state ────────────────────────────────────────────

interface EosSession {
  id: string;
  ownerId: string;
  bucketId: string;
  settings: Record<string, any>;
  attributes: Record<string, any>;
  players: Set<string>;
  maxPlayers: number;
  started: boolean;
  created: string;
}

interface EosLobby {
  id: string;
  ownerId: string;
  maxMembers: number;
  permissionLevel: string;
  members: Map<string, { role: string; attributes: Record<string, any> }>;
  attributes: Record<string, any>;
  created: string;
}

interface PresenceEntry {
  userId: string;
  status: string;
  productId: string;
  productName: string;
  platform: string;
  richText: string;
  updated: string;
}

interface PlayerDataEntry {
  filename: string;
  data: Buffer;
  md5: string;
  size: number;
  modified: string;
}

const eosSessions = new Map<string, EosSession>();
const eosLobbies = new Map<string, EosLobby>();
const eosPresence = new Map<string, PresenceEntry>();
const eosPlayerData = new Map<string, Map<string, PlayerDataEntry>>(); // userId → filename → data
const productUserMap = new Map<string, string>(); // productUserId → accountId
const accountProductMap = new Map<string, string>(); // accountId → productUserId

function getOrCreateProductUser(accountId: string): string {
  let puid = accountProductMap.get(accountId);
  if (puid) return puid;
  puid = generateHex(16);
  productUserMap.set(puid, accountId);
  accountProductMap.set(accountId, puid);
  return puid;
}

/**
 * Resolve the Nova account behind an EOS call from its bearer token, or null if the caller cannot
 * be identified.
 *
 * This used to return the literal 'nova-default-account' for anyone it couldn't identify — which is
 * EVERY call to the two token endpoints below, since those carry `Authorization: Basic
 * <clientId:secret>` rather than a bearer token. That collapsed all such callers onto ONE account
 * and (because getOrCreateProductUser memoises) ONE product_user_id, merging two players' stats,
 * achievements, presence and lobby ownership into a single identity. It also meant the token
 * endpoints storeToken()'d that shared account, so a request with no credentials at all minted a
 * token that validateToken() — and the XMPP SASL path — would accept.
 */
function resolveAccountId(request: any): string | null {
  const authHeader = request.headers?.authorization || '';
  if (!/^bearer\s+/i.test(authHeader)) return null;
  const token = authHeader.replace(/^bearer\s+/i, '');
  if (!token || token === 'nova_eos_access_token' || token === 'nova_eos_v2_access_token') return null;
  const payload = verifyToken(token);
  if (payload?.sub) return payload.sub;
  return validateToken(token);
}

/**
 * Throwaway per-request identity for EOS endpoints that must still answer an unidentified caller.
 * Deliberately unique per call so two anonymous callers never merge, and deliberately never
 * ensureAccount()'d or storeToken()'d — it is not a credential and must not create a DB row.
 */
function anonEosId(): string {
  return `eos-anon-${generateHex(8)}`;
}

// Cleanup stale EOS sessions every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, session] of eosSessions) {
    if (new Date(session.created).getTime() < cutoff) {
      eosSessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

export async function eosRoutes(fastify: FastifyInstance): Promise<void> {

  // ═══════════════════════════════════════════════════════════════
  //  EOS CONNECT — Authentication & Product User Management
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/auth/v1/oauth/token', async (request, reply) => {
    const body = request.body as Record<string, string>;
    const authed = resolveAccountId(request);
    const accountId = authed ?? anonEosId();
    const puid = getOrCreateProductUser(accountId);

    const accessToken = generateAccessToken(accountId, 'NovaPlayer', Config.FORTNITE_CLIENT_IDS[0], 'client_credentials');
    // Only register the token as a real backend credential when we actually know who this is.
    if (authed) storeToken(accessToken.token, accountId, Config.FORTNITE_CLIENT_IDS[0], 'eos_connect', accessToken.expiresAt);

    return reply.send({
      access_token: accessToken.token,
      token_type: 'bearer',
      expires_at: accessToken.expiresAt,
      expires_in: accessToken.expiresIn,
      account_id: accountId,
      product_user_id: puid,
      features: ['AntiCheat', 'Connect', 'Ecom', 'Sessions', 'Stats', 'Leaderboards',
                 'Achievements', 'PlayerDataStorage', 'TitleStorage', 'Reports',
                 'Sanctions', 'Lobby', 'Presence', 'Friends', 'Mods', 'RTC'],
      organization_id: Config.EOS_ORG_ID,
      product_id: Config.EOS_PRODUCT_ID,
      sandbox_id: Config.EOS_SANDBOX_ID,
      deployment_id: Config.EOS_DEPLOYMENT_ID,
    });
  });

  fastify.post('/epic/oauth/v2/token', async (request, reply) => {
    const body = request.body as Record<string, string>;
    const authed = resolveAccountId(request);
    const accountId = authed ?? anonEosId();
    const puid = getOrCreateProductUser(accountId);

    let clientId: string = Config.FORTNITE_CLIENT_IDS[0];
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
        const [id] = decoded.split(':');
        if (id) clientId = id;
      } catch {}
    }

    const accessToken = generateAccessToken(accountId, 'NovaPlayer', clientId, 'exchange_code');
    // Only register the token as a real backend credential when we actually know who this is.
    if (authed) storeToken(accessToken.token, accountId, clientId, 'eos_v2', accessToken.expiresAt);

    return reply.send({
      scope: body?.scope || 'basic_profile friends_list openid presence',
      token_type: 'bearer',
      access_token: accessToken.token,
      refresh_token: accessToken.token,
      id_token: accessToken.token,
      expires_in: accessToken.expiresIn,
      expires_at: accessToken.expiresAt,
      refresh_expires_in: 28800,
      refresh_expires_at: new Date(Date.now() + 28800 * 1000).toISOString(),
      account_id: accountId,
      client_id: clientId,
      application_id: Config.EOS_PRODUCT_ID,
      selected_account_id: accountId,
      merged_accounts: [],
      product_user_id: puid,
    });
  });

  // EOS Connect — Create / Login product user
  fastify.post('/connect/v1/:deploymentId/users', async (request, reply) => {
    const authed = resolveAccountId(request);
    const accountId = authed ?? anonEosId();
    const puid = getOrCreateProductUser(accountId);
    // Don't create a DB row for a caller we can't identify — that is how orphan accounts pile up.
    if (authed) ensureAccount(accountId, 'NovaPlayer');

    return reply.send({
      product_user_id: puid,
      account_id: accountId,
      id_token: generateHex(32),
      created: true,
    });
  });

  fastify.get('/connect/v1/:deploymentId/users', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const accountId = query.epicAccountId || resolveAccountId(request) || anonEosId();
    const puid = getOrCreateProductUser(accountId);

    return reply.send([{
      product_user_id: puid,
      account_id: accountId,
      platform: 'epic',
    }]);
  });

  // Link / Unlink accounts
  fastify.post('/connect/v1/:deploymentId/links', async (request, reply) => {
    return reply.status(204).send();
  });

  fastify.delete('/connect/v1/:deploymentId/links', async (request, reply) => {
    return reply.status(204).send();
  });

  // Device ID for EOS Connect
  fastify.post('/connect/v1/:deploymentId/deviceId', async (request, reply) => {
    return reply.send({
      device_id: generateUUID(),
      created: new Date().toISOString(),
    });
  });

  fastify.delete('/connect/v1/:deploymentId/deviceId', async (request, reply) => {
    return reply.status(204).send();
  });

  // Product User ID mappings
  fastify.post('/connect/v1/:deploymentId/productUserId/mappings', async (request, reply) => {
    const body = request.body as any;
    const userIds = body?.productUserIds || [];
    const mappings = userIds.map((puid: string) => {
      const accountId = productUserMap.get(puid) || 'unknown';
      return { productUserId: puid, accountId };
    });
    return reply.send(mappings);
  });

  fastify.get('/connect/v1/:deploymentId/productUserId/mappings', async (request, reply) => {
    const query = request.query as Record<string, string | string[]>;
    let puids: string[] = [];
    if (typeof query.productUserId === 'string') puids = [query.productUserId];
    else if (Array.isArray(query.productUserId)) puids = query.productUserId;

    const mappings = puids.map(puid => ({
      productUserId: puid,
      accountId: productUserMap.get(puid) || 'unknown',
    }));
    return reply.send(mappings);
  });

  // Verify ID token
  fastify.post('/connect/v1/:deploymentId/verify', async (request, reply) => {
    const accountId = resolveAccountId(request) ?? anonEosId();
    const puid = getOrCreateProductUser(accountId);
    return reply.send({
      product_user_id: puid,
      account_id: accountId,
      client_id: Config.FORTNITE_CLIENT_IDS[0],
      platform: 'epic',
      deployment_id: Config.EOS_DEPLOYMENT_ID,
      valid: true,
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS SESSIONS — Translates to existing matchmaking
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/matchmaking/v1/:deploymentId/sessions', async (request, reply) => {
    const body = request.body as any;
    const accountId = resolveAccountId(request) ?? anonEosId();
    const sessionId = `eos-${generateUUID()}`;
    const puid = getOrCreateProductUser(accountId);

    const session: EosSession = {
      id: sessionId,
      ownerId: puid,
      bucketId: body?.bucketId || `${Config.EOS_PRODUCT_ID}:${Config.EOS_DEPLOYMENT_ID}:default`,
      settings: body?.settings || {},
      attributes: body?.attributes || {},
      players: new Set([puid]),
      maxPlayers: body?.maxPlayers || 100,
      started: false,
      created: new Date().toISOString(),
    };

    eosSessions.set(sessionId, session);
    console.log(`[EOS Sessions] Created session ${sessionId} by ${accountId}`);

    return reply.status(201).send(buildEosSessionResponse(session));
  });

  fastify.get('/matchmaking/v1/:deploymentId/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = eosSessions.get(sessionId);
    if (!session) return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.session_not_found' });
    return reply.send(buildEosSessionResponse(session));
  });

  fastify.put('/matchmaking/v1/:deploymentId/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as any;
    const session = eosSessions.get(sessionId);
    if (!session) return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.session_not_found' });

    if (body?.settings) Object.assign(session.settings, body.settings);
    if (body?.attributes) Object.assign(session.attributes, body.attributes);
    if (body?.maxPlayers) session.maxPlayers = body.maxPlayers;

    return reply.send(buildEosSessionResponse(session));
  });

  fastify.delete('/matchmaking/v1/:deploymentId/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    eosSessions.delete(sessionId);
    console.log(`[EOS Sessions] Destroyed session ${sessionId}`);
    return reply.status(204).send();
  });

  fastify.post('/matchmaking/v1/:deploymentId/sessions/:sessionId/players', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as any;
    const session = eosSessions.get(sessionId);
    if (!session) return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.session_not_found' });

    const userIds = body?.players || body?.productUserIds || [];
    for (const uid of userIds) session.players.add(uid);

    return reply.send(buildEosSessionResponse(session));
  });

  fastify.delete('/matchmaking/v1/:deploymentId/sessions/:sessionId/players/:userId', async (request, reply) => {
    const { sessionId, userId } = request.params as { sessionId: string; userId: string };
    const session = eosSessions.get(sessionId);
    if (session) session.players.delete(userId);
    return reply.status(204).send();
  });

  fastify.post('/matchmaking/v1/:deploymentId/sessions/:sessionId/start', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = eosSessions.get(sessionId);
    if (session) session.started = true;
    return reply.status(204).send();
  });

  fastify.post('/matchmaking/v1/:deploymentId/sessions/:sessionId/end', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    eosSessions.delete(sessionId);
    return reply.status(204).send();
  });

  fastify.post('/matchmaking/v1/:deploymentId/sessions/find', async (request, reply) => {
    const body = request.body as any;
    const bucketId = body?.bucketId || '';
    const results: any[] = [];

    for (const [, session] of eosSessions) {
      if (!session.started && session.players.size < session.maxPlayers) {
        if (!bucketId || session.bucketId === bucketId) {
          results.push(buildEosSessionResponse(session));
        }
      }
    }

    return reply.send({ sessions: results, count: results.length });
  });

  fastify.post('/matchmaking/v1/:deploymentId/sessions/:sessionId/invites', async (request, reply) => {
    return reply.send({ inviteId: generateUUID() });
  });

  fastify.put('/matchmaking/v1/:deploymentId/sessions/:sessionId/invites/:inviteId', async (request, reply) => {
    return reply.status(204).send();
  });

  // Session heartbeat
  fastify.put('/matchmaking/v1/:deploymentId/sessions/:sessionId/heartbeat', async (request, reply) => {
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS STATS — Translates to existing player_stats DB
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/stats/v1/:deploymentId/ingest', async (request, reply) => {
    const body = request.body as any;
    const stats = body?.stats || [];

    for (const stat of stats) {
      const accountId = productUserMap.get(stat.productUserId) || stat.productUserId;
      ensureAccount(accountId, 'NovaPlayer');
      seedDefaultStats(accountId);

      if (stat.ingestAmount !== undefined) {
        incrementPlayerStat(accountId, stat.statName, stat.ingestAmount);
      } else if (stat.setValue !== undefined) {
        setPlayerStat(accountId, stat.statName, stat.setValue);
      }
    }

    console.log(`[EOS Stats] Ingested ${stats.length} stat(s)`);
    return reply.status(204).send();
  });

  // Stat ingestion via alternate path
  fastify.post('/ingestion/stats/v1/:deploymentId/ingest', async (request, reply) => {
    const body = request.body as any;
    const stats = body?.stats || [];
    for (const stat of stats) {
      const accountId = productUserMap.get(stat.productUserId) || stat.productUserId;
      ensureAccount(accountId, 'NovaPlayer');
      if (stat.ingestAmount !== undefined) incrementPlayerStat(accountId, stat.statName, stat.ingestAmount);
    }
    return reply.status(204).send();
  });

  fastify.post('/stats/v1/:deploymentId/stats/query', async (request, reply) => {
    const body = request.body as any;
    const userIds = body?.productUserIds || body?.targetUserIds || [];
    const statNames = body?.statNames || [];

    const results = userIds.map((puid: string) => {
      const accountId = productUserMap.get(puid) || puid;
      seedDefaultStats(accountId);
      const allStats = getPlayerStats(accountId);
      const filtered: Record<string, number> = {};
      if (statNames.length > 0) {
        for (const name of statNames) {
          if (allStats[name] !== undefined) filtered[name] = allStats[name];
        }
      } else {
        Object.assign(filtered, allStats);
      }
      return { productUserId: puid, stats: filtered };
    });

    return reply.send({ results });
  });

  fastify.get('/stats/v1/:deploymentId/users/:userId/stats', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const accountId = productUserMap.get(userId) || userId;
    seedDefaultStats(accountId);
    const stats = getPlayerStats(accountId);
    return reply.send({ productUserId: userId, stats });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS ACHIEVEMENTS — Translates to existing achievements DB
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/stats/v1/:deploymentId/achievements/definitions', async (request, reply) => {
    return reply.send({
      definitions: [
        { achievementId: 'first_win', displayName: 'Victory Royale', description: 'Win your first match', isHidden: false, unlockedDisplayName: 'Victory Royale!', flavorText: 'You got the dub.' },
        { achievementId: 'first_kill', displayName: 'First Blood', description: 'Eliminate another player', isHidden: false, unlockedDisplayName: 'First Blood!', flavorText: 'Watch out.' },
        { achievementId: 'hundred_kills', displayName: 'Century', description: 'Reach 100 total eliminations', isHidden: false, unlockedDisplayName: 'Century!', flavorText: 'Triple digits.' },
        { achievementId: 'squad_win', displayName: 'Squad Goals', description: 'Win a squad match', isHidden: false, unlockedDisplayName: 'Squad Goals!', flavorText: 'Team effort.' },
        { achievementId: 'play_ten', displayName: 'Getting Started', description: 'Play 10 matches', isHidden: false, unlockedDisplayName: 'Getting Started!', flavorText: 'Where we droppin?' },
      ],
      totalCount: 5,
    });
  });

  fastify.get('/stats/v1/:deploymentId/achievements/users/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const accountId = productUserMap.get(userId) || userId;
    const achievements = getAchievements(accountId);

    return reply.send({
      productUserId: userId,
      achievements: achievements.map(a => ({
        achievementId: a.achievement_id,
        progress: 1.0,
        unlockTime: a.unlocked_at,
      })),
      totalCount: achievements.length,
    });
  });

  fastify.post('/stats/v1/:deploymentId/achievements/users/:userId/unlock', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const accountId = productUserMap.get(userId) || userId;
    const body = request.body as any;
    const achievementIds = body?.achievementIds || [];

    const unlocked: string[] = [];
    for (const id of achievementIds) {
      if (unlockAchievement(accountId, id)) unlocked.push(id);
    }

    if (unlocked.length > 0) {
      console.log(`[EOS Achievements] ${accountId} unlocked: ${unlocked.join(', ')}`);
    }

    return reply.send({ unlocked, alreadyUnlocked: achievementIds.filter((id: string) => !unlocked.includes(id)) });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS LEADERBOARDS — Translates to existing leaderboard DB
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/leaderboards/v1/:deploymentId/definitions', async (request, reply) => {
    return reply.send({
      definitions: [
        { leaderboardId: 'br_kills_total', statName: 'br_kills_keyboardmouse_m0_playlist_defaultsolo', sortOrder: 'DESCENDING', displayName: 'Top Eliminators' },
        { leaderboardId: 'br_wins_total', statName: 'br_placetop1_keyboardmouse_m0_playlist_defaultsolo', sortOrder: 'DESCENDING', displayName: 'Most Wins' },
        { leaderboardId: 'br_score_total', statName: 'br_score_keyboardmouse_m0_playlist_defaultsolo', sortOrder: 'DESCENDING', displayName: 'Highest Score' },
      ],
      totalCount: 3,
    });
  });

  fastify.get('/leaderboards/v1/:deploymentId/ranks/:leaderboardId', async (request, reply) => {
    const { leaderboardId } = request.params as { leaderboardId: string };
    const query = request.query as Record<string, string>;
    const limit = parseInt(query.limit || '25', 10);
    const offset = parseInt(query.offset || '0', 10);

    const statMap: Record<string, string> = {
      'br_kills_total': 'br_kills_keyboardmouse_m0_playlist_defaultsolo',
      'br_wins_total': 'br_placetop1_keyboardmouse_m0_playlist_defaultsolo',
      'br_score_total': 'br_score_keyboardmouse_m0_playlist_defaultsolo',
    };
    const statName = statMap[leaderboardId] || leaderboardId;
    const entries = getLeaderboard(statName, limit, offset);

    return reply.send({
      leaderboardId,
      entries: entries.map((e, i) => ({
        productUserId: accountProductMap.get(e.accountId) || e.accountId,
        rank: offset + i + 1,
        score: e.value,
        displayName: getAccount(e.accountId)?.display_name || 'Unknown',
      })),
      totalCount: entries.length,
    });
  });

  fastify.post('/leaderboards/v1/:deploymentId/userscores/:leaderboardId', async (request, reply) => {
    const { leaderboardId } = request.params as { leaderboardId: string };
    const body = request.body as any;
    const userIds = body?.productUserIds || [];

    const results = userIds.map((puid: string, i: number) => {
      const accountId = productUserMap.get(puid) || puid;
      const stats = getPlayerStats(accountId);
      const statMap: Record<string, string> = {
        'br_kills_total': 'br_kills_keyboardmouse_m0_playlist_defaultsolo',
        'br_wins_total': 'br_placetop1_keyboardmouse_m0_playlist_defaultsolo',
        'br_score_total': 'br_score_keyboardmouse_m0_playlist_defaultsolo',
      };
      const statName = statMap[leaderboardId] || leaderboardId;
      return {
        productUserId: puid,
        rank: i + 1,
        score: stats[statName] || 0,
      };
    });

    return reply.send({ leaderboardId, userScores: results });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS ANTI-CHEAT — Stubs that satisfy the EOS SDK
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/anticheat/v1/:deploymentId/status', async (request, reply) => {
    return reply.send({
      status: 'active',
      mode: 'client',
      deployment_id: Config.EOS_DEPLOYMENT_ID,
      features: { clientProtection: false, serverKick: false },
    });
  });

  fastify.post('/anticheat/v1/:deploymentId/client/message', async (request, reply) => {
    return reply.status(204).send();
  });

  fastify.post('/anticheat/v1/:deploymentId/server/message', async (request, reply) => {
    return reply.status(204).send();
  });

  fastify.get('/anticheat/v1/:deploymentId/client/status', async (request, reply) => {
    return reply.send({ status: 'active', protected: true });
  });

  fastify.get('/api/v1/eac-policy/*', async (request, reply) => {
    return reply.status(204).send();
  });

  // Cerberus edge (anti-cheat gameplay data) — HTTP fallback
  fastify.all('/cerberus-edge/v1/*', async (request, reply) => {
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS SANCTIONS — Ban/sanction checks
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/sanctions/v1/:deploymentId/sanctions', async (request, reply) => {
    return reply.send({ sanctions: [], totalCount: 0 });
  });

  fastify.get('/sanctions/v1/:deploymentId/sanctions/users/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const accountId = productUserMap.get(userId) || userId;
    const account = getAccount(accountId);
    const isBanned = account?.banned === 1;

    if (isBanned) {
      return reply.send({
        sanctions: [{
          referenceId: generateUUID(),
          productUserId: userId,
          action: 'ban',
          reason: 'Account suspended',
          source: 'nova-backend',
          status: 'active',
          createdAt: new Date().toISOString(),
          expiresAt: '9999-12-31T23:59:59.999Z',
          tags: [],
        }],
        totalCount: 1,
      });
    }

    return reply.send({ sanctions: [], totalCount: 0 });
  });

  // Social ban check (legacy path)
  fastify.get('/socialban/api/public/v1/*', async (request, reply) => {
    return reply.send({ bans: [], warnings: [] });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS FRIENDS — Translates to existing friends DB
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/epic/friends/v1/:deploymentId/users/:userId/friends', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const accountId = productUserMap.get(userId) || userId;
    const friends = getFriends(accountId);

    return reply.send({
      friends: friends.filter(f => f.status === 'accepted').map(f => ({
        accountId: f.friend_id,
        productUserId: accountProductMap.get(f.friend_id) || f.friend_id,
        status: 'FRIENDS',
        created: f.created_at,
      })),
      incoming: friends.filter(f => f.status === 'pending' && f.direction === 'incoming').map(f => ({
        accountId: f.friend_id,
        productUserId: accountProductMap.get(f.friend_id) || f.friend_id,
      })),
      outgoing: friends.filter(f => f.status === 'pending' && f.direction === 'outgoing').map(f => ({
        accountId: f.friend_id,
        productUserId: accountProductMap.get(f.friend_id) || f.friend_id,
      })),
    });
  });

  fastify.post('/epic/friends/v1/:deploymentId/users/:userId/friends/:friendId', async (request, reply) => {
    const { userId, friendId } = request.params as { userId: string; friendId: string };
    const accountId = productUserMap.get(userId) || userId;
    const friendAccountId = productUserMap.get(friendId) || friendId;

    const theirFriends = getFriends(friendAccountId);
    const existing = theirFriends.find(f => f.friend_id === accountId && f.status === 'pending');
    if (existing) {
      acceptFriend(accountId, friendAccountId);
    } else {
      addFriend(accountId, friendAccountId, 'pending');
    }

    return reply.status(204).send();
  });

  fastify.delete('/epic/friends/v1/:deploymentId/users/:userId/friends/:friendId', async (request, reply) => {
    const { userId, friendId } = request.params as { userId: string; friendId: string };
    const accountId = productUserMap.get(userId) || userId;
    const friendAccountId = productUserMap.get(friendId) || friendId;
    removeFriend(accountId, friendAccountId);
    return reply.status(204).send();
  });

  fastify.get('/epic/friends/v1/:deploymentId/users/:userId/blocked', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const accountId = productUserMap.get(userId) || userId;
    const friends = getFriends(accountId);
    return reply.send({
      blockedUsers: friends.filter(f => f.status === 'blocked').map(f => ({
        accountId: f.friend_id,
        productUserId: accountProductMap.get(f.friend_id) || f.friend_id,
      })),
    });
  });

  fastify.post('/epic/friends/v1/:deploymentId/users/:userId/blocked/:blockedId', async (request, reply) => {
    const { userId, blockedId } = request.params as { userId: string; blockedId: string };
    const accountId = productUserMap.get(userId) || userId;
    const blockedAccountId = productUserMap.get(blockedId) || blockedId;
    blockUser(accountId, blockedAccountId);
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS PRESENCE — In-memory presence state
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/epic/presence/v1/:deploymentId/users/:userId/presence', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const presence = eosPresence.get(userId);

    return reply.send({
      productUserId: userId,
      status: presence?.status || 'online',
      productId: presence?.productId || Config.EOS_PRODUCT_ID,
      productName: presence?.productName || 'Fortnite',
      platform: presence?.platform || 'WIN',
      richText: presence?.richText || 'In Lobby',
      lastUpdated: presence?.updated || new Date().toISOString(),
    });
  });

  fastify.put('/epic/presence/v1/:deploymentId/users/:userId/presence', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const body = request.body as any;

    eosPresence.set(userId, {
      userId,
      status: body?.status || 'online',
      productId: body?.productId || Config.EOS_PRODUCT_ID,
      productName: body?.productName || 'Fortnite',
      platform: body?.platform || 'WIN',
      richText: body?.richText || '',
      updated: new Date().toISOString(),
    });

    return reply.status(204).send();
  });

  fastify.post('/epic/presence/v1/:deploymentId/presence/query', async (request, reply) => {
    const body = request.body as any;
    const userIds = body?.productUserIds || [];

    const results = userIds.map((puid: string) => {
      const presence = eosPresence.get(puid);
      return {
        productUserId: puid,
        status: presence?.status || 'offline',
        productName: presence?.productName || 'Fortnite',
        platform: presence?.platform || 'WIN',
        richText: presence?.richText || '',
        lastUpdated: presence?.updated || new Date().toISOString(),
      };
    });

    return reply.send({ presences: results });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS LOBBY — In-memory lobby management
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/lobby/v1/:deploymentId/lobbies', async (request, reply) => {
    const body = request.body as any;
    const accountId = resolveAccountId(request) ?? anonEosId();
    const puid = getOrCreateProductUser(accountId);
    const lobbyId = `lobby-${generateUUID()}`;

    const lobby: EosLobby = {
      id: lobbyId,
      ownerId: puid,
      maxMembers: body?.maxMembers || 16,
      permissionLevel: body?.permissionLevel || 'PUBLICADVERTISED',
      members: new Map([[puid, { role: 'OWNER', attributes: {} }]]),
      attributes: body?.attributes || {},
      created: new Date().toISOString(),
    };

    eosLobbies.set(lobbyId, lobby);
    console.log(`[EOS Lobby] Created lobby ${lobbyId}`);
    return reply.status(201).send(buildEosLobbyResponse(lobby));
  });

  fastify.get('/lobby/v1/:deploymentId/lobbies/:lobbyId', async (request, reply) => {
    const { lobbyId } = request.params as { lobbyId: string };
    const lobby = eosLobbies.get(lobbyId);
    if (!lobby) return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.lobby_not_found' });
    return reply.send(buildEosLobbyResponse(lobby));
  });

  fastify.put('/lobby/v1/:deploymentId/lobbies/:lobbyId', async (request, reply) => {
    const { lobbyId } = request.params as { lobbyId: string };
    const body = request.body as any;
    const lobby = eosLobbies.get(lobbyId);
    if (!lobby) return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.lobby_not_found' });

    if (body?.attributes) Object.assign(lobby.attributes, body.attributes);
    if (body?.maxMembers) lobby.maxMembers = body.maxMembers;
    if (body?.permissionLevel) lobby.permissionLevel = body.permissionLevel;

    return reply.send(buildEosLobbyResponse(lobby));
  });

  fastify.delete('/lobby/v1/:deploymentId/lobbies/:lobbyId', async (request, reply) => {
    eosLobbies.delete((request.params as any).lobbyId);
    return reply.status(204).send();
  });

  fastify.post('/lobby/v1/:deploymentId/lobbies/:lobbyId/members', async (request, reply) => {
    const { lobbyId } = request.params as { lobbyId: string };
    const body = request.body as any;
    const lobby = eosLobbies.get(lobbyId);
    if (!lobby) return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.lobby_not_found' });

    const userId = body?.productUserId || resolveAccountId(request) || anonEosId();
    lobby.members.set(userId, { role: 'MEMBER', attributes: body?.attributes || {} });

    return reply.send(buildEosLobbyResponse(lobby));
  });

  fastify.delete('/lobby/v1/:deploymentId/lobbies/:lobbyId/members/:userId', async (request, reply) => {
    const { lobbyId, userId } = request.params as { lobbyId: string; userId: string };
    const lobby = eosLobbies.get(lobbyId);
    if (lobby) {
      lobby.members.delete(userId);
      if (lobby.members.size === 0) eosLobbies.delete(lobbyId);
    }
    return reply.status(204).send();
  });

  fastify.post('/lobby/v1/:deploymentId/lobbies/:lobbyId/promote', async (request, reply) => {
    const { lobbyId } = request.params as { lobbyId: string };
    const body = request.body as any;
    const lobby = eosLobbies.get(lobbyId);
    if (lobby && body?.productUserId) {
      const member = lobby.members.get(body.productUserId);
      if (member) {
        const oldOwner = lobby.members.get(lobby.ownerId);
        if (oldOwner) oldOwner.role = 'MEMBER';
        member.role = 'OWNER';
        lobby.ownerId = body.productUserId;
      }
    }
    return reply.status(204).send();
  });

  fastify.post('/lobby/v1/:deploymentId/lobbies/:lobbyId/kick', async (request, reply) => {
    const { lobbyId } = request.params as { lobbyId: string };
    const body = request.body as any;
    const lobby = eosLobbies.get(lobbyId);
    if (lobby && body?.productUserId) lobby.members.delete(body.productUserId);
    return reply.status(204).send();
  });

  fastify.post('/lobby/v1/:deploymentId/lobbies/:lobbyId/invite', async (request, reply) => {
    return reply.send({ inviteId: generateUUID() });
  });

  fastify.post('/lobby/v1/:deploymentId/lobbies/search', async (request, reply) => {
    const body = request.body as any;
    const results: any[] = [];

    for (const [, lobby] of eosLobbies) {
      if (lobby.permissionLevel === 'PUBLICADVERTISED' && lobby.members.size < lobby.maxMembers) {
        results.push(buildEosLobbyResponse(lobby));
        if (results.length >= (body?.maxResults || 50)) break;
      }
    }

    return reply.send({ lobbies: results, totalCount: results.length });
  });

  // Lobby heartbeat
  fastify.put('/lobby/v1/:deploymentId/lobbies/:lobbyId/heartbeat', async (request, reply) => {
    return reply.status(204).send();
  });

  // Lobby member attributes
  fastify.put('/lobby/v1/:deploymentId/lobbies/:lobbyId/members/:userId/attributes', async (request, reply) => {
    const { lobbyId, userId } = request.params as { lobbyId: string; userId: string };
    const body = request.body as any;
    const lobby = eosLobbies.get(lobbyId);
    if (lobby) {
      const member = lobby.members.get(userId);
      if (member && body?.attributes) Object.assign(member.attributes, body.attributes);
    }
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS PLAYER DATA STORAGE — In-memory key-value store
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/datastorage/v1/:deploymentId/users/:userId/files', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const userFiles = eosPlayerData.get(userId);
    if (!userFiles) return reply.send({ files: [], totalCount: 0 });

    const files = Array.from(userFiles.values()).map(f => ({
      filename: f.filename,
      md5Hash: f.md5,
      fileSizeBytes: f.size,
      lastModified: f.modified,
    }));

    return reply.send({ files, totalCount: files.length });
  });

  fastify.get('/datastorage/v1/:deploymentId/users/:userId/files/:filename', async (request, reply) => {
    const { userId, filename } = request.params as { userId: string; filename: string };
    const userFiles = eosPlayerData.get(userId);
    const file = userFiles?.get(filename);

    if (!file) return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.file_not_found' });

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', file.size);
    return reply.send(file.data);
  });

  fastify.put('/datastorage/v1/:deploymentId/users/:userId/files/:filename', async (request, reply) => {
    const { userId, filename } = request.params as { userId: string; filename: string };
    // Normalise the body to a Buffer ONCE. The '*'/octet-stream parsers hand us a Buffer for real
    // binary uploads, but a stray application/json PUT arrives as a parsed object — calling
    // crypto.update() on that object threw ERR_INVALID_ARG_TYPE (a 500). Derive md5/size from the
    // same buffer so they can never disagree.
    const raw: any = request.body;
    const buf = Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw == null ? '' : (typeof raw === 'string' ? raw : JSON.stringify(raw)));

    if (!eosPlayerData.has(userId)) eosPlayerData.set(userId, new Map());
    const userFiles = eosPlayerData.get(userId)!;

    const crypto = require('crypto');
    userFiles.set(filename, {
      filename,
      data: buf,
      md5: crypto.createHash('md5').update(buf).digest('hex'),
      size: buf.length,
      modified: new Date().toISOString(),
    });

    return reply.status(204).send();
  });

  fastify.delete('/datastorage/v1/:deploymentId/users/:userId/files/:filename', async (request, reply) => {
    const { userId, filename } = request.params as { userId: string; filename: string };
    const userFiles = eosPlayerData.get(userId);
    if (userFiles) userFiles.delete(filename);
    return reply.status(204).send();
  });

  fastify.post('/datastorage/v1/:deploymentId/users/:userId/files/:filename/copy', async (request, reply) => {
    const { userId, filename } = request.params as { userId: string; filename: string };
    const body = request.body as any;
    const destFilename = body?.destinationFilename || `${filename}_copy`;

    const userFiles = eosPlayerData.get(userId);
    const source = userFiles?.get(filename);
    if (!source) return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.file_not_found' });

    userFiles!.set(destFilename, { ...source, filename: destFilename, modified: new Date().toISOString() });
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS TITLE STORAGE — Serves game config files
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/titlestorage/v1/:deploymentId/files', async (request, reply) => {
    const files = getTitleStorageFiles();
    return reply.send({
      files: files.map(f => ({
        filename: f.name,
        md5Hash: f.hash,
        fileSizeBytes: f.length,
      })),
      totalCount: files.length,
    });
  });

  fastify.get('/titlestorage/v1/:deploymentId/files/:filename', async (request, reply) => {
    const { filename } = request.params as { filename: string };
    // `filename` is a URL param and Fastify percent-decodes it AFTER splitting segments, so
    // "..%2f..%2f.env" arrives here as "../../.env" and path.join happily escapes
    // CLOUDSTORAGE_DIR. Verified exploitable: it served the backend's .env (tailnet auth key,
    // registry secret) to an unauthenticated caller. Resolve, then confine to the directory.
    const base = path.resolve(Config.CLOUDSTORAGE_DIR);
    const filePath = path.resolve(base, filename);
    if (filePath !== base && !filePath.startsWith(base + path.sep)) {
      return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.file_not_found' });
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      reply.header('Content-Type', 'application/octet-stream');
      return reply.send(fs.readFileSync(filePath));
    }
    return reply.status(404).send({ errorCode: 'errors.com.epicgames.eos.file_not_found' });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS ECOMMERCE — Translates to existing inventory/currency
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/epic/ecom/v1/:deploymentId/offers', async (request, reply) => {
    return reply.send({ offers: [], totalCount: 0 });
  });

  fastify.get('/epic/ecom/v1/:deploymentId/users/:userId/entitlements', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const accountId = productUserMap.get(userId) || userId;

    return reply.send({
      entitlements: [
        { id: 'fn-access', entitlementName: 'Fortnite_Access', namespace: 'fn', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da8', entitlementType: 'EXECUTABLE', active: true, consumable: false, count: 1 },
        { id: 'fn-br', entitlementName: 'Fortnite_BattleRoyale', namespace: 'fn', catalogItemId: '4fe75bbc5a674f4f9b356b5c90567da8', entitlementType: 'EXECUTABLE', active: true, consumable: false, count: 1 },
      ],
      totalCount: 2,
    });
  });

  fastify.get('/epic/ecom/v1/:deploymentId/users/:userId/ownership', async (request, reply) => {
    return reply.send({ owned: true });
  });

  fastify.post('/epic/ecom/v1/:deploymentId/users/:userId/ownership/token', async (request, reply) => {
    return reply.send({ token: generateHex(32) });
  });

  fastify.post('/epic/ecom/v1/:deploymentId/users/:userId/entitlements/redeem', async (request, reply) => {
    return reply.status(204).send();
  });

  // Ecommerce integration (legacy path)
  fastify.get('/ecommerceintegration/*', async (request, reply) => {
    return reply.send({});
  });

  // Payment (stub)
  fastify.all('/epic/payment/*', async (request, reply) => {
    return reply.send({});
  });

  // Price engine
  fastify.all('/priceengine/*', async (request, reply) => {
    return reply.send({});
  });

  // Inventory
  fastify.get('/inventory/v1/:deploymentId/users/:userId/items', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const accountId = productUserMap.get(userId) || userId;
    const inventory = getInventory(accountId);

    return reply.send({
      items: inventory.map(item => ({
        itemId: item.item_id,
        templateId: item.template_id,
        quantity: item.quantity,
      })),
      totalCount: inventory.length,
    });
  });

  fastify.post('/inventory/v1/:deploymentId/open', async (request, reply) => {
    return reply.send({ inventoryId: generateUUID() });
  });

  fastify.post('/inventory/v1/:deploymentId/close', async (request, reply) => {
    return reply.status(204).send();
  });

  // Receipt validator
  fastify.post('/receipt-validator/v1/:deploymentId/verify', async (request, reply) => {
    return reply.send({ valid: true });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS PLAYER REPORTS
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/player-reports/v1/:deploymentId/reports', async (request, reply) => {
    const body = request.body as any;
    console.log(`[EOS Reports] Report received: ${body?.category || 'unknown'} from ${body?.reporterProductUserId || 'unknown'}`);
    return reply.send({ reportId: generateUUID(), status: 'received' });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS RTC (Voice Chat) — Token generation
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/rtc/v1/:deploymentId/rooms/:roomName/token', async (request, reply) => {
    const { roomName } = request.params as { roomName: string };
    return reply.send({
      token: generateHex(32),
      roomName,
      clientIp: '127.0.0.1',
      serverUrl: `ws://127.0.0.1:${Config.HTTP_PORT}/rtc`,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS NOTIFICATIONS / MESSAGING — HTTP fallbacks
  //  (WebSocket handled separately via XMPP/STOMP)
  // ═══════════════════════════════════════════════════════════════

  fastify.all('/notifications/v1/:deploymentId/*', async (request, reply) => {
    return reply.status(204).send();
  });

  // EpicConnect messaging HTTP fallback
  fastify.all('/connect/v1/*', async (request, reply) => {
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS METRICS — Telemetry ingestion
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/ingestion/stats/v1/:deploymentId/metrics', async (request, reply) => {
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS SDK CONFIG & ACCOUNT LOOKUP
  // ═══════════════════════════════════════════════════════════════

  fastify.get('/sdk/v1/*', async (request, reply) => {
    // Imported at module scope, not require()d here: `tsc` does not follow a bare require(), so
    // the JSON was never emitted to dist/ and this threw MODULE_NOT_FOUND (→ 500) under
    // `npm start`. It only ever worked under `npm run dev`, which runs from src/.
    return reply.send(sdkConfig);
  });

  fastify.get('/epic/id/v2/sdk/accounts', async (request, reply) => {
    const query = request.query as any;
    const accountId = query.accountId || resolveAccountId(request);
    // Nothing to look up for an unidentified caller — an empty list is the correct answer here.
    if (!accountId) return reply.send([]);
    const account = getAccount(accountId);

    return reply.send([{
      accountId,
      displayName: account?.display_name || 'NovaPlayer',
      preferredLanguage: 'en',
      cabinedMode: false,
      empty: false,
    }]);
  });

  // Epic settings
  fastify.all('/v1/epic-settings/public/users/:userId/values', async (request, reply) => {
    return reply.send({});
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS PROGRESSION SNAPSHOTS — Stub
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/snapshots/v1/:deploymentId/submit', async (request, reply) => {
    return reply.send({ snapshotId: generateUUID() });
  });

  fastify.delete('/snapshots/v1/:deploymentId/snapshots/:snapshotId', async (request, reply) => {
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS KWS (Kids Web Services) — Stub
  // ═══════════════════════════════════════════════════════════════

  fastify.all('/kws/v1/:deploymentId/*', async (request, reply) => {
    return reply.send({
      isMinor: false,
      permissions: { canChat: true, canPlay: true, canShareData: true },
    });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS MODS — Stub
  // ═══════════════════════════════════════════════════════════════

  fastify.all('/mods/v1/:deploymentId/*', async (request, reply) => {
    return reply.send({ mods: [], totalCount: 0 });
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS USER INFO
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/epic/id/v2/sdk/accounts/query', async (request, reply) => {
    const body = request.body as any;
    const accountIds = body?.accountIds || [];

    const results = accountIds.map((id: string) => {
      const account = getAccount(id);
      return {
        accountId: id,
        displayName: account?.display_name || 'NovaPlayer',
        preferredLanguage: 'en',
        country: 'US',
      };
    });

    return reply.send(results);
  });

  // External account mappings
  fastify.get('/connect/v1/:deploymentId/externalAccountMappings', async (request, reply) => {
    const query = request.query as Record<string, string | string[]>;
    let accountIds: string[] = [];
    if (typeof query.accountId === 'string') accountIds = [query.accountId];
    else if (Array.isArray(query.accountId)) accountIds = query.accountId;

    const mappings = accountIds.map(id => ({
      accountId: id,
      productUserId: accountProductMap.get(id) || getOrCreateProductUser(id),
      externalAccountType: 'epic',
    }));

    return reply.send(mappings);
  });

  // ═══════════════════════════════════════════════════════════════
  //  EOS CONTENT SANITIZER
  // ═══════════════════════════════════════════════════════════════

  fastify.post('/content/api/sanitize', async (request, reply) => {
    const body = request.body as any;
    return reply.send({ sanitized: body?.text || '', modified: false });
  });

  // ═══════════════════════════════════════════════════════════════
  //  CATCH-ALL for unimplemented EOS endpoints
  //  Returns appropriate empty responses to prevent client errors
  // ═══════════════════════════════════════════════════════════════

  const eosPathPrefixes = [
    '/auth/', '/connect/', '/matchmaking/', '/stats/', '/leaderboards/',
    '/anticheat/', '/sanctions/', '/datastorage/', '/titlestorage/',
    '/lobby/', '/epic/', '/notifications/', '/player-reports/',
    '/rtc/', '/inventory/', '/ingestion/', '/snapshots/', '/kws/',
    '/mods/', '/receipt-validator/', '/cerberus-edge/',
  ];

  fastify.addHook('onRequest', async (request, reply) => {
    if (reply.sent) return;
    const url = request.url.split('?')[0];
    const isEosPath = eosPathPrefixes.some(p => url.startsWith(p));
    if (isEosPath) {
      (request as any).isEosRequest = true;
    }
  });

  console.log('[EOS] Full Epic Online Services translation layer registered');
  console.log('[EOS] Deployment:', Config.EOS_DEPLOYMENT_ID);
  console.log('[EOS] Product:', Config.EOS_PRODUCT_ID);
  console.log('[EOS] Services: Connect, Sessions, Stats, Achievements, Leaderboards,');
  console.log('[EOS]           Anti-Cheat, Sanctions, Friends, Presence, Lobby,');
  console.log('[EOS]           Storage, Ecom, Reports, RTC, Notifications');
}

// ═══════════════════════════════════════════════════════════════════
//  RESPONSE BUILDERS
// ═══════════════════════════════════════════════════════════════════

function buildEosSessionResponse(session: EosSession): any {
  return {
    id: session.id,
    deploymentId: Config.EOS_DEPLOYMENT_ID,
    ownerId: session.ownerId,
    bucketId: session.bucketId,
    settings: session.settings,
    attributes: session.attributes,
    totalPlayers: session.players.size,
    openSlots: session.maxPlayers - session.players.size,
    maxPlayers: session.maxPlayers,
    players: Array.from(session.players),
    started: session.started,
    createdAt: session.created,
    lastUpdated: new Date().toISOString(),
    allowJoinInProgress: true,
    permissionLevel: 'PUBLICADVERTISED',
  };
}

function buildEosLobbyResponse(lobby: EosLobby): any {
  const members: any[] = [];
  for (const [userId, info] of lobby.members) {
    members.push({
      productUserId: userId,
      role: info.role,
      attributes: info.attributes,
    });
  }

  return {
    id: lobby.id,
    ownerId: lobby.ownerId,
    deploymentId: Config.EOS_DEPLOYMENT_ID,
    maxMembers: lobby.maxMembers,
    currentMembers: members.length,
    permissionLevel: lobby.permissionLevel,
    members,
    attributes: lobby.attributes,
    createdAt: lobby.created,
    lastUpdated: new Date().toISOString(),
    availableSlots: lobby.maxMembers - members.length,
  };
}

function getTitleStorageFiles(): { name: string; hash: string; length: number }[] {
  if (!fs.existsSync(Config.CLOUDSTORAGE_DIR)) return [];
  const crypto = require('crypto');
  return fs.readdirSync(Config.CLOUDSTORAGE_DIR)
    .filter(f => f.endsWith('.ini') || f.endsWith('.json') || f.endsWith('.bin'))
    .map(name => {
      const content = fs.readFileSync(path.join(Config.CLOUDSTORAGE_DIR, name));
      return {
        name,
        hash: crypto.createHash('md5').update(content).digest('hex'),
        length: content.length,
      };
    });
}
