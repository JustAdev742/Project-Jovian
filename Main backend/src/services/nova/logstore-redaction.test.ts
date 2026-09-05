/**
 * NOVA-AUDIT-012 — the OTHER half of the token leak.
 *
 * NOVA-AUDIT-001 redacted the backend's own `[HTTP]` log line, which was real and worth doing. But
 * the line that actually carries the tokens does not come from this process at all: Cobalt runs
 * inside the game, logs `URL: <full url>` for every redirected request, and POSTs those lines to
 * `/nova/api/logs/ingest`. 7.40 ends every session with
 * `DELETE /account/api/oauth/sessions/kill/eg1~<jwt>` — a live bearer token in the URL PATH — so
 * Cobalt's own lines contain tokens by construction.
 *
 * `ingestLogs` stored `msg` verbatim, and `GET /nova/api/logs` requires no Authorization header, so
 * the ingest path put unredacted session tokens behind an unauthenticated read. Redacting only the
 * locally-generated line closed the smaller half.
 *
 * KNOWN_ISSUES.md files the remainder as `cobalt-logs-bearer-tokens`, "the Cobalt half is still
 * open" — i.e. as something only a Cobalt release can fix. It is not: whatever Cobalt sends, this
 * process controls what it STORES and SERVES. Redacting on ingest fixes it for every launcher
 * already in the field, without shipping a new DLL.
 *
 * Run: npm test
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';

process.env.NOVA_DB_PATH = path.join(os.tmpdir(), `nova-logredact-${process.pid}.db`);

let store: any;
let app: FastifyInstance;

// A token shaped exactly like the ones 7.40 puts in the kill-session path.
const CANARY = 'eg1~eyJhbGciOiJIUzI1NiIsImtpZCI6ImNhbmFyeSJ9.eyJzdWIiOiJub3ZhLXRlc3QifQ.S1gNaTuRe0000CanaryValue';

before(async () => {
  store = await import('./logStore');
  const { novaRoutes } = (await import('./nova.routes')) as any;
  app = Fastify({ logger: false });
  await app.register(novaRoutes);
  await app.ready();
});

describe('ingested component logs must not carry live tokens', () => {
  test('a Cobalt line containing a session token is redacted before it is stored', async () => {
    store.clearLogs();

    // Exactly the shape Cobalt forwards.
    const accepted = store.ingestLogs('cobalt', [
      { level: 'info', msg: `URL: http://127.0.0.1:3551/account/api/oauth/sessions/kill/${CANARY}` },
    ]);
    assert.equal(accepted, 1, 'the line must still be accepted — redaction, not rejection');

    const stored = store.getLogs(50).map((l: any) => l.msg).join('\n');
    assert.ok(!stored.includes(CANARY), 'the raw token must not survive into the buffer');
    assert.match(stored, /eg1~<redacted>/, 'the redacted marker keeps the line readable');
    assert.match(stored, /sessions\/kill/, 'the useful part of the line must be preserved');
  });

  test('the unauthenticated log route cannot serve a token', async () => {
    store.clearLogs();
    store.ingestLogs('cobalt', [{ level: 'info', msg: `URL: /x?access_token=${CANARY}` }]);

    // No Authorization header — this is the whole point. The route is deliberately open so the
    // launcher's Logs tab works without a user token; that makes what it STORES the only defence.
    const res = await app.inject({ method: 'GET', url: '/nova/api/logs' });
    assert.equal(res.statusCode, 200);
    assert.ok(
      !res.payload.includes(CANARY),
      'an unauthenticated reader must not be able to harvest a live session token',
    );
  });

  test('a component STATUS line is redacted too', async () => {
    store.clearLogs();
    store.ingestLogs('cobalt', [{ level: 'info', msg: 'ok' }], { text: `hooked ${CANARY}`, healthy: true });
    const statuses = JSON.stringify(store.getComponentStatuses());
    assert.ok(!statuses.includes(CANARY), 'the status field is served by the same route and needs the same treatment');
  });

  test('ordinary log lines are left completely alone', async () => {
    store.clearLogs();
    const plain = 'Cobalt initialised; curl_easy_setopt hook installed at 0x7ff6a1b2c3d4';
    store.ingestLogs('cobalt', [{ level: 'info', msg: plain }]);
    assert.equal(store.getLogs(10)[0].msg, plain, 'redaction must not rewrite innocent text');
  });
});
