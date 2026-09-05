/**
 * Distributed diagnostics — ingest, incidents, dashboard.
 *
 * The thing under test is a surface that accepts data from player machines and renders it to an
 * operator. So most of what is asserted here is what happens when a client is WRONG or HOSTILE:
 * a category that does not exist, a count of a billion, a batch of ten thousand, a URL containing
 * a script tag, an attempt to attribute events to another account. None of those may reach the
 * store, the ranking, or the page intact.
 *
 * Run: npm test
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-distdiag-${process.pid}.db`);
// The read side is admin-gated and fails closed. Set a secret so the dashboard can be tested at all;
// a separate test asserts the closed behaviour by clearing it.
process.env.NOVA_AC_ADMIN_SECRET = 'test-admin-secret';

let schema: any, store: any, incidents: any, dashboard: any, routes: any, resetRateLimits: any;
let app: FastifyInstance;
let token = '';

before(async () => {
  schema = await import('./diagnostics.schema');
  store = await import('./diagnostics');
  incidents = await import('./incidents');
  dashboard = await import('./dashboard');
  const mod = (await import('./diagnostics.routes')) as any;
  routes = mod.diagnosticsRoutes;
  resetRateLimits = mod.resetRateLimits;
  const dbm = await import('../../database');
  const { authRoutes } = (await import('../auth/auth.routes')) as any;

  await dbm.initDatabase();
  app = Fastify({ logger: false });
  await app.register(formbody);
  await app.register(authRoutes);
  await app.register(routes);
  await app.ready();

  const res = await app.inject({
    method: 'POST', url: '/account/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=password&username=diaguser&password=x',
  });
  token = res.json().access_token;
  assert.ok(token, 'need a token to exercise the authenticated ingest path');
});

beforeEach(() => {
  store.clearDiagnostics();
  incidents.clearIncidents();
  resetRateLimits();
});

describe('schema — client input is hostile until proven otherwise', () => {
  test('an unknown category becomes UNKNOWN rather than being trusted', () => {
    // A client inventing its own category could otherwise pick one with a high weight and inflate
    // its own rows to the top of the ranking.
    assert.equal(schema.normaliseCategory('DEFINITELY_CRITICAL_TRUST_ME'), 'UNKNOWN');
    assert.equal(schema.normaliseCategory(null), 'UNKNOWN');
    assert.equal(schema.normaliseCategory(42), 'UNKNOWN');
  });

  test('the brief vocabulary is accepted and folded onto canonical names', () => {
    assert.equal(schema.normaliseCategory('MISSING_CALL'), 'MISSING');
    assert.equal(schema.normaliseCategory('UNROUTED_PATH'), 'MISSING');
    assert.equal(schema.normaliseCategory('FAILED_CALL'), 'FAILED');
    assert.equal(schema.normaliseCategory('OTHER'), 'UNKNOWN');
    assert.equal(schema.normaliseCategory('matchmaking_failure'), 'MATCHMAKING_FAILURE');
  });

  test('an unknown source defaults to CLIENT, never to BACKEND', () => {
    // Defaulting to BACKEND would let a client's own failure be attributed to the server, which is
    // exactly the confusion the source field exists to prevent.
    assert.equal(schema.normaliseSource('nonsense'), 'CLIENT');
    assert.equal(schema.normaliseSource(undefined), 'CLIENT');
    assert.equal(schema.normaliseSource('HOST'), 'HOST');
  });

  test('counts are clamped so a client cannot inflate a ranking', () => {
    assert.equal(schema.parseEvent({ url: '/x', count: 1e9 })!.count, schema.LIMITS.MAX_CLAIMED_COUNT);
    assert.equal(schema.parseEvent({ url: '/x', count: -5 })!.count, 1);
    assert.equal(schema.parseEvent({ url: '/x', count: 'lots' })!.count, 1);
  });

  test('strings are truncated and an event with no subject is dropped', () => {
    const ev = schema.parseEvent({ url: 'x'.repeat(5000), detail: 'y'.repeat(5000) })!;
    assert.equal(ev.url.length, schema.LIMITS.MAX_URL);
    assert.equal(ev.detail!.length, schema.LIMITS.MAX_DETAIL);
    assert.equal(schema.parseEvent({ url: '' }), null);
    assert.equal(schema.parseEvent(null), null);
  });

  test('a batch is capped, and one bad entry does not discard the good ones', () => {
    const raw = [{ url: '/a' }, null, { nope: true }, { url: '/b' }];
    const parsed = schema.parseBatch(raw);
    assert.equal(parsed.length, 2, 'the two usable events must survive');
    assert.equal(schema.parseBatch(new Array(500).fill({ url: '/x' })).length, schema.LIMITS.MAX_BATCH);
    assert.deepEqual(schema.parseBatch('not an array'), []);
  });

  test('an out-of-range status is dropped rather than stored', () => {
    assert.equal(schema.parseEvent({ url: '/x', status: 99 })!.status, undefined);
    assert.equal(schema.parseEvent({ url: '/x', status: 9999 })!.status, undefined);
    assert.equal(schema.parseEvent({ url: '/x', status: 503 })!.status, 503);
  });
});

describe('ingest', () => {
  const post = (payload: any, auth = true) =>
    app.inject({
      method: 'POST', url: '/nova/api/diagnostics/ingest',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `bearer ${token}` } : {}) },
      payload,
    });

  test('requires authentication', async () => {
    assert.equal((await post({ events: [{ url: '/x' }] }, false)).statusCode, 401);
  });

  test('accepts a well-formed batch and records it', async () => {
    const res = await post({
      events: [
        { source: 'CLIENT', category: 'NETWORK_FAILURE', method: 'GET', url: '/fortnite/api/calendar/v1/timeline',
          component: 'cobalt', build: 'Release-7.40', count: 3, correlationId: 'trace-abc' },
      ],
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, 1);

    const rows = store.getDiagnostics({ limit: 50 });
    const row = rows.find((r: any) => r.category === 'NETWORK_FAILURE');
    assert.ok(row, 'the event must reach the store');
    assert.equal(row.source, 'CLIENT');
    assert.equal(row.component, 'cobalt');
    assert.equal(row.count, 3, 'the client-side aggregate count must be honoured');
    assert.ok(row.correlationIds.includes('trace-abc'), 'the trace id must survive for correlation');
  });

  test('a client cannot attribute events to another account', async () => {
    // The reporting account comes from the TOKEN, never the body. Otherwise a player could make
    // another player look like the source of an incident.
    await post({ events: [{ url: '/x', accountId: 'someone-else', category: 'CRASH' }] });
    const row = store.getDiagnostics({ limit: 50 }).find((r: any) => r.category === 'CRASH');
    assert.ok(row);
    assert.equal(row.affectedUsers, 1, 'exactly one distinct reporter — the token holder');
  });

  test('rate limiting returns 429 with Retry-After rather than dropping silently', async () => {
    // A client that is told to back off can. One that is silently ignored spins forever.
    let limited: any = null;
    for (let i = 0; i < 40; i++) {
      const r = await post({ events: new Array(50).fill({ url: '/spam', category: 'UNKNOWN' }) });
      if (r.statusCode === 429) { limited = r; break; }
    }
    assert.ok(limited, 'the bucket must run out');
    assert.equal(limited.headers['retry-after'], '30');
    assert.equal(limited.json().accepted, 0);
    assert.ok(limited.json().limit.maxBatch, 'the client is told what the ceiling is');
  });

  test('a malformed batch is reported, not fatal', async () => {
    const res = await post({ events: [{ nope: 1 }, { url: '/ok' }] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, 1);
    assert.equal(res.json().dropped, 1);
  });
});

describe('incidents — is it getting worse, and whose problem is it', () => {
  test("the brief's worked example is detected as a spike", () => {
    // 5 → 8 → 11 → 74 → 631. A total alone cannot distinguish this from the same volume spread
    // across a week, which is the entire reason the time series exists.
    const key = 'CLIENT|MATCHMAKING_FAILURE|POST|/mm|7.40';
    const t0 = Date.now() - 5 * incidents.BUCKET_MS;
    for (const [i, n] of [5, 8, 11, 74, 631].entries()) {
      for (let j = 0; j < n; j++) incidents.noteOccurrence(key, 1, t0 + i * incidents.BUCKET_MS);
    }
    const trend = incidents.trendOf(key, t0 + 4 * incidents.BUCKET_MS);
    assert.equal(trend.current, 631);
    assert.ok(trend.spiking, 'this is the canonical incident shape and must be flagged');
    assert.ok(trend.growthPct! > 1000, `expected a large growth figure, got ${trend.growthPct}`);
  });

  test('a steady high-volume problem is NOT a spike', () => {
    // Without the multiple term, anything busy looks like a permanent emergency.
    const key = 'BACKEND|MISSING|POST|/datarouter|7.40';
    const t0 = Date.now() - 6 * incidents.BUCKET_MS;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 200; j++) incidents.noteOccurrence(key, 1, t0 + i * incidents.BUCKET_MS);
    }
    assert.equal(incidents.trendOf(key, t0 + 5 * incidents.BUCKET_MS).spiking, false);
  });

  test('two occurrences of something new is not an incident', () => {
    // Without the absolute floor, 0 → 2 is an infinite-percentage spike and the board fills with noise.
    const key = 'CLIENT|UNKNOWN|GET|/rare|7.40';
    incidents.noteOccurrence(key, 2);
    assert.equal(incidents.trendOf(key).spiking, false);
  });

  test('scope: one machine is not an outage', () => {
    const versions = new Set(['7.40']);
    assert.equal(
      incidents.classifyScope({ source: 'CLIENT', category: 'NETWORK_FAILURE', affectedUsers: 1, version: '7.40' }, versions),
      'ISOLATED_CLIENT',
    );
    assert.equal(
      incidents.classifyScope({ source: 'CLIENT', category: 'NETWORK_FAILURE', affectedUsers: 3, version: '7.40' }, versions),
      'SMALL_CLUSTER',
    );
  });

  test('scope: VERSION_SPECIFIC only when more than one build is in play', () => {
    // On a single-build deployment EVERYTHING is concentrated in one build. Calling that a
    // version-specific regression would be a permanent false positive.
    const single = new Set(['7.40']);
    const multi = new Set(['7.40', '8.51']);
    assert.notEqual(
      incidents.classifyScope({ source: 'CLIENT', category: 'FAILED', affectedUsers: 6, version: '7.40' }, single),
      'VERSION_SPECIFIC',
    );
    assert.equal(
      incidents.classifyScope({ source: 'CLIENT', category: 'FAILED', affectedUsers: 6, version: '7.40' }, multi),
      'VERSION_SPECIFIC',
    );
  });

  test('scope: a host problem is never confused with a player problem', () => {
    assert.equal(
      incidents.classifyScope({ source: 'HOST', category: 'CRASH', affectedUsers: 1, version: '7.40' }, new Set(['7.40'])),
      'HOST_ISSUE',
    );
  });

  test('a backend 500 hitting many people reads as an outage', () => {
    assert.equal(
      incidents.classifyScope({ source: 'BACKEND', category: 'INTERNAL_ERROR', affectedUsers: 12, version: '7.40' }, new Set(['7.40'])),
      'BACKEND_OUTAGE',
    );
  });

  test('spiking problems rank above a higher-scoring quiet one', () => {
    store.recordDiagnostic({ category: 'MATCHMAKING_FAILURE', source: 'CLIENT', method: 'POST', url: '/mm/ticket', accountId: 'a' });
    for (let i = 0; i < 30; i++) {
      store.recordDiagnostic({ category: 'MATCHMAKING_FAILURE', source: 'CLIENT', method: 'POST', url: '/mm/ticket', accountId: `u${i}` });
    }
    const list = incidents.buildIncidents(store.getDiagnostics({ limit: 100 }));
    assert.ok(list.length > 0);
    assert.ok(list[0].id.length > 0, 'incidents carry a stable quotable id');
    assert.match(list[0].id, /^[A-Z]{1,4}-[0-9A-Z]{4}$/);
  });

  test('an id is stable for the same problem and different for a different one', () => {
    const a = { source: 'CLIENT', category: 'MISSING', method: 'GET', route: '/x', version: '7.40', subsystem: 'mcp' } as any;
    const b = { ...a, route: '/y' };
    assert.equal(incidents.incidentId(a), incidentIdAgain(a));
    assert.notEqual(incidents.incidentId(a), incidents.incidentId(b));
    function incidentIdAgain(x: any) { return incidents.incidentId(x); }
  });
});

describe('severity calibration — breadth is part of CRITICAL, not a tuning knob', () => {
  test('one player retrying forever is HIGH, never CRITICAL', () => {
    // Found on the real dashboard: a single player retrying matchmaking 480 times scored 103 and
    // rendered CRITICAL directly above the caption "one machine — probably local to that player".
    // Both statements were true and together they were absurd. The brief defines CRITICAL as
    // "cannot connect / cannot play / WIDESPREAD failure".
    for (let i = 0; i < 500; i++) {
      store.recordDiagnostic({
        category: 'MATCHMAKING_FAILURE', source: 'CLIENT', method: 'POST',
        url: '/fortnite/api/game/v2/matchmakingservice/ticket/player/x', accountId: 'the-only-player',
      });
    }
    const row = store.getDiagnostics({ limit: 10 })[0];
    assert.equal(row.affectedUsers, 1);
    assert.ok(row.score >= 100, `the SCORE should still be loud, got ${row.score}`);
    assert.equal(row.severity, 'HIGH', 'volume alone must not reach CRITICAL');
  });

  test('the same volume across many players IS critical', () => {
    // The positive control. Without it the cap above could be passing for the wrong reason.
    for (let i = 0; i < 500; i++) {
      store.recordDiagnostic({
        category: 'MATCHMAKING_FAILURE', source: 'CLIENT', method: 'POST',
        url: '/fortnite/api/game/v2/matchmakingservice/ticket/player/x', accountId: `player-${i % 30}`,
      });
    }
    assert.equal(store.getDiagnostics({ limit: 10 })[0].severity, 'CRITICAL');
  });
});

describe('two bugs the unit tests missed and the live dashboard showed', () => {
  test("'unknown' is not a build, so a single-build deployment is never VERSION_SPECIFIC", () => {
    // The original test handed classifyScope a clean {'7.40'} and passed. In reality the set also
    // contains 'unknown' — every request without a parseable User-Agent, including the browser
    // opening the dashboard — so size > 1 was true on a single-build deployment and EVERYTHING was
    // classified as a version-specific regression.
    const realistic = new Set(['7.40', 'unknown']);
    assert.equal(
      incidents.classifyScope({ source: 'CLIENT', category: 'FAILED', affectedUsers: 9, version: '7.40' }, realistic),
      'WIDESPREAD',
      'unknown must not count as a second build',
    );
    // Still fires when there really are two builds.
    assert.equal(
      incidents.classifyScope({ source: 'CLIENT', category: 'FAILED', affectedUsers: 9, version: '7.40' },
        new Set(['7.40', '8.51', 'unknown'])),
      'VERSION_SPECIFIC',
    );
  });

  test('the version dimension is a short build id, not a User-Agent', () => {
    // version is part of the aggregation key. Feeding it the raw User-Agent made every browser that
    // opened the dashboard its own "build", keyed rows on 200-character strings, and was what
    // produced the false VERSION_SPECIFIC above.
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36';
    store.recordDiagnostic({ category: 'MISSING', method: 'GET', url: '/x', version: '7.40', accountId: 'a' });
    const row = store.getDiagnostics({ limit: 20 })[0];
    assert.equal(row.version, '7.40');
    assert.ok(row.version.length < 20, 'a build id should be short enough to key and display');
    assert.ok(!row.version.includes('Mozilla'), 'a User-Agent must never become a build id');
    void ua;
  });
});

describe('dashboard', () => {
  test('a hostile route cannot inject script into the page', () => {
    // THE ONE THAT MATTERS. Routes are reported by player machines. Rendering one unescaped would
    // turn the operator's own dashboard into the attack.
    store.recordDiagnostic({
      category: 'MISSING', source: 'CLIENT', method: 'GET',
      url: '/evil</script><script>alert(1)</script>',
      detail: '<img src=x onerror=alert(2)>',
      accountId: 'attacker',
    });
    const html = dashboard.renderDashboard({
      summary: store.getDiagnosticsSummary(),
      incidents: incidents.buildIncidents(store.getDiagnostics({ limit: 50 })),
    });
    assert.ok(!html.includes('<script>alert(1)'), 'script tag survived escaping');
    assert.ok(!html.includes('onerror=alert(2)'), 'event handler survived escaping');
    assert.ok(html.includes('&lt;script&gt;'), 'the payload should render as visible text');
  });

  test('severity is conveyed by text and shape, not colour alone', () => {
    // A red bar with no text fails in greyscale and for colour-vision deficiency — and greyscale is
    // exactly how this gets pasted into a chat.
    store.recordDiagnostic({ category: 'INTERNAL_ERROR', source: 'BACKEND', method: 'GET', url: '/boom', status: 500, accountId: 'x' });
    const html = dashboard.renderDashboard({
      summary: store.getDiagnosticsSummary(),
      incidents: incidents.buildIncidents(store.getDiagnostics({ limit: 50 })),
    });
    assert.match(html, /class="sev"[^>]*>[^<]*(CRITICAL|HIGH|MEDIUM|LOW|INFORMATIONAL)/,
      'the severity WORD must be in the markup');
  });

  test('the locked page explains how to enable it instead of 404ing', () => {
    const html = dashboard.renderDashboard(null);
    assert.match(html, /NOVA_AC_ADMIN_SECRET/);
    assert.ok(!html.includes('<ol class="incidents"'), 'no data may render on the locked page');
  });

  test('an empty board says so rather than looking broken', () => {
    const html = dashboard.renderDashboard({ summary: store.getDiagnosticsSummary(), incidents: [] });
    assert.match(html, /correct and boring state/);
  });

  test('the page is self-contained — no external requests at all', () => {
    const html = dashboard.renderDashboard({ summary: store.getDiagnosticsSummary(), incidents: [] });
    // A font, a CDN or an analytics beacon is one more thing between an operator and an outage.
    assert.ok(!/<link[^>]+href="http/i.test(html), 'no external stylesheet');
    assert.ok(!/src="https?:/i.test(html), 'no external script or image');
    assert.ok(!/@import/i.test(html), 'no CSS import');
    assert.match(html, /viewport/, 'must be usable on a phone');
    assert.match(html, /prefers-reduced-motion/, 'motion preference must be honoured');
  });
});

describe('the read side is closed by default', () => {
  test('without the admin secret, incidents and the dashboard are refused', async () => {
    const saved = process.env.NOVA_AC_ADMIN_SECRET;
    try {
      // Rebuild an app with no secret configured, the way a fresh coordinator starts.
      delete process.env.NOVA_AC_ADMIN_SECRET;
      const { Config } = await import('../../config');
      const savedCfg = Config.AC_ADMIN_SECRET;
      const savedReg = Config.REGISTER_SECRET;
      (Config as any).AC_ADMIN_SECRET = '';
      (Config as any).REGISTER_SECRET = '';

      const closed = Fastify({ logger: false });
      await closed.register(routes);
      await closed.ready();

      assert.equal((await closed.inject({ method: 'GET', url: '/nova/api/incidents' })).statusCode, 403);
      const dash = await closed.inject({ method: 'GET', url: '/nova/api/dashboard' });
      assert.equal(dash.statusCode, 403);
      assert.match(dash.payload, /not enabled/);
      await closed.close();

      (Config as any).AC_ADMIN_SECRET = savedCfg;
      (Config as any).REGISTER_SECRET = savedReg;
    } finally {
      process.env.NOVA_AC_ADMIN_SECRET = saved;
    }
  });

  test('with the secret, the incident list is served', async () => {
    store.recordDiagnostic({ category: 'AUTH_FAILURE', source: 'BACKEND', method: 'POST', url: '/account/api/oauth/token', status: 401, accountId: 'z' });
    const res = await app.inject({
      method: 'GET', url: '/nova/api/incidents',
      headers: { 'x-nova-admin': 'test-admin-secret' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().incidents.length > 0);
    assert.ok(res.json().summary);
  });
});
