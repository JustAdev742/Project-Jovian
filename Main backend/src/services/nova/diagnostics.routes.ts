import { FastifyInstance } from 'fastify';
import { requireAuth } from '../../middleware/auth.middleware';
import { Config } from '../../config';
import {
  recordDiagnostic, getDiagnostics, getDiagnosticsSummary,
  subscribeDiagnostics, diagnosticSubscriberCount, diagnosticsSince,
  diagnosticPersistenceStatus,
} from './diagnostics';
import { parseBatch, LIMITS } from './diagnostics.schema';
import { buildIncidents, incidentId } from './incidents';
import { renderDashboard } from './dashboard';
import { identifyVersion } from '../../version/identify';

/**
 * Collapse a reported build string to the short id the backend uses for its own requests.
 *
 * WHY THIS IS NOT COSMETIC. `version` is part of the aggregation key. Cobalt, Reboot and the UE4 log
 * reader all report the full build header — `++Fortnite+Release-7.40-CL-5046157` — while the backend
 * records its own failures as `7.40`. Without this, the same build produces two rows for the same
 * problem depending on which component noticed it, and the version-aware view the cross-version work
 * exists to support quietly stops working.
 *
 * `identifyVersion` is the parser that already does this for User-Agent headers; a build header has
 * the same shape, so it is reused rather than re-implemented. A build string it cannot parse comes
 * back as `unknown`, which is the honest answer and the same one an unparseable UA gets.
 */
function shortBuild(build: string | undefined): string | undefined {
  if (!build) return undefined;
  const id = identifyVersion({ 'user-agent': build }, Config.SEASON_NUMBER).id;
  return id === 'unknown' ? build.slice(0, 40) : id;
}

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
  forwardQueue.length = 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
//  THE FORWARD QUEUE
//
//  Events from Cobalt and Reboot land on the LOCAL agent, which has no player identity and no route
//  to the coordinator's authenticated endpoint. The launcher does have both, so it drains this queue
//  and posts upstream under its own token. That split is what keeps credentials out of the in-game
//  components entirely.
//
//  Bounded and lossy by design: if the launcher is not running, or the coordinator is unreachable
//  for an hour, the queue must not grow. The OLDEST events are dropped, because in an ongoing
//  failure the newest are the ones that describe what is happening now. The drop count is forwarded
//  as its own event so the gap is visible rather than silent.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const MAX_FORWARD_QUEUE = 500;
const forwardQueue: unknown[] = [];
let forwardDropped = 0;

