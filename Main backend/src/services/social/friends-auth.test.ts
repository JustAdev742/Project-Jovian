/**
 * Integration tests for friend/blocklist ownership.
 *
 * WHY THESE ARE HTTP-LEVEL AND NOT UNIT TESTS
 * -------------------------------------------
 * The defect these guard against was not in any single function — every handler did exactly what it
 * said. It was that the ROUTE carried no proof of who the caller was, so `accountId` came straight
 * off the path. Only a request-level test can see that, and it is the difference between "the
 * function works" and "the endpoint is safe".
 *
 * Proven against a scratch database on 2026-08-31, surviving a process restart: with no
 * Authorization header at all, a caller could put a friend request on someone else's account, add
 * arbitrary entries to their blocklist, and delete an existing mutual friendship. The EOS family
 * reached the same tables through `/epic/friends/v1/...`, so fixing only one door would have moved
 * the hole rather than closed it — both are covered here for that reason.
 *
 * `app.inject()` dispatches through the real Fastify router in-process: no port is bound, no network
 * is touched, and `index.ts` is never imported (it runs `main()` at import time and would bind
 * ports). The route modules are exported functions, so they can be registered on a bare instance.
 *
 * Run: npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';

const DB = path.join(os.tmpdir(), `nova-friends-auth-${process.pid}.db`);
process.env.NOVA_DB_PATH = DB;

/**
 * THE DATABASE MODULES ARE LOADED DYNAMICALLY, AND THAT IS NOT A STYLE CHOICE.
 *
 * `import` declarations are hoisted: they run before any top-level statement in this file, so a
 * plain `import { initDatabase } from '../../database'` would load config.ts — and resolve
 * `Config.DB_PATH` — BEFORE the `process.env.NOVA_DB_PATH` assignment above ever executed. The
 * first version of this file did exactly that and ran the whole suite against
 * `Main backend/data/nova.db`, creating a `tester` account and a blocklist row in the real
 * database. They were removed afterwards, but the test should never have been able to do it.
 *
 * config.ts documents this trap in its own words: without NOVA_DB_PATH, "did my change work" and
 * "did I just edit live player accounts" become the same question. The `assertScratchDatabase`
 * guard below is the belt to this braces — if the path is ever anything but a temp file, the suite
 * refuses to run rather than quietly writing to real data.
 */
let initDatabase: () => Promise<unknown>;
let socialRoutes: (f: FastifyInstance) => Promise<void>;
let eosRoutes: (f: FastifyInstance) => Promise<void>;
let authRoutes: (f: FastifyInstance) => Promise<void>;

/** Refuse to run against anything that is not a scratch file. */
function assertScratchDatabase(resolved: string): void {
  const real = path.resolve(__dirname, '..', '..', '..', 'data', 'nova.db');
  assert.notEqual(
    path.resolve(resolved), path.resolve(real),
    'REFUSING TO RUN: the tests resolved to the real database. Check NOVA_DB_PATH and import order.',
  );
  assert.ok(
    path.resolve(resolved).startsWith(path.resolve(os.tmpdir())),
    `REFUSING TO RUN: database path ${resolved} is not under the temp directory.`,
  );
}

const VICTIM = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'ffffffffffffffffffffffffffffffff';

let app: FastifyInstance;
/** A real player token, and the account it belongs to. */
let token = '';
let self = '';

before(async () => {
  // Dynamic, so these run AFTER process.env.NOVA_DB_PATH is set above.
  const { Config } = await import('../../config');
  assertScratchDatabase(Config.DB_PATH);

  ({ initDatabase } = await import('../../database') as any);
  ({ socialRoutes } = await import('./social.routes') as any);
  ({ eosRoutes } = await import('../eos/eos.routes') as any);
  ({ authRoutes } = await import('../auth/auth.routes') as any);

  await initDatabase();
  app = Fastify({ logger: false });
  await app.register(formbody);
  await app.register(authRoutes as any);
  await app.register(socialRoutes as any);
  await app.register(eosRoutes as any);
  await app.ready();

  const res = await app.inject({
    method: 'POST',
    url: '/account/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'grant_type=password&username=tester&password=x',
  });
  const body = res.json();
  token = body.access_token;
  self = body.account_id;
  assert.ok(token && self, 'test setup needs a real token');
});

after(async () => {
  await app?.close();
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* fine */ }
  }
});

/** The victim's state, read back through the summary endpoint. */
async function victimState() {
  const res = await app.inject({ method: 'GET', url: `/friends/api/v1/${VICTIM}/summary` });
  return res.json();
}

describe('the scratch-database guard itself', () => {
  // Tested directly rather than by sabotaging the suite, because the only way to prove the guard
  // by experiment is to point it at real data — which is the thing it exists to prevent.
  test('refuses the real database path', () => {
    const real = path.resolve(__dirname, '..', '..', '..', 'data', 'nova.db');
    assert.throws(() => assertScratchDatabase(real), /REFUSING TO RUN/);
  });

  test('refuses any path outside the temp directory', () => {
    assert.throws(() => assertScratchDatabase(path.resolve('somewhere', 'else.db')), /REFUSING TO RUN/);
  });

  test('accepts a temp-directory path', () => {
    assert.doesNotThrow(() => assertScratchDatabase(DB));
  });
});

