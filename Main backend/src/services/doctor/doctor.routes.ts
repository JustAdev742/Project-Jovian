/**
 * Fleet doctor routes.
 *
 *   PLAYER'S PC (host agent, NOVA_COORDINATOR set)
 *     doctor live ──► POST /nova/api/doctor/local          problem lines        (localhost, no auth)
 *                 ──► POST /nova/api/doctor/local-report   summary + full report
 *     launcher    ◄── GET  /nova/api/doctor/pending        drains both (destructive hand-off)
 *
 *   COORDINATOR
 *     launcher    ──► POST /nova/api/doctor/ingest         under the PLAYER'S token, rate-limited
 *     admin       ──► GET  /nova/api/doctor/dashboard …    behind NOVA_AC_ADMIN_SECRET
 *
 * The local routes exist only on a host agent and the ingest/admin routes only on the coordinator.
 * That split is the whole security model: the coordinator publishes every path to the internet
 * through Tailscale Funnel, and Funnel traffic arrives from 127.0.0.1, so a "local only" route must
 * simply not exist there (KNOWN_ISSUES coordinator-local-control-routes-public).
 *
 * Same attribution model as the diagnostics pipeline: the doctor holds no credential; the launcher,
 * which legitimately has an identity, forwards (DIAGNOSTICS_ARCHITECTURE §2).
 */
import { FastifyInstance } from 'fastify';
import { Config } from '../../config';
import { requireAuth } from '../../middleware/auth.middleware';
import { adminOk } from '../nova/diagnostics.routes';
import { normalizeLines, normalizeSummary, decodeFullReport, LIMITS } from './doctor.validate';
import { recordLines, recordReport, listPlayers, getPlayer, latestReport, linesSince, fleetProblems } from './doctor.store';
import { renderFleetPage, renderPlayerPage, renderLockedPage, renderPlayerReport } from './doctor.dashboard';

const QUEUE_MAX_LINES = 2000;