function enqueueForForwarding(ev: unknown): void {
  forwardQueue.push(ev);
  while (forwardQueue.length > MAX_FORWARD_QUEUE) {
    forwardQueue.shift();
    forwardDropped++;
  }
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
        version: shortBuild(ev.build),
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
        version: shortBuild(ev.build),
        status: ev.status,
        detail: ev.detail,
        // No accountId: this endpoint has no authenticated identity and must not invent one.
      });
      enqueueForForwarding(ev);
    }
    return reply.send({ accepted: events.length });
  });

  /**
   * GET /nova/api/diagnostics/pending — drain the forward queue.
   *
   * The launcher calls this on the LOCAL agent and posts what it gets to the coordinator under its
   * own token. Draining is destructive on purpose: this is a hand-off, not a view, and leaving
   * events behind would either duplicate them upstream or grow without bound.
   *
   * Unauthenticated for the same reason as the local ingest — localhost only, kept local by
   * nova-proxy's LOCAL_PREFIXES. It returns no account id because it never had one.
   */
  fastify.get('/nova/api/diagnostics/pending', async (_request, reply) => {
    const events = forwardQueue.splice(0, forwardQueue.length);
    const dropped = forwardDropped;
    forwardDropped = 0;
    if (dropped > 0) {
      // Report our own loss in the same channel, so "we stopped queueing" is visible.
      events.push({
        source: 'CLIENT', category: 'UNEXPECTED_STATE', method: 'DIAG',
        url: '/diagnostics/forward-overflow', component: 'launcher', count: dropped,
        detail: 'local forward queue overflowed; oldest events dropped',
      });
    }
    return reply.send({ events });
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
      persistence: diagnosticPersistenceStatus(),
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
    return reply.send(renderDashboard({
      summary: getDiagnosticsSummary(),
      incidents,
      // Shown in both directions on purpose: an operator reading this page during an incident
      // needs to know whether what they are looking at will still exist after a restart.
      persistence: diagnosticPersistenceStatus(),
    }));
  });

  /**
   * GET /nova/api/diagnostics/since?seq=N — the SSE fallback, for transports that buffer.
   *
   * NOT a "refresh the page every few seconds" loop, which the brief rules out and rightly so. It
   * serves the SAME event objects the SSE stream emits, addressed by sequence number, so a client
   * gets exactly the events it has not seen and can tell when it has fallen behind. The event model
   * is identical; only the carrier differs.
   *
   * IT EXISTS BECAUSE SSE IS MEASURABLY BLOCKED ON THE ROUTE THAT MATTERS. Direct from the backend
   * and through the path-allowlist proxy, the stream delivers correctly — 445 bytes of `hello` plus
   * live `diagnostic` frames. Through Cloudflare's free `trycloudflare` tunnel it delivers ZERO
   * bytes, because that edge buffers the body. The public dashboard link goes through exactly that
   * tunnel, so without this the live tail is dead precisely where it is read from.
   *
   * `missed` tells a client that has been away longer than the 200-event ring how much it lost,
   * rather than handing it a window and letting it assume continuity.
   */
  fastify.get('/nova/api/diagnostics/since', async (request, reply) => {
    if (!adminOk(request)) return adminRefused(reply);
    const raw = Number((request.query as any)?.seq);
    const seq = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
    const { events, head, missed } = diagnosticsSince(seq);
    // no-store: an intermediary caching this would make the fallback stale in the same way the
    // tunnel made the stream silent, and for the same invisible reasons.
    reply.header('cache-control', 'no-store');
    return reply.send({ events, head, missed, subscribers: diagnosticSubscriberCount() });
  });

  /**
   * GET /nova/api/diagnostics/stream — Server-Sent Events, one message per diagnostic as it lands.
   *
   * ── WHY SSE AND NOT A WEBSOCKET, AND NOT POLLING ─────────────────────────────────────────────
   *
   * The traffic is one-directional: the server has news, the page listens. SSE is that exactly, it
   * is plain HTTP so it survives the Cloudflare tunnel and any proxy in between without an upgrade
   * negotiation, and browsers reconnect it automatically. A WebSocket would add a bidirectional
   * channel nothing needs, and this backend's WS path is already shared with XMPP and matchmaking —
   * see `ws-root-path-fabricates-matchmaking` in KNOWN_ISSUES for what happens when something
   * unexpected connects there. Staying off that path entirely is the safer design.
   *
   * Polling was rejected on the brief's own terms: it cannot show WHEN something happened, only that
   * a number changed between two samples, and the interesting case — a burst between polls — is
   * exactly the one it loses.
   *
   * ── BOUNDED, AND IT SAYS SO WHEN IT IS FULL ──────────────────────────────────────────────────
   *
   * `subscribeDiagnostics` returns null at capacity rather than accepting a connection that would
   * receive nothing. A 503 is visible; a silent dead stream is the failure mode this whole subsystem
   * exists to eliminate.
   *
   * The heartbeat is not decoration: an idle SSE connection through a proxy is indistinguishable
   * from a dead one, and both Cloudflare and most reverse proxies will close it. A comment frame
   * every 20s keeps it open and lets the page tell "quiet" from "broken".
   */
  fastify.get('/nova/api/diagnostics/stream', async (request, reply) => {
    if (!adminOk(request)) return adminRefused(reply);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Cloudflare and nginx both buffer by default, which turns a live stream into a stalled one.
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // The socket went away between the check and the write. Nothing to do and nothing to log —
        // cleanup below handles it, and a disconnect is not a diagnostic.
      }
    };

    const unsubscribe = subscribeDiagnostics((e) => send('diagnostic', e));
    if (!unsubscribe) {
      send('error', { error: 'too many live subscribers', limit: true });
      reply.raw.end();
      return;
    }

    // Tell the new subscriber where things stand, so a page that connects mid-incident is not blank
    // until the next failure happens.
    send('hello', {
      summary: getDiagnosticsSummary(),
      persistence: diagnosticPersistenceStatus(),
      subscribers: diagnosticSubscriberCount(),
      serverTime: new Date().toISOString(),
    });

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': keepalive\n\n');
      } catch {
        /* same as above — the cleanup path owns this */
      }
    }, 20_000);
    heartbeat.unref?.();

    // ONE cleanup path, registered for every way this can end. Leaking a listener per dropped
    // connection would silently consume the subscriber budget until the stream stopped accepting
    // anyone, and the symptom — "live updates stopped working" — would point nowhere near the cause.
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    reply.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
  });
}

export { incidentId };