describe('friends: an unauthenticated caller cannot touch another account', () => {
  const routes: Array<[string, string]> = [
    ['POST', `/friends/api/public/friends/${VICTIM}/${OTHER}`],
    ['DELETE', `/friends/api/public/friends/${VICTIM}/${OTHER}`],
    ['POST', `/friends/api/public/blocklist/${VICTIM}/${OTHER}`],
    ['DELETE', `/friends/api/public/blocklist/${VICTIM}/${OTHER}`],
    ['POST', `/friends/api/v1/${VICTIM}/friends/${OTHER}`],
    ['DELETE', `/friends/api/v1/${VICTIM}/friends/${OTHER}`],
    ['POST', `/friends/api/v1/${VICTIM}/blocklist/${OTHER}`],
    ['DELETE', `/friends/api/v1/${VICTIM}/blocklist/${OTHER}`],
    ['POST', `/epic/friends/v1/nova_deployment/users/${VICTIM}/friends/${OTHER}`],
    ['DELETE', `/epic/friends/v1/nova_deployment/users/${VICTIM}/friends/${OTHER}`],
    ['POST', `/epic/friends/v1/nova_deployment/users/${VICTIM}/blocked/${OTHER}`],
  ];

  for (const [method, url] of routes) {
    test(`${method} ${url.replace(VICTIM, '<victim>').replace(OTHER, '<other>')} is refused`, async () => {
      const res = await app.inject({ method: method as any, url });
      assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}`);
    });
  }

  test('and none of them changed the victim\'s state', async () => {
    const s = await victimState();
    assert.deepEqual(s.friends, []);
    assert.deepEqual(s.outgoing, []);
    assert.deepEqual(s.incoming, []);
    assert.deepEqual(s.blocklist, []);
  });
});

describe('friends: a valid token does not authorise acting on a DIFFERENT account', () => {
  // The distinction that matters: the guard checks ownership, not merely that a token exists.
  test('POST on someone else\'s account is refused even with a real token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/friends/api/public/friends/${VICTIM}/${OTHER}`,
      headers: { authorization: `bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual((await victimState()).outgoing, []);
  });

  test('EOS: POST on someone else\'s account is refused even with a real token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/epic/friends/v1/nova_deployment/users/${VICTIM}/blocked/${OTHER}`,
      headers: { authorization: `bearer ${token}` },
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual((await victimState()).blocklist, []);
  });
});

describe('friends: the legacy path 7.40 actually uses must WORK when authorised', () => {
  // This half matters as much as the refusals. Before 2026-08-31 only the GET forms of
  // /friends/api/public/... were routed, so POST fell through to the catch-all, which answers a
  // POST with 204. Adding a friend in game returned success and did nothing, silently, forever.
  // A test that only checked the 401s would pass just as well against a backend that no-ops.
  test('POST /friends/api/public/friends/<self>/<other> records the request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/friends/api/public/friends/${self}/${OTHER}`,
      headers: { authorization: `bearer ${token}` },
    });
    assert.equal(res.statusCode, 204);

    const summary = (await app.inject({ method: 'GET', url: `/friends/api/v1/${self}/summary` })).json();
    assert.equal(summary.outgoing.length, 1, 'the friend request must actually be stored');
    assert.equal(summary.outgoing[0].accountId, OTHER);
  });

  test('block then unblock round-trips through the legacy path', async () => {
    const block = await app.inject({
      method: 'POST',
      url: `/friends/api/public/blocklist/${self}/${OTHER}`,
      headers: { authorization: `bearer ${token}` },
    });
    assert.equal(block.statusCode, 204);
    let list = (await app.inject({ method: 'GET', url: `/friends/api/public/blocklist/${self}` })).json();
    assert.deepEqual(list.blockedUsers, [OTHER]);

    const unblock = await app.inject({
      method: 'DELETE',
      url: `/friends/api/public/blocklist/${self}/${OTHER}`,
      headers: { authorization: `bearer ${token}` },
    });
    assert.equal(unblock.statusCode, 204);
    list = (await app.inject({ method: 'GET', url: `/friends/api/public/blocklist/${self}` })).json();
    assert.deepEqual(list.blockedUsers, []);
  });

  test('EOS: acting on your OWN account still works', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/epic/friends/v1/nova_deployment/users/${self}/blocked/${OTHER}`,
      headers: { authorization: `bearer ${token}` },
    });
    assert.equal(res.statusCode, 204);
    const list = (await app.inject({ method: 'GET', url: `/friends/api/public/blocklist/${self}` })).json();
    assert.deepEqual(list.blockedUsers, [OTHER]);
  });
});
