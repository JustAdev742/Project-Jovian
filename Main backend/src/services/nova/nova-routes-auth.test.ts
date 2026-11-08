/**
 * The destructive Nova routes must not be callable by anyone who can reach the server.
 *
 * On the coordinator, Tailscale Funnel publishes every path of 127.0.0.1:3551 to the internet, and
 * that traffic arrives FROM 127.0.0.1 — so "only the local machine can reach it" was never true
 * there. See KNOWN_ISSUES coordinator-local-control-routes-public.
 *
 * Run: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-routes-auth-${process.pid}.db`);
process.env.NOVA_AC_ADMIN_SECRET = 'admin-secret-for-this-test-only';
delete process.env.NOVA_REGISTER_SECRET;

let app: FastifyInstance;

before(async () => {
  const { initDatabase } = (await import('../../database')) as any;
  const { novaRoutes } = (await import('./nova.routes')) as any;
  await initDatabase();
  app = Fastify({ logger: false });
  await app.register(novaRoutes);
  await app.ready();
});

describe('DELETE /nova/api/logs and /nova/api/diagnostics', () => {
  for (const url of ['/nova/api/logs', '/nova/api/diagnostics']) {
    test(`${url}: refused without the admin secret`, async () => {
      const res = await app.inject({ method: 'DELETE', url });
      assert.equal(res.statusCode, 403, `anyone could clear ${url}`);
    });

    test(`${url}: refused with a wrong secret`, async () => {
      const res = await app.inject({ method: 'DELETE', url, headers: { 'x-nova-admin': 'nope' } });
      assert.equal(res.statusCode, 403);
    });

    test(`${url}: allowed with the admin secret`, async () => {
      const res = await app.inject({ method: 'DELETE', url, headers: { 'x-nova-admin': 'admin-secret-for-this-test-only' } });
      assert.equal(res.statusCode, 200);
    });
  }
});

describe('what the launcher depends on still works without a secret', () => {
  test('GET /nova/api/logs stays open — the launcher\'s Logs tab reads its local agent with it', async () => {
    const res = await app.inject({ method: 'GET', url: '/nova/api/logs?limit=5' });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json().logs));
  });
});
