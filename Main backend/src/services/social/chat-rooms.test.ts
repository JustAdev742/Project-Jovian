/**
 * reserveGeneralChatRooms must answer whichever verb the client uses.
 *
 * WHY THIS EXISTS. 7.40 calls this 81 times a session — the 9th busiest endpoint in the observed
 * surface — and it was registered POST-only. Whether that is right cannot be established from
 * anything available:
 *
 *   - `cobalt.log` holds 81 of these, but Cobalt hooks `curl_easy_setopt(CURLOPT_URL, ...)`, which
 *     carries the URL and NOT the method.
 *   - VERSION_COMPATIBILITY.md §2 printed it as `GET`; that column was inferred, not measured.
 *   - The endpoint corpus does not document the route at all.
 *
 * Found by driving the real session flow (`e2e-probe.ts`), where it was the one non-2xx of 22 steps.
 * The handler is read-only, so answering both verbs is free — and this test is what stops someone
 * "tidying" it back to one on the assumption that the table's method column was evidence.
 *
 * Run: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-chatrooms-${process.pid}.db`);

let app: FastifyInstance;
const ACCT = '0e17727cd40e286aeee0bc2b1b2e8e79';
const URL = `/fortnite/api/game/v2/chat/${ACCT}/reserveGeneralChatRooms/Athena/pc`;

before(async () => {
  const { initDatabase } = (await import('../../database')) as any;
  const { socialRoutes } = (await import('./social.routes')) as any;
  await initDatabase();
  app = Fastify({ logger: false, maxParamLength: 10000, ignoreTrailingSlash: true });
  await app.register(formbody);
  await app.register(socialRoutes);
  await app.ready();
});

describe('reserveGeneralChatRooms', () => {
  for (const method of ['GET', 'POST'] as const) {
    test(`answers ${method}`, async () => {
      const res = await app.inject({ method, url: URL });
      assert.equal(res.statusCode, 200, `${method} returned ${res.statusCode}`);
      const body = res.json();
      assert.ok(Array.isArray(body.globalChatRooms), `${method}: no globalChatRooms array`);
      assert.equal(body.globalChatRooms.length, 1);
      assert.equal(body.globalChatRooms[0].ownerAccountId, ACCT);
    });
  }

  test('both verbs return the same body', async () => {
    // If they ever diverge, one of them is a different code path and the point of the fix is lost.
    const g = (await app.inject({ method: 'GET', url: URL })).json();
    const p = (await app.inject({ method: 'POST', url: URL })).json();
    assert.deepEqual(g, p);
  });

  test('a verb the client never uses is still rejected', async () => {
    // Guards against "fixing" this by registering every method — the point is to cover the two
    // plausible ones, not to stop distinguishing routes at all.
    const res = await app.inject({ method: 'DELETE', url: URL });
    assert.notEqual(res.statusCode, 200);
  });
});
