/**
 * Fleet doctor: the trust boundary, end to end.
 *
 * Players' machines send data the coordinator stores and renders into an admin page, so the tests
 * that matter are the hostile ones: local-only routes must not exist on the coordinator, ingest
 * needs a real token, markup in a report must come back escaped and sandboxed, a decompression bomb
 * must be refused, and one client must not be able to flood the store.
 *
 * Run: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';

const tmp = path.join(os.tmpdir(), `nova-doctor-test-${process.pid}-${Date.now()}`);
process.env.NOVA_DB_PATH = `${tmp}-main.db`;
process.env.NOVA_DOCTOR_DB = `${tmp}-doctor.db`;
process.env.NOVA_AC_ADMIN_SECRET = 'admin-secret-for-doctor-tests';
delete process.env.NOVA_COORDINATOR;

let app: FastifyInstance;
let token = '';
let accountId = '';
let Config: any;
const admin = { 'x-nova-admin': 'admin-secret-for-doctor-tests' };

const gz64 = (o: unknown) => zlib.gzipSync(Buffer.from(JSON.stringify(o))).toString('base64');
const report = (title: string) => ({
  version: '1.0.0', startedAt: '2026-11-08T00:00:00Z', finishedAt: '2026-11-08T00:00:02Z', machine: 'TEST-PC',
  options: { profile: 'player' }, summary: { total: 1, open: 1, bySeverity: { P0: 1 } },
  causes: [{ id: 'c1', title, severity: 'P0', confidence: 'CONFIRMED', narrative: 'n', next: 'x', findings: ['k1'] }],
  coverage: [{ module: 'logs', area: 'UE4 logs', status: 'checked', detail: 'ok' }],
  findings: [{ key: 'k1', id: 'log.x', title, severity: 'P0', confidence: 'CONFIRMED', status: 'open', component: 'game', count: 2, evidence: [{ source: 'a.log', line: 1, excerpt: 'x eg1~eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIwMyJ9.sig y' }] }],
  baseline: { compared: false },
});
const summary = (title: string) => ({ version: '1.0.0', machine: 'TEST-PC', verdict: { lead: title, rest: '' }, summary: { total: 1, open: 1, bySeverity: { P0: 1 } }, causes: [], top: [{ key: 'k1', id: 'log.x', title, severity: 'P0', confidence: 'CONFIRMED', status: 'open', component: 'game', count: 2 }] });

before(async () => {
  Config = (await import('../../config')).Config;
  const { initDatabase } = (await import('../../database')) as any;
  const { authRoutes } = (await import('../auth/auth.routes')) as any;
  const { doctorRoutes } = (await import('./doctor.routes')) as any;
  await initDatabase();
  app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  await app.register(formbody);
  await app.register(authRoutes);
  await app.register(doctorRoutes);
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/account/api/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=password&username=doctorplayer&password=x' });
  token = res.json().access_token;
  accountId = res.json().account_id;
  assert.ok(token && /^[0-9a-f]{32}$/.test(accountId), 'test setup needs a real token');
});

const ingest = (body: unknown, auth = true) => app.inject({
  method: 'POST', url: '/nova/api/doctor/ingest',
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: `bearer ${token}` } : {}) }, payload: body as any,
});

describe('on the coordinator, the local-only routes do not exist', () => {
  for (const [method, url] of [['POST', '/nova/api/doctor/local'], ['POST', '/nova/api/doctor/local-report'], ['GET', '/nova/api/doctor/pending']] as const) {
    test(`${method} ${url} → 404`, async () => {
      const res = await app.inject({ method, url, headers: { 'content-type': 'application/json' }, payload: method === 'POST' ? { lines: [] } : undefined });
      assert.equal(res.statusCode, 404);
    });
  }
});

describe('ingest', () => {
  test('refuses a caller with no token', async () => {
    assert.equal((await ingest({ lines: [{ text: 'x' }] }, false)).statusCode, 401);
  });

  test('stores live lines under the token\'s account, normalised', async () => {
    const res = await ingest({ launcher: '1.9.4', lines: [{ src: 'client', sev: 'P0', rule: 'quickbar-guid-unmapped', text: 'AFortQuickBars::AddItemInternal could not find Item' }, { src: 'evil', sev: 'P9', text: 'bad enums are coerced' }, { text: '' }] });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().accepted, 2, 'the empty line is dropped');
    const lines = (await app.inject({ method: 'GET', url: `/nova/api/doctor/lines.json?account=${accountId}`, headers: admin })).json().lines;
    assert.equal(lines.length, 2);
    assert.equal(lines[1].src, 'client', 'an unknown source is coerced to a known one');
    assert.equal(lines[1].sev, 'P3', 'an unknown severity is coerced');
  });

  test('stores a report; a token in the evidence is redacted again on the server', async () => {
    const res = await ingest({ launcher: '1.9.4', report: { summary: summary('Stuck loading screen'), full: gz64(report('Stuck loading screen')) } });
    assert.equal(res.json().report, true);
    const html = (await app.inject({ method: 'GET', url: `/nova/api/doctor/players/${accountId}/report.html`, headers: admin })).body;
    assert.ok(!html.includes('eyJzdWIi'), 'a token reached the admin page');
  });

  test('markup in a report comes back escaped, and the page is sandboxed', async () => {
    await ingest({ launcher: '1.9.4', report: { summary: summary('<script>alert(1)</script>'), full: gz64(report('<img src=x onerror=alert(1)>')) } });
    const res = await app.inject({ method: 'GET', url: `/nova/api/doctor/players/${accountId}/report.html`, headers: admin });
    assert.ok(!res.body.includes('<img src=x'), 'player markup was rendered as markup');
    assert.ok(res.body.includes('&lt;img src=x'), 'the text should still be visible, escaped');
    assert.match(String(res.headers['content-security-policy']), /sandbox allow-scripts/);
    const playerPage = (await app.inject({ method: 'GET', url: `/nova/api/doctor/players/${accountId}`, headers: admin })).body;
    assert.ok(!playerPage.includes('<script>alert(1)</script>'));
  });

  test('a decompression bomb is refused, not expanded', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024, 32)).toString('base64');   // 50 MB of spaces, ~50 KB gzipped
    const res = await ingest({ report: { summary: summary('bomb'), full: bomb } });
    assert.equal(res.statusCode, 200, 'the summary is still accepted');
    const { latestReport } = await import('./doctor.store');
    assert.equal(latestReport(accountId)?.full, null, 'the bomb must not be stored');
  });

  test('one client cannot flood the store (429 with retry-after)', async () => {
    let limited = null as any;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await ingest({ lines: [{ text: `line ${i}` }] });
      if (r.statusCode === 429) limited = r;
    }
    assert.ok(limited, 'never rate-limited');
    assert.equal(limited.headers['retry-after'], '30');
  });
});

describe('admin views', () => {
  test('the dashboard is locked without the admin secret, and offers sign-in back to itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/nova/api/doctor/dashboard' });
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /name="next" value="\/nova\/api\/doctor\/dashboard"/);
  });

  test('the JSON feeds refuse without the secret', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/nova/api/doctor/fleet.json' })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/nova/api/doctor/lines.json' })).statusCode, 403);
  });

  test('with the secret: the fleet page lists the player and their problem', async () => {
    const res = await app.inject({ method: 'GET', url: '/nova/api/doctor/dashboard', headers: admin });
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /doctorplayer/);
    const fleet = (await app.inject({ method: 'GET', url: '/nova/api/doctor/fleet.json', headers: admin })).json();
    assert.equal(fleet.players.length, 1);
    assert.equal(fleet.players[0].launcher_version, '1.9.4');
    assert.ok(fleet.problems.length >= 1);
  });

  test('each fleet problem names the players who have it, linked to their page', async () => {
    const fleet = (await app.inject({ method: 'GET', url: '/nova/api/doctor/fleet.json', headers: admin })).json();
    assert.deepEqual(fleet.problems[0].who, [{ id: accountId, name: 'doctorplayer' }]);
    const page = (await app.inject({ method: 'GET', url: '/nova/api/doctor/dashboard', headers: admin })).body;
    assert.match(page, new RegExp(`class="who-has"><a href="/nova/api/doctor/players/${accountId}"`));
  });

  test('server-rendered live rows carry the attributes the filters read', async () => {
    const page = (await app.inject({ method: 'GET', url: '/nova/api/doctor/dashboard', headers: admin })).body;
    const rows = page.match(/<li data-id="\d+"[^>]*>/g) || [];
    assert.ok(rows.length > 0, 'the page has live rows');
    for (const r of rows) assert.match(r, new RegExp(`data-sev="(P0|P1|P2|P3|INFO)" data-acct="${accountId}"`));
  });

  test('a value placed in the polling script cannot close the script tag', async () => {
    const { renderPlayerPage } = await import('./doctor.dashboard');
    const hostile = 'abc</script><img src=x onerror=alert(1)>';
    const html = renderPlayerPage({ player: { account_id: hostile, display_name: 'p', launcher_version: null, machine: null, last_report_at: null, last_line_at: null, last_seen: null, p0: 0, p1: 0, open_total: 0 } as any, report: null, lines: [] });
    assert.equal((html.match(/<\/script>/g) || []).length, 1, 'only the real closing tag');
  });

  test('lines.json?since returns only newer lines, oldest first', async () => {
    const all = (await app.inject({ method: 'GET', url: '/nova/api/doctor/lines.json', headers: admin })).json().lines;
    const last = all[all.length - 1].id;
    const none = (await app.inject({ method: 'GET', url: `/nova/api/doctor/lines.json?since=${last}`, headers: admin })).json().lines;
    assert.equal(none.length, 0);
  });
});

describe('on a host agent, the hand-off works and ingest does not', () => {
  test('lines and a report are queued, then drained exactly once', async () => {
    Config.COORDINATOR_URL = 'https://coordinator.example';
    try {
      const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: payload as any });
      assert.equal((await post('/nova/api/doctor/local', { lines: [{ text: 'a' }, { text: 'b' }], dropped: 3 })).json().accepted, 2);
      await post('/nova/api/doctor/local-report', { summary: summary('s'), full: gz64(report('s')) });
      const first = (await app.inject({ method: 'GET', url: '/nova/api/doctor/pending' })).json();
      assert.equal(first.lines.length, 2);
      assert.equal(first.dropped, 3);
      assert.ok(first.report?.full);
      const second = (await app.inject({ method: 'GET', url: '/nova/api/doctor/pending' })).json();
      assert.equal(second.lines.length, 0, 'draining is destructive');
      assert.equal(second.report, null);
      assert.equal((await ingest({ lines: [{ text: 'x' }] })).statusCode, 404, 'a player machine is not an ingest point');
    } finally {
      Config.COORDINATOR_URL = '';
    }
  });
});