// Per-account token bucket for ingest. A launcher forwards every ~20 s; the burst covers catching up
// after a dropped connection without letting one client flood the store.
const BURST = 20;
const REFILL_PER_SEC = 0.2;
const buckets = new Map<string, { tokens: number; last: number }>();
function take(accountId: string, now = Date.now()): boolean {
  const b = buckets.get(accountId) || { tokens: BURST, last: now };
  b.tokens = Math.min(BURST, b.tokens + ((now - b.last) / 1000) * REFILL_PER_SEC);
  b.last = now;
  buckets.set(accountId, b);
  if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value as string);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export async function doctorRoutes(fastify: FastifyInstance): Promise<void> {
  const agentMode = () => !!Config.COORDINATOR_URL;

  // ── player's PC: the local hand-off ─────────────────────────────────────────────────────────────
  let queue: any[] = [];
  let dropped = 0;
  let pendingReport: { summary: unknown; full: string | null } | null = null;

  fastify.post('/nova/api/doctor/local', async (request, reply) => {
    if (!agentMode()) return reply.status(404).send({ error: 'not a host agent' });
    const body = (request.body || {}) as any;
    const lines = normalizeLines(body.lines);
    queue.push(...lines);
    dropped += Math.max(0, Math.min(1e6, Number(body.dropped) | 0));
    if (queue.length > QUEUE_MAX_LINES) { dropped += queue.length - QUEUE_MAX_LINES; queue = queue.slice(-QUEUE_MAX_LINES); }
    return reply.send({ accepted: lines.length });
  });

  fastify.post('/nova/api/doctor/local-report', async (request, reply) => {
    if (!agentMode()) return reply.status(404).send({ error: 'not a host agent' });
    const body = (request.body || {}) as any;
    const full = typeof body.full === 'string' && body.full.length <= Math.ceil(LIMITS.FULL_GZ_BYTES * 4 / 3) + 8 ? body.full : null;
    pendingReport = { summary: normalizeSummary(body.summary), full };   // newest wins
    return reply.send({ accepted: true });
  });

  fastify.get('/nova/api/doctor/pending', async (_request, reply) => {
    if (!agentMode()) return reply.status(404).send({ error: 'not a host agent' });
    const out = { lines: queue, dropped, report: pendingReport };
    queue = []; dropped = 0; pendingReport = null;
    return reply.send(out);
  });

  // ── coordinator: ingest under the player's token ────────────────────────────────────────────────
  fastify.post('/nova/api/doctor/ingest', { preHandler: requireAuth }, async (request, reply) => {
    if (agentMode()) return reply.status(404).send({ error: 'ingest runs on the coordinator' });
    const accountId = (request as any).accountId as string;
    const displayName = String((request as any).displayName || 'player').slice(0, 64);
    if (!take(accountId)) {
      reply.header('retry-after', '30');
      return reply.status(429).send({ error: 'doctor ingest rate limit exceeded' });
    }
    const body = (request.body || {}) as any;
    const launcher = String(body.launcher || '').slice(0, 20);
    const lines = normalizeLines(body.lines);
    const accepted = lines.length || body.dropped ? recordLines(accountId, displayName, launcher, lines, Number(body.dropped) | 0) : 0;
    let report = false;
    if (body.report && typeof body.report === 'object') {
      const summary = normalizeSummary(body.report.summary);
      const full = decodeFullReport(body.report.full);
      recordReport(accountId, displayName, launcher, summary, full);
      report = true;
    }
    return reply.send({ accepted, report });
  });

  // ── coordinator: admin views ────────────────────────────────────────────────────────────────────
  const refuse = (reply: any, next: string) => reply.status(403).type('text/html; charset=utf-8').send(renderLockedPage(next));

  fastify.get('/nova/api/doctor/dashboard', async (request, reply) => {
    if (!adminOk(request)) return refuse(reply, '/nova/api/doctor/dashboard');
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
      .send(renderFleetPage({ players: listPlayers(), problems: fleetProblems(), lines: linesSince(0, { limit: 150 }) }));
  });

  fastify.get('/nova/api/doctor/fleet.json', async (request, reply) => {
    if (!adminOk(request)) return reply.status(403).send({ error: 'admin secret required' });
    return reply.header('cache-control', 'no-store').send({ players: listPlayers(), problems: fleetProblems() });
  });

  fastify.get('/nova/api/doctor/lines.json', async (request, reply) => {
    if (!adminOk(request)) return reply.status(403).send({ error: 'admin secret required' });
    const q = (request.query || {}) as any;
    const account = /^[0-9a-f]{32}$/.test(String(q.account || '')) ? String(q.account) : undefined;
    const minSev = ['P0', 'P1', 'P2', 'P3', 'INFO'].includes(q.sev) ? q.sev : undefined;
    return reply.header('cache-control', 'no-store')
      .send({ lines: linesSince(Math.max(0, Number(q.since) | 0), { accountId: account, minSev, limit: Number(q.limit) || 200 }) });
  });

  fastify.get('/nova/api/doctor/players/:id', async (request, reply) => {
    const id = String((request.params as any).id || '');
    if (!/^[0-9a-f]{32}$/.test(id)) return reply.status(404).send({ error: 'unknown player' });
    if (!adminOk(request)) return refuse(reply, `/nova/api/doctor/players/${id}`);
    const player = getPlayer(id);
    if (!player) return reply.status(404).type('text/html; charset=utf-8').send(renderLockedPage('/nova/api/doctor/dashboard', 'No reports from that player yet.'));
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store')
      .send(renderPlayerPage({ player, report: latestReport(id), lines: linesSince(0, { accountId: id, limit: 200 }) }));
  });

  fastify.get('/nova/api/doctor/players/:id/report.html', async (request, reply) => {
    const id = String((request.params as any).id || '');
    if (!/^[0-9a-f]{32}$/.test(id) || !adminOk(request)) return reply.status(403).send({ error: 'admin secret required' });
    const rep = latestReport(id);
    if (!rep?.full) return reply.status(404).send({ error: 'no full report from this player yet' });
    // The report is built from a PLAYER'S data. Even though every value was validated and is
    // escaped, the page runs in a sandbox: an opaque origin cannot send the admin cookie or read any
    // admin response, so a renderer bug could never become an admin action.
    return reply
      .header('content-security-policy', "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(await renderPlayerReport(rep.full));
  });
}
