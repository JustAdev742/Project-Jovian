import { FastifyInstance } from 'fastify';
import { getPlayerStats, seedDefaultStats, getLeaderboard, getAccount, recordMatch, endMatch, recordMatchParticipant } from '../../database';
import { requireAuth } from '../../middleware/auth.middleware';
import { updatePostMatchStats, MatchResult, calculateMatchXp } from './stats.service';

/**
 * Stats v2 Routes — DB-backed player statistics and leaderboards.
 */
export async function statsRoutes(fastify: FastifyInstance): Promise<void> {

  /** GET /fortnite/api/statsv2/account/:accountId — player stats */
  fastify.get('/fortnite/api/statsv2/account/:accountId', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    seedDefaultStats(accountId);
    const stats = getPlayerStats(accountId);
    return reply.send({
      startTime: 0,
      endTime: 9999999999,
      stats,
      accountId,
    });
  });

  /** GET /statsproxy/api/statsv2/account/:accountId — proxy stats endpoint */
  fastify.get('/statsproxy/api/statsv2/account/:accountId', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    seedDefaultStats(accountId);
    const stats = getPlayerStats(accountId);
    return reply.send({
      startTime: 0,
      endTime: 9999999999,
      stats,
      accountId,
    });
  });

  /** POST /fortnite/api/statsv2/query — bulk stats query */
  fastify.post('/fortnite/api/statsv2/query', async (request, reply) => {
    const body = request.body as any;
    // Cap the client-supplied list so a request can't trigger unbounded DB writes (each seed writes).
    const owners: string[] = (Array.isArray(body?.owners) ? body.owners : []).slice(0, 100);
    return reply.send(owners.map((ownerId: string) => {
      seedDefaultStats(ownerId);
      return {
        startTime: 0,
        endTime: 9999999999,
        stats: getPlayerStats(ownerId),
        accountId: ownerId,
      };
    }));
  });

  /** GET /fortnite/api/statsv2/leaderboards/:leaderboardName — real leaderboard */
  fastify.get('/fortnite/api/statsv2/leaderboards/:leaderboardName', async (request, reply) => {
    const { leaderboardName } = request.params as { leaderboardName: string };
    const query = request.query as Record<string, string>;
    // A non-numeric pageSize used to become NaN, which sql.js binds as NULL — and `LIMIT NULL`
    // means "no limit", dumping the whole table with every rank serialised as null.
    const pageSize = Math.min(Math.max(parseInt(query.pageSize || '25', 10) || 25, 1), 200);
    const page = Math.max(parseInt(query.page || '0', 10) || 0, 0);

    const entries = getLeaderboard(leaderboardName, pageSize, page * pageSize);
    return reply.send({
      entries: entries.map((e, i) => ({
        account: e.accountId,
        value: e.value,
        rank: page * pageSize + i + 1,
        displayName: getAccount(e.accountId)?.display_name || 'Unknown',
      })),
      maxSize: 1000,
      currentTime: Math.floor(Date.now() / 1000),
    });
  });

  /** POST /fortnite/api/feedback/:type — gameplay feedback/reports */
  fastify.post('/fortnite/api/feedback/:type', async (request, reply) => {
    return reply.status(200).send({ success: true });
  });

  /** GET /fortnite/api/game/v2/world/info — STW world info (BR still queries it) */
  fastify.get('/fortnite/api/game/v2/world/info', async (request, reply) => {
    return reply.send({ theaters: [], missions: [], missionAlerts: [] });
  });

  // ═══════════════════════════════════════════════
  //  POST-MATCH REPORTING (Nova custom endpoints)
  // ═══════════════════════════════════════════════

  /** POST /nova/api/match/report — host reports match results */
  // Gated: this writes permanent stats and unlocks achievements for every accountId in the body,
  // and its matchId is what /nova/api/anticheat/report keys off. Unauthenticated, anyone could
  // rewrite another player's career stats or manufacture a matchId to get them auto-banned.
  fastify.post('/nova/api/match/report', { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body as any;
    const { sessionId, playlistId, region, participants } = body;
    const reporter = (request as any).accountId as string;

    if (!sessionId || !participants || !Array.isArray(participants)) {
      return reply.status(400).send({ error: 'Missing sessionId or participants array' });
    }

    // The host is whoever authenticated — never a client-supplied field. The old `|| 'unknown'`
    // fallback also made the anti-cheat's not_the_host rule fire on every later report.
    const matchId = recordMatch(sessionId, playlistId || 'Playlist_DefaultSolo', region || 'NAE', reporter);

    // Process each participant
    const results: any[] = [];
    for (const p of participants) {
      const { accountId, kills, placement, damageDealt, timeAliveSeconds } = p;
      if (!accountId) continue;

      // Validate sanity (anti-tamper)
      // You cannot eliminate yourself, so the ceiling is participants-1 — the same bound the
      // anti-cheat enforces (kills > players-1 => severity 9). They disagreed by one.
      const sanitizedKills = Math.max(0, Math.min(kills || 0, Math.max(0, participants.length - 1)));
      const sanitizedPlacement = Math.max(1, Math.min(placement || 100, 100));
      const sanitizedDamage = Math.max(0, Math.min(damageDealt || 0, 99999));
      const sanitizedTime = Math.max(0, Math.min(timeAliveSeconds || 0, 7200)); // Max 2 hours

      const xpEarned = calculateMatchXp(sanitizedKills, sanitizedPlacement, sanitizedTime);

      // Record participant in match history
      recordMatchParticipant(matchId, accountId, sanitizedKills, sanitizedPlacement, xpEarned, sanitizedDamage, sanitizedTime);

      // Update persistent stats
      const matchResult: MatchResult = {
        accountId,
        kills: sanitizedKills,
        placement: sanitizedPlacement,
        damageDealt: sanitizedDamage,
        timeAliveSeconds: sanitizedTime,
        playlistId: playlistId || 'Playlist_DefaultSolo',
      };
      updatePostMatchStats(matchResult);

      results.push({ accountId, xpEarned, kills: sanitizedKills, placement: sanitizedPlacement });
    }

    endMatch(matchId);
    console.log(`[Stats] Match ${matchId} reported: ${results.length} participants`);
    return reply.send({ matchId, results });
  });
}
