import { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.middleware';
import { Config } from '../../config';
import { recordDiagnostic, getDiagnostics, getDiagnosticsSummary } from './diagnostics';
import { parseBatch, LIMITS } from './diagnostics.schema';
import { buildIncidents, incidentId } from './incidents';
import { renderDashboard } from './dashboard';

/**
 * The distributed diagnostics surface: where player and host machines report failures, and where an
 * operator reads what is happening across the whole population.
 *
 * TWO DIFFERENT TRUST LEVELS, AND THEY ARE NOT THE SAME BOUNDARY.
 *
 *   INGEST is per-player. It needs a valid player token and reports only that player's own events.
 *   A player may write; a player may not read anyone's data, including their own aggregate.
 *
 *   READING is administrative. The incident list is cross-population data — routes, builds, affected
 *   counts — and is gated behind the admin secret, which FAILS CLOSED when unset. On a coordinator
 *   with no secret configured the dashboard is unavailable rather than public, and says so.
 *
 * Getting this backwards would turn a debugging aid into a public map of everyone's failures, on a
 * host that Tailscale Funnel publishes to the open internet.
 */

/** Same gate as the anti-cheat admin views, deliberately: one secret to manage, one behaviour. */
function adminOk(request: any): boolean {
  const expected = Config.AC_ADMIN_SECRET || Config.REGISTER_SECRET;
  if (!expected) return false; // no secret configured → closed, not open
  const supplied = String(
    request.headers?.['x-nova-admin'] || (request.query as any)?.secret || (request.body as any)?.secret || ''
  );
  return supplied.length > 0 && supplied === expected;
}

function adminRefused(reply: any) {
  return reply.status(403).send({
    error: 'diagnostics admin access is not configured',
    detail:
      'Set NOVA_AC_ADMIN_SECRET (or NOVA_REGISTER_SECRET) on the coordinator and send it as the ' +
      'x-nova-admin header. Unset means closed — this view exposes cross-player data.',
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  RATE LIMITING
//
//  The ingest endpoint is reachable by anyone with a player token, so it needs a ceiling that does
//  not depend on clients behaving. A token bucket per account: BURST events immediately, refilling
//  at REFILL_PER_SEC. Generous enough that a genuinely broken client reports everything it sees,
//  small enough that a hostile one cannot flood the store.
//
//  Over-limit returns 429 with the standard Retry-After rather than dropping silently, so a
//  well-behaved client can back off instead of spinning.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const BURST = 120;
const REFILL_PER_SEC = 2;
const MAX_TRACKED_CLIENTS = 2000;

interface Bucket { tokens: number; last: number }
const buckets = new Map<string, Bucket>();

function takeTokens(accountId: string, n: number, now = Date.now()): boolean {
  let b = buckets.get(accountId);
  if (!b) {
    if (buckets.size >= MAX_TRACKED_CLIENTS) {
      // Evict the least recently seen. Bounded because this map is keyed by request data.
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of buckets) if (v.last < oldest) { oldest = v.last; oldestKey = k; }
      if (oldestKey) buckets.delete(oldestKey);
    }
    b = { tokens: BURST, last: now };
    buckets.set(accountId, b);
  }
  const elapsedSec = Math.max(0, (now - b.last) / 1000);
  b.tokens = Math.min(BURST, b.tokens + elapsedSec * REFILL_PER_SEC);
  b.last = now;
  if (b.tokens < n) return false;
  b.tokens -= n;
  return true;
}

/** Test hook. */
export function resetRateLimits(): void {
  buckets.clear();
}

export async function diagnosticsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /nova/api/diagnostics/ingest
   *
   * A player's launcher forwards what Cobalt and Reboot observed. Body:
   *   { events: [ { source, category, method, url, component, build?, status?, detail?,
   *                 correlationId?, count? } ] }
   *
   * Everything is validated by `parseBatch` — enums whitelisted, strings truncated, counts clamped,
   * unknown fields dropped. A malformed event is skipped rather than failing the batch, because one
   * bad row from a client should not discard the good ones that came with it.
   *
   * The reporting account is attached server-side from the token. A client cannot attribute events
   * to anybody else, which is what stops this being a way to frame another player as the source of
   * an incident.
   */
  fastify.post('/nova/api/diagnostics/ingest', { preHandler: requireAuth }, async (request, reply) => {
    const accountId = (request as any).accountId as string;
    const body = (request.body || {}) as any;
    const events = parseBatch(body.events);

    if (events.length === 0) {
      return reply.send({ accepted: 0, dropped: Array.isArray(body.events) ? body.events.length : 0 });
    }

    if (!takeTokens(accountId, events.length)) {
      reply.header('retry-after', '30');
      return reply.status(429).send({
        error: 'diagnostic rate limit exceeded',
        accepted: 0,
        // Tell the client what the ceiling is so it can pace itself rather than guess.
        limit: { burst: BURST, refillPerSecond: REFILL_PER_SEC, maxBatch: LIMITS.MAX_BATCH },
      });
    }

    for (const ev of events) {
      recordDiagnostic({
        category: ev.category,
        source: ev.source,
        component: ev.component,
        correlationId: ev.correlationId,
        count: ev.count,
        method: ev.method,
        url: ev.url,
        version: ev.build,
        accountId,
        status: ev.status,
        detail: ev.detail,
      });
    }

    const dropped = (Array.isArray(body.events) ? body.events.length : 0) - events.length;
    return reply.send({ accepted: events.length, dropped: Math.max(0, dropped) });
  });

  /**
   * POST /nova/api/diagnostics/local
   *
   * The in-process components — Cobalt inside the game, Reboot inside the gameserver — report here.
   *
   * UNAUTHENTICATED, ON PURPOSE, AND ONLY SAFE BECAUSE OF WHERE IT LIVES. Neither DLL holds a user
   * token, and neither should: the brief forbids transmitting credentials, and a component that
   * harvested the player's bearer token to authenticate its own telemetry would be doing exactly
   * that. `Config.HOST` is hard-coded to 127.0.0.1, so this endpoint is reachable only from the
   * player's own machine — the same reasoning that already governs `/nova/api/logs/ingest`.
   *
   * It therefore records NO account id. These events say "something failed on this machine", and the
   * launcher is what later attributes them to a player when it forwards them upstream with its own
   * token. That split is deliberate: the untrusted in-game component never touches identity.
   *
   * Bounded the same way as the authenticated path — same parser, same caps, same clamps.
   */
  fastify.post('/nova/api/diagnostics/local', async (request, reply) => {
    const body = (request.body || {}) as any;
    const events = parseBatch(body.events);
    if (events.length === 0) return reply.send({ accepted: 0 });

    // One shared bucket for the whole machine, since there is no account to key on. A broken local
    // component must not be able to fill the store either.
    if (!takeTokens('__local__', events.length)) {
      reply.header('retry-after', '30');
      return reply.status(429).send({ accepted: 0 });
    }

    for (const ev of events) {
      recordDiagnostic({
        category: ev.category,
        source: ev.source,
        component: ev.component,
        correlationId: ev.correlationId,
        count: ev.count,
        method: ev.method,
        url: ev.url,
        version: ev.build,
        status: ev.status,
        detail: ev.detail,
        // No accountId: this endpoint has no authenticated identity and must not invent one.
      });
    }
    return reply.send({ accepted: events.length });
  });

  /** GET /nova/api/incidents — ranked, spiking first. Admin only. */
  fastify.get('/nova/api/incidents', async (request, reply) => {
    if (!adminOk(request)) return adminRefused(reply);
    const q = (request.query as any) || {};
    const incidents = buildIncidents(getDiagnostics({ limit: 400 }));
    const filtered = incidents.filter((i) => {
      if (q.severity && i.severity !== String(q.severity).toUpperCase()) return false;
      if (q.source && i.source !== String(q.source).toUpperCase()) return false;
      if (q.state && i.state !== String(q.state).toUpperCase()) return false;
      if (q.build && i.version !== String(q.build)) return false;
      return true;
    });
    return reply.send({
      summary: getDiagnosticsSummary(),
      possibleIncidents: incidents.filter((i) => i.possibleIncident).length,
      incidents: filtered.slice(0, Math.min(Number(q.limit) || 100, 400)),
    });
  });

  /** GET /nova/api/incidents/:id — one incident in full, with its related problems. Admin only. */
  fastify.get('/nova/api/incidents/:id', async (request, reply) => {
    if (!adminOk(request)) return adminRefused(reply);
    const { id } = request.params as { id: string };
    const all = buildIncidents(getDiagnostics({ limit: 400 }));
    const found = all.find((i) => i.id === id);
    if (!found) return reply.status(404).send({ error: 'unknown incident', id });
    return reply.send({
      incident: found,
      related: all.filter((i) => found.related.includes(i.id)),
    });
  });

  /**
   * GET /nova/api/dashboard — the operator view. Admin only.
   *
   * Server-rendered on purpose. It is read from a phone, over a Funnel link, while something is on
   * fire; a build step or a CDN dependency between the operator and the incident list is a liability,
   * not a feature.
   */
  fastify.get('/nova/api/dashboard', async (request, reply) => {
    if (!adminOk(request)) {
      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.status(403).send(renderDashboard(null));
    }
    const incidents = buildIncidents(getDiagnostics({ limit: 400 }));
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.send(renderDashboard({ summary: getDiagnosticsSummary(), incidents }));
  });
}

export { incidentId };
