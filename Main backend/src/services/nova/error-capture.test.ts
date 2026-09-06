/**
 * Every failure response reaches diagnostics — however it was produced.
 *
 * WHY. `setErrorHandler` only fires for THROWN errors, and this backend mostly does not throw. It
 * sends: `Errors.unauthorized(reply, …)` calls `sendEpicError(reply, 401, …)`, and there were 51
 * sites in `services/` doing `return reply.status(4xx).send(…)` directly. None of those reached the
 * error handler, so none appeared in diagnostics — the dashboard could show unrouted paths and
 * crashes while being blind to every deliberate rejection, which is most of what a player hits.
 *
 * The three shapes that must all be counted, and counted once:
 *   1. thrown   — setErrorHandler records it, with the exception message
 *   2. sent     — the onResponse hook records it
 *   3. unrouted — setNotFoundHandler records it as MISSING (and answers 200/204, not 4xx)
 *
 * Run: npm test
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-errcap-${process.pid}.db`);

let app: FastifyInstance;
let getDiagnostics: any;
let recordDiagnostic: any;
let redactSecrets: any;

/**
 * Rebuilds the same three hooks index.ts installs. Importing index.ts would boot listeners and a
 * database; the hooks are what is under test, so they are reproduced here verbatim in behaviour.
 */
before(async () => {
  ({ getDiagnostics, recordDiagnostic, redactSecrets } = (await import('./diagnostics')) as any);

  app = Fastify({ logger: false, maxParamLength: 10000, ignoreTrailingSlash: true });

  app.setNotFoundHandler(async (request, reply) => {
    recordDiagnostic({
      category: 'MISSING',
      method: request.method,
      url: request.url,
      status: request.method === 'GET' ? 200 : 204,
      detail: 'no route matched; answered by the catch-all',
    });
    if (request.method === 'GET') return reply.send({});
    return reply.status(204).send();
  });

  app.setErrorHandler((error, request, reply) => {
    const sc = (error as any).statusCode;
    const status = typeof sc === 'number' && sc >= 400 ? sc : 500;
    recordDiagnostic({
      category: status === 401 || status === 403 ? 'AUTH_FAILURE' : status >= 500 ? 'INTERNAL_ERROR' : 'FAILED',
      method: request.method,
      url: request.url,
      status,
      detail: error.message,
    });
    (request as any).__diagRecorded = true;
    reply.status(status).send({ errorMessage: 'x' });
  });

  app.addHook('onResponse', async (request, reply) => {
    if ((request as any).__diagRecorded) return;
    const status = reply.statusCode;
    if (status < 400) return;
    recordDiagnostic({
      category: status === 401 || status === 403 ? 'AUTH_FAILURE' : status >= 500 ? 'INTERNAL_ERROR' : 'FAILED',
      method: request.method,
      url: request.url,
      status,
      detail: 'sent by a route handler (not thrown)',
    });
  });

  // 2. SENT, not thrown — the shape that was invisible before.
  app.get('/sent-401', async (_req, reply) => reply.status(401).send({ e: 'no' }));
  app.get('/sent-403', async (_req, reply) => reply.status(403).send({ e: 'no' }));
  app.get('/sent-400', async (_req, reply) => reply.status(400).send({ e: 'no' }));
  app.get('/sent-500', async (_req, reply) => reply.status(500).send({ e: 'no' }));
  // 1. THROWN.
  app.get('/thrown', async () => { const e: any = new Error('boom'); e.statusCode = 401; throw e; });
  // A success, which must record nothing.
  app.get('/fine', async (_req, reply) => reply.send({ ok: true }));

  await app.ready();
});

/** Only the rows this test just produced. */
const rowsFor = (url: string) =>
  (getDiagnostics() as any[]).filter((d) => (d.route || d.url || '').includes(url));

describe('a failure response is recorded however it was produced', () => {
  for (const [route, expected] of [
    ['/sent-401', 'AUTH_FAILURE'],
    ['/sent-403', 'AUTH_FAILURE'],
    ['/sent-400', 'FAILED'],
    ['/sent-500', 'INTERNAL_ERROR'],
  ] as const) {
    test(`${route} — sent, not thrown — is captured as ${expected}`, async () => {
      await app.inject({ method: 'GET', url: route });
      const rows = rowsFor(route);
      assert.ok(rows.length >= 1, `${route} produced no diagnostic at all`);
      assert.equal(rows[0].category, expected);
    });
  }

  test('a thrown error is still captured, with its own message', async () => {
    await app.inject({ method: 'GET', url: '/thrown' });
    const rows = rowsFor('/thrown');
    assert.ok(rows.length >= 1, 'thrown error produced no diagnostic');
    assert.equal(rows[0].category, 'AUTH_FAILURE');
    assert.ok(
      String(rows[0].detail || '').includes('boom'),
      'the thrown handler must win over the onResponse hook — its detail carries the exception',
    );
  });

  test('a thrown error is recorded ONCE, not twice', async () => {
    // Both hooks would fire without the __diagRecorded flag. Double counting would silently inflate
    // every incident total on the dashboard, which is worse than under-reporting because it looks
    // like real signal.
    const before = rowsFor('/thrown').reduce((n, r) => n + (r.count || 1), 0);
    await app.inject({ method: 'GET', url: '/thrown' });
    const after = rowsFor('/thrown').reduce((n, r) => n + (r.count || 1), 0);
    assert.equal(after - before, 1, `one request added ${after - before} to the count`);
  });

  test('an unrouted path is captured as MISSING even though it answers 200', async () => {
    await app.inject({ method: 'GET', url: '/no/such/route/at/all' });
    const rows = rowsFor('/no/such/route');
    assert.ok(rows.length >= 1, 'unrouted path produced no diagnostic');
    assert.equal(rows[0].category, 'MISSING');
  });

  test('a successful response records nothing', async () => {
    // The guard that keeps this from recording every request in the game.
    const before = rowsFor('/fine').length;
    const res = await app.inject({ method: 'GET', url: '/fine' });
    assert.equal(res.statusCode, 200);
    assert.equal(rowsFor('/fine').length, before, '2xx must not produce a diagnostic');
  });
});
