/**
 * Step one of `gameserver-register-unauthenticated`, in the coordinator's REAL configuration:
 * NOVA_REGISTER_SECRET unset.
 *
 * Until 2026-11-08 this configuration answered `GET /nova/api/register-secret` with 503, so no
 * launcher ever received a secret and step one delivered nothing. The fix issues a secret WITHOUT
 * enforcing it. These tests pin both halves, and the second matters more: a launcher that sends no
 * secret — every launcher before 1.6.5 — must still be able to host.
 *
 * Run: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';

const SECRET_FILE = path.join(os.tmpdir(), `nova-issued-${process.pid}-${Date.now()}`, 'register-secret');
process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-issued-${process.pid}.db`);
process.env.NOVA_REGISTER_SECRET_FILE = SECRET_FILE;
delete process.env.NOVA_REGISTER_SECRET;

let app: FastifyInstance;
let token = '';
let forget: () => void;

before(async () => {
  const { initDatabase } = (await import('../../database')) as any;
  const { authRoutes } = (await import('../auth/auth.routes')) as any;
  const { matchmakingRoutes } = (await import('./matchmaking.routes')) as any;
  forget = ((await import('./registerSecret')) as any)._forgetCachedRegisterSecret;

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
    payload: 'grant_type=password&username=issuedtester&password=x',
  });
  token = res.json().access_token;
  assert.ok(token, 'test setup needs a real token');
});

const getSecret = (headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/nova/api/register-secret', headers });

let port = 9000;
/** Register a NEW server each call (fresh port) so the "registered" log line fires. */
async function register(secret?: string): Promise<{ status: number; log: string }> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try {
    const payload: Record<string, unknown> = { address: '127.0.0.1', port: port++ };
    if (secret !== undefined) payload.secret = secret;
    const res = await app.inject({
      method: 'POST', url: '/nova/api/gameserver/register',
      headers: { 'content-type': 'application/json' }, payload,
    });
    return { status: res.statusCode, log: lines.join('\n') };
  } finally {
    console.log = orig;
  }
}

describe('issuing a secret with NOVA_REGISTER_SECRET unset', () => {
  test('an anonymous caller gets nothing, and nothing is created on its behalf', async () => {
    const res = await getSecret();
    assert.notEqual(res.statusCode, 200);
    assert.equal(fs.existsSync(SECRET_FILE), false, 'an unauthenticated request generated the secret');
  });

  test('a signed-in launcher gets a secret instead of 503', async () => {
    // THE regression: this was 503 on the live coordinator for every launcher.
    const res = await getSecret({ authorization: `bearer ${token}` });
    assert.equal(res.statusCode, 200, `got HTTP ${res.statusCode}: ${res.body}`);
    const { secret } = res.json();
    assert.equal(typeof secret, 'string');
    assert.ok(secret.length >= 32, 'the issued secret is too short to be worth anything');
  });

  test('it is the same secret on every request, and it survives a restart', async () => {
    const a = (await getSecret({ authorization: `bearer ${token}` })).json().secret;
    const b = (await getSecret({ authorization: `bearer ${token}` })).json().secret;
    assert.equal(a, b, 'two launchers would have been handed different secrets');
    forget(); // as a process restart would
    const c = (await getSecret({ authorization: `bearer ${token}` })).json().secret;
    assert.equal(a, c, 'a restart changed the secret, stranding every agent holding the old one');
    assert.equal(fs.readFileSync(SECRET_FILE, 'utf8').trim(), a);
  });
});

describe('the gate is NOT closed by issuing it', () => {
  test('a registration with NO secret is still accepted — old launchers keep hosting', async () => {
    const r = await register();
    assert.equal(r.status, 200, 'issuing a secret locked out launchers that do not send one');
    assert.match(r.log, /auth=unsigned/);
  });

  test('a registration with the issued secret is accepted and recorded as signed', async () => {
    const secret = (await getSecret({ authorization: `bearer ${token}` })).json().secret;
    const r = await register(secret);
    assert.equal(r.status, 200);
    assert.match(r.log, /auth=signed/);
  });

  test('a WRONG secret is accepted too in step one, but recorded as wrong', async () => {
    // An agent outlives its launcher and can hold a stale secret. Visible, not an outage.
    const r = await register('not-the-issued-secret');
    assert.equal(r.status, 200);
    assert.match(r.log, /auth=wrong/);
  });

  test('the secret never appears in the log', async () => {
    const secret = (await getSecret({ authorization: `bearer ${token}` })).json().secret;
    const r = await register(secret);
    assert.ok(!r.log.includes(secret), 'the registration secret was written to the log');
  });

  test('unregister without a secret still works', async () => {
    const res = await app.inject({
      method: 'POST', url: '/nova/api/gameserver/unregister',
      headers: { 'content-type': 'application/json' },
      payload: { address: '127.0.0.1', port: 9000, playlist: '*' },
    });
    assert.equal(res.statusCode, 200);
  });
});
