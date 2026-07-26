import { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.middleware';
import {
  getAnticheatFlags, getAnticheatRisk, setAccountBanned, getAccount,
  getMatchMeta, recordMatchParticipant,
} from '../../database';
import { Config } from '../../config';
import {
  analyzeAttestation, analyzeMatchReport, analyzeReportAuthority, noteRequest,
  applyDetections, Detection, MatchReport,
} from './anticheat.service';

/** Admin endpoints are gated by a shared secret rather than a role, because Nova has no admin
 *  accounts. Falls back to the registration secret so there is only one secret to manage. */
function adminOk(request: any): boolean {
  const expected = Config.AC_ADMIN_SECRET || Config.REGISTER_SECRET;
  if (!expected) return false; // no secret configured → admin views stay closed, not wide open
  const supplied = String(
    (request.headers?.['x-nova-admin'] as string) || (request.query as any)?.secret || (request.body as any)?.secret || ''
  );
  return supplied.length > 0 && supplied === expected;
}

/**
 * Anti-cheat routes. See anticheat.service.ts for what these detections can and cannot prove —
 * everything here treats client and host input as untrusted.
 */
export async function anticheatRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * POST /nova/api/anticheat/attest
   * The launcher reports the modules loaded into the game process. Self-reported, so a low-trust
   * signal — useful for catching careless cheats, useless against a patched launcher.
   * Body: { modules: string[] }
   */
  fastify.post('/nova/api/anticheat/attest', { preHandler: requireAuth }, async (request, reply) => {
    const accountId = (request as any).accountId as string;
    const body = (request.body || {}) as any;
    const modules: string[] = Array.isArray(body.modules) ? body.modules : [];

    const detections: Detection[] = [
      ...noteRequest(accountId),
      ...analyzeAttestation(modules),
    ];
    const result = applyDetections(accountId, detections);
    // Deliberately vague to the client: telling a cheater exactly which module tripped the rule is
    // free debugging for them.
    return reply.send({ accepted: true, modulesSeen: modules.length, action: result.banned ? 'banned' : 'none' });
  });

  /**
   * POST /nova/api/anticheat/report
   * End-of-match results submitted by the HOST's machine. The report is untrusted input: we check
   * that the reporter actually hosted the match and that the subject actually played in it before
   * anything is written.
   * Body: { matchId, subjectAccountId, kills, damage, placement, durationSec, playersInMatch, score? }
   */
  fastify.post('/nova/api/anticheat/report', { preHandler: requireAuth }, async (request, reply) => {
    const reporter = (request as any).accountId as string;
    const b = (request.body || {}) as any;
    const matchId = String(b.matchId || '').trim();
    const subject = String(b.subjectAccountId || '').trim() || reporter;
    if (!matchId) return reply.status(400).send({ error: 'matchId required' });

    const meta = getMatchMeta(matchId);
    if (!meta) return reply.status(404).send({ error: 'unknown match' });

    const report: MatchReport = {
      accountId: subject,
      matchId,
      playersInMatch: Number(b.playersInMatch) || 100,
      kills: Number(b.kills) || 0,
      damage: Number(b.damage) || 0,
      placement: Number(b.placement) || 0,
      durationSec: Number(b.durationSec) || 0,
      score: Number(b.score) || 0,
    };

    const authority = analyzeReportAuthority({
      reporterAccountId: reporter,
      claimedHostAccountId: meta.hostAccountId,
      participants: meta.participants,
      subjectAccountId: subject,
      alreadyReported: meta.participants.includes(subject),
    });
    const plausibility = analyzeMatchReport(report);

    // Flags land on whoever is responsible: an authority violation is the REPORTER's doing, an
    // implausible stat line is the SUBJECT's. Blaming the wrong account is how anti-cheat becomes a
    // griefing tool.
    const reporterResult = applyDetections(reporter, [...noteRequest(reporter), ...authority], matchId);
    const subjectResult = applyDetections(subject, plausibility, matchId);

    // Only accept the numbers if the reporter had the authority to send them and nothing was
    // physically impossible. Otherwise the match simply doesn't count.
    const rejected = authority.length > 0 || plausibility.some((d) => d.severity >= 8);
    if (!rejected) {
      recordMatchParticipant(
        matchId, subject, report.kills, report.placement,
        report.score || 0, report.damage, report.durationSec
      );
    }

    return reply.send({
      accepted: !rejected,
      reason: rejected ? 'report failed validation' : 'recorded',
      reporterFlags: reporterResult.flagged,
      subjectFlags: subjectResult.flagged,
    });
  });

  /** GET /nova/api/anticheat/risk — an account's own risk total (players may see their own). */
  fastify.get('/nova/api/anticheat/risk', { preHandler: requireAuth }, async (request, reply) => {
    const accountId = (request as any).accountId as string;
    const acct = getAccount(accountId);
    return reply.send({
      accountId,
      risk24h: getAnticheatRisk(accountId),
      banned: acct?.banned === 1,
      autobanAt: Config.AC_AUTOBAN_AT || null,
    });
  });

  /** GET /nova/api/anticheat/flags?accountId=&limit= — admin audit trail. */
  fastify.get('/nova/api/anticheat/flags', async (request, reply) => {
    if (!adminOk(request)) return reply.status(403).send({ error: 'admin secret required' });
    const q = (request.query || {}) as any;
    const accountId = q.accountId ? String(q.accountId) : undefined;
    const limit = parseInt(String(q.limit || '100'), 10);
    const flags = getAnticheatFlags(accountId, isNaN(limit) ? 100 : limit);
    return reply.send({ flags, count: flags.length });
  });

  /** POST /nova/api/anticheat/ban — admin: { accountId, banned, secret }. */
  fastify.post('/nova/api/anticheat/ban', async (request, reply) => {
    if (!adminOk(request)) return reply.status(403).send({ error: 'admin secret required' });
    const b = (request.body || {}) as any;
    const accountId = String(b.accountId || '').trim();
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    const banned = b.banned !== false;
    if (!getAccount(accountId)) return reply.status(404).send({ error: 'unknown account' });
    setAccountBanned(accountId, banned);
    console.log(`[AntiCheat] Admin ${banned ? 'banned' : 'unbanned'} ${accountId}`);
    return reply.send({ success: true, accountId, banned });
  });
}
