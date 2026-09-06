/**
 * The gameserver-registration secret must never be handed to an unauthenticated caller.
 *
 * CONTEXT. `POST /nova/api/gameserver/register` decides the address every player is routed to, and
 * the coordinator is publicly reachable through a Tailscale Funnel. Its gate is currently open
 * because no launcher in the field sends a credential — see `gameserver-register-unauthenticated` in
 * KNOWN_ISSUES.md, and the two-step plan in the route's own comment.
 *
 * `GET /nova/api/register-secret` is step one: it hands the secret to a launcher that HAS logged in.
 * An endpoint whose entire job is to disclose a credential is worth more tests than most, because
 * the failure mode is silent — it hands the secret out and everything looks like it works.
 *
 * Run: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-regsecret-${process.pid}.db`);
process.env.NOVA_REGISTER_SECRET = 'test-secret-value-do-not-ship';

let app: FastifyInstance;
let token = '';

before(async () => {
  const { initDatabase } = (await import('../../database')) as any;
  const { authRoutes } = (await import('../auth/auth.routes')) as any;
  const { matchmakingRoutes } = (await import('./matchmaking.routes')) as any;

  await initDatabase();
  app = Fastify({ logger: false });
  await app.register(formbody);
  await app.register(authRoutes);
  await app.register(matchmakingRoutes);
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/account/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=password&username=hosttester&password=x',
  });
  token = res.json().access_token;
  assert.ok(token, 'test setup needs a real token');
});

const get = (headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/nova/api/register-secret', headers });

describe('GET /nova/api/register-secret', () => {
  test('refuses a caller with no Authorization header at all', async () => {
    const res = await get();
    assert.notEqual(res.statusCode, 200, 'the secret was served to an anonymous caller');
    assert.ok(!res.body.includes('test-secret-value'), 'the secret leaked in the error body');
  });

  test('refuses a garbage bearer token', async () => {
    const res = await get({ authorization: 'bearer not-a-real-token' });
    assert.notEqual(res.statusCode, 200);
    assert.ok(!res.body.includes('test-secret-value'));
  });

  test('refuses a well-formed token that was never issued', async () => {
    // Shape alone must not be enough — this is the case a signature check exists to catch.
    const res = await get({ authorization: 'bearer eg1~aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    assert.notEqual(res.statusCode, 200);
    assert.ok(!res.body.includes('test-secret-value'));
  });

  test('serves it to a launcher that has actually logged in', async () => {
    const res = await get({ authorization: `bearer ${token}` });
    assert.equal(res.statusCode, 200, `authenticated launcher got HTTP ${res.statusCode}`);
    assert.equal(res.json().secret, 'test-secret-value-do-not-ship');
  });

  test('the secret it serves is the one the register gate compares against', async () => {
    // The whole point of the endpoint. If these two ever drift, hosting fails closed for everyone
    // the moment step two lands, and the cause would be invisible.
    const secret = (await get({ authorization: `bearer ${token}` })).json().secret;
    const ok = await app.inject({
      method: 'POST', url: '/nova/api/gameserver/register',
      headers: { 'content-type': 'application/json' },
      payload: { address: '127.0.0.1', port: 7777, secret },
    });
    assert.equal(ok.statusCode, 200, 'the served secret was rejected by the register gate');
  });

  test('a WRONG secret is still refused by the register gate', async () => {
    // Guards the test above: it would pass just as well if the gate accepted everything.
    const bad = await app.inject({
      method: 'POST', url: '/nova/api/gameserver/register',
      headers: { 'content-type': 'application/json' },
      payload: { address: '127.0.0.1', port: 7778, secret: 'wrong' },
    });
    assert.equal(bad.statusCode, 403, 'the register gate accepted a wrong secret');
  });
});
