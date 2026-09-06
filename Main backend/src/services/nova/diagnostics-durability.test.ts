/**
 * Diagnostics survive the process that recorded them.
 *
 * WHY THIS FILE EXISTS. `DIAGNOSTIC_COVERAGE.md` named the in-memory store the largest gap in the
 * system, in these words: "the most valuable record — what happened immediately before a crash — is
 * the one guaranteed not to survive it." Closing that gap is only a claim until a record is written
 * by one process and read by a different one, so most of these tests spawn real processes.
 *
 * The two that matter most are deliberately hostile:
 *   - the backend is KILLED, not asked to stop. A test that shut it down politely would prove the
 *     shutdown path works and say nothing about a crash, which is the case the store exists for.
 *     Killing also sidesteps a real platform limit: Windows has no signal delivery, so `SIGTERM`
 *     terminates without running the handler, and a signal-based test would pass on Linux and prove
 *     nothing here.
 *   - the crash test uses a genuine uncaught exception with the same handler body index.ts installs,
 *     against the real module and a real database file.
 *
 * Run: npm test
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const DB_MODULE = path.join(ROOT, 'src', 'database.ts');
const DIAG_MODULE = path.join(ROOT, 'src', 'services', 'nova', 'diagnostics.ts');

const TMP = path.join(os.tmpdir(), `nova-durable-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

/** Remove a SQLite file and the two sidecars WAL mode creates. Missing files are not an error. */
function removeDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* never existed */ }
  }
}

/**
 * Run a snippet under tsx in its own process and return what it printed.
 *
 * `require` rather than `import` because this package is CommonJS, which also means a Windows
 * absolute path works verbatim — an ESM specifier would need a file:// URL.
 */
function runChild(name: string, body: string, dbPath: string, timeoutMs = 60_000) {
  const file = path.join(TMP, `${name}.ts`);
  fs.writeFileSync(file, body, 'utf8');
  const r = spawnSync(process.execPath, [TSX, file], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, NOVA_DB_PATH: dbPath },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * Open the database in a FRESH process and report what the diagnostics store holds.
 *
 * This is the operator-visible outcome, not a private one: it goes through exactly the calls
 * index.ts makes at startup, so what comes back is what the dashboard would show after a restart.
 */
function readBackInNewProcess(dbPath: string): { rows: any[]; status: any; raw: string } {
  const r = runChild('reader', `
    const { initDatabase } = require(${JSON.stringify(DB_MODULE)});
    const d = require(${JSON.stringify(DIAG_MODULE)});
    (async () => {
      await initDatabase();
      d.startDiagnosticPersistence();
      const payload = { rows: d.getDiagnostics({ limit: 400 }), status: d.diagnosticPersistenceStatus() };
      console.log('<<<' + JSON.stringify(payload) + '>>>');
      process.exit(0);
    })();
  `, dbPath);

  const m = r.out.match(/<<<([\s\S]*?)>>>/);
  assert.ok(m, `the reader printed no payload (exit ${r.code}):\n${r.out.slice(0, 1200)}`);
  const parsed = JSON.parse(m![1]);
  return { ...parsed, raw: r.out };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function get(port: number, urlPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode || 0));
    });
    req.once('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('request timed out')));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The claim itself: a record outlives the process that made it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('durability across a process boundary', () => {
  test('a crash writes its own record, and a later process can read it', () => {
    // The single case the whole feature exists for. The handler body here is what index.ts installs;
    // it is reproduced rather than imported because the behaviour under test is what happens as the
    // process dies, which cannot be observed from inside the process observing it.
    const db = path.join(TMP, 'crash.db');
    removeDb(db);

    const crashed = runChild('crasher', `
      const { initDatabase } = require(${JSON.stringify(DB_MODULE)});
      const d = require(${JSON.stringify(DIAG_MODULE)});

      process.on('uncaughtException', (err) => {
        d.recordDiagnostic({
          category: 'CRASH', method: 'PROCESS', url: '/process/uncaught', status: 0,
          detail: 'uncaughtException — ' + (err && err.message),
        });
        d.flushDiagnosticsNow();
        setTimeout(() => process.exit(1), 50);
      });

      (async () => {
        await initDatabase();
        d.startDiagnosticPersistence();
        setTimeout(() => { throw new Error('boom-durable-crash'); }, 10);
      })();
    `, db);

    assert.equal(crashed.code, 1, `the crasher must exit non-zero; got ${crashed.code}\n${crashed.out}`);

    const { rows } = readBackInNewProcess(db);
    const crash = rows.find((r) => r.category === 'CRASH');
    assert.ok(crash, `the crash left no durable record. rows: ${JSON.stringify(rows).slice(0, 600)}`);
    assert.match(crash.detail, /boom-durable-crash/, 'the record survived but the cause did not');
    assert.equal(crash.route, '/process/uncaught');
    removeDb(db);
  });

  test('the real backend survives a HARD KILL with its diagnostics intact', async () => {
    // End-to-end against the actual entrypoint: real HTTP, real not-found handler, real flush timer.
    // Nothing here asks the process to stop — it is killed outright, which is both the closest
    // analogue to a crash and the only form of "stop" that behaves the same on Windows and Linux.
    const db = path.join(TMP, 'hardkill.db');
    removeDb(db);
    const port = await freePort();

    const proc = spawn(process.execPath, [TSX, ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        NOVA_PORT: String(port),
        NOVA_DB_PATH: db,
        NOVA_DISABLE_STANDALONE_XMPP: '1',
        NOVA_COORDINATOR: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });

    try {
      const deadline = Date.now() + 60_000;
      while (!out.includes('running on http')) {
        if (proc.exitCode !== null) assert.fail(`the backend exited early (${proc.exitCode}):\n${out}`);
        if (Date.now() > deadline) assert.fail(`the backend never started:\n${out}`);
        await sleep(200);
      }

      // An unrouted path. The not-found handler records it as MISSING and still answers 200 — that
      // response shape is load-bearing for this client and is asserted elsewhere; here it is only
      // the trigger.
      await get(port, '/nova-durability-probe/marker');

      // Long enough for at least one flush tick (FLUSH_INTERVAL_MS is 5s). Waiting is the point:
      // the write-behind design means the exposure window is real, and this test measures it rather
      // than assuming it away.
      await sleep(7_000);
    } finally {
      proc.kill('SIGKILL');
      await sleep(500);
    }

    const { rows, status } = readBackInNewProcess(db);
    assert.equal(status.durable, true, 'the reader did not consider the store durable');
    const probe = rows.find((r) => r.route === '/nova-durability-probe/marker');
    assert.ok(
      probe,
      `the probe was recorded before the kill but not persisted. rows: ${JSON.stringify(rows.map((r: any) => r.route)).slice(0, 600)}`,
    );
    assert.equal(probe.category, 'MISSING');
    assert.equal(probe.method, 'GET');
    removeDb(db);
  });

  test('history accumulates across runs instead of resetting', () => {
    // "Did this start after the last deploy?" is unanswerable if every restart wipes the slate, and
    // that question is most of what a diagnostic history is for.
    const db = path.join(TMP, 'accumulate.db');
    removeDb(db);

    const writer = (marker: string) => `
      const { initDatabase } = require(${JSON.stringify(DB_MODULE)});
      const d = require(${JSON.stringify(DIAG_MODULE)});
      (async () => {
        await initDatabase();
        d.startDiagnosticPersistence();
        d.recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/accumulate/${marker}', status: 500 });
        d.flushDiagnosticsNow();
        process.exit(0);
      })();
    `;

    assert.equal(runChild('w1', writer('one'), db).code, 0);
    assert.equal(runChild('w2', writer('two'), db).code, 0);

    const { rows } = readBackInNewProcess(db);
    const routes = rows.map((r: any) => r.route);
    assert.ok(routes.includes('/accumulate/one'), `the first run was lost: ${JSON.stringify(routes)}`);
    assert.ok(routes.includes('/accumulate/two'), `the second run was lost: ${JSON.stringify(routes)}`);
    removeDb(db);
  });

  test('a repeated failure keeps ONE row with a growing count, not a row per run', () => {
    // Aggregation is the property that makes this store useful rather than a log, and it has to hold
    // across restarts too — otherwise "seen 300 times" silently becomes "seen 3 times, 100 times".
    const db = path.join(TMP, 'aggregate.db');
    removeDb(db);

    const writer = `
      const { initDatabase } = require(${JSON.stringify(DB_MODULE)});
      const d = require(${JSON.stringify(DIAG_MODULE)});
      (async () => {
        await initDatabase();
        d.startDiagnosticPersistence();
        for (let i = 0; i < 5; i++) {
          d.recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/agg/same', status: 500 });
        }
        d.flushDiagnosticsNow();
        process.exit(0);
      })();
    `;

    assert.equal(runChild('a1', writer, db).code, 0);
    assert.equal(runChild('a2', writer, db).code, 0);

    const { rows } = readBackInNewProcess(db);
    const matching = rows.filter((r: any) => r.route === '/agg/same');
    assert.equal(matching.length, 1, `expected one aggregated row, got ${matching.length}`);
    assert.equal(matching[0].count, 10, 'the second run did not continue the first run\'s count');
    removeDb(db);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// In-process behaviour: the parts that are cheaper to pin down without spawning anything.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const UNIT_DB = path.join(TMP, 'unit.db');

let diag: any;
let store: any;

before(async () => {
  process.env.NOVA_DB_PATH = UNIT_DB;
  // Dynamic import so the env var above is set before config.ts resolves DB_PATH — static imports
  // are hoisted above it once TypeScript emits CommonJS.
  const { initDatabase } = (await import('../../database')) as any;
  await initDatabase();
  diag = (await import('./diagnostics')) as any;
  store = (await import('./diagnostics.store')) as any;
  assert.ok(diag.startDiagnosticPersistence(), 'the durable store did not come up for the unit tests');
});

beforeEach(() => diag.clearDiagnostics({ persisted: true }));

describe('the write-behind contract', () => {
  test('recording does NOT write to disk; flushing does', () => {
    // The property that keeps `recordDiagnostic` usable on an error path. If this inverts, a 500
    // storm becomes a write storm inside the code whose job is to survive the storm.
    diag.recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/wb/one', status: 500 });
    assert.equal(store.persistedCount(), 0, 'recording wrote to disk synchronously');
    assert.equal(diag.diagnosticPersistenceStatus().pending, 1, 'the change was not marked pending');

    assert.equal(diag.flushDiagnosticsNow(), 1);
    assert.equal(store.persistedCount(), 1, 'the flush wrote nothing');
    assert.equal(diag.diagnosticPersistenceStatus().pending, 0, 'the dirty set was not cleared');
  });

  test('many occurrences of one problem cost ONE row and ONE flush', () => {
    for (let i = 0; i < 1000; i++) {
      diag.recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/wb/hot', status: 500 });
    }
    assert.equal(diag.diagnosticPersistenceStatus().pending, 1, '1000 events marked more than one key');
    assert.equal(diag.flushDiagnosticsNow(), 1, '1000 events produced more than one row');
    assert.equal(store.persistedCount(), 1);
  });

  test('flushing twice is a no-op, not a double count', () => {
    // Shutdown can flush more than once — the SIGTERM handler and the exit handler both do. If that
    // inflated counts, every restart would make problems look worse than they are.
    diag.recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/wb/idem', status: 500 });
    diag.flushDiagnosticsNow();
    assert.equal(diag.flushDiagnosticsNow(), 0, 'a second flush wrote rows with nothing dirty');

    const rows = store.loadPersisted().filter((r: any) => r.route === '/wb/idem');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 1, 'the count moved without anything happening');
  });

  test('a flush after eviction cannot LOWER a stored count', () => {
    // The subtle one. Memory holds 400 distinct problems; disk holds more. A rare failure can be
    // evicted, recur, restart from 1, and — with a naive upsert — overwrite a stored count of 5000.
    // The stored count is defined as the highest ever reached, which is the only stable reading.
    store.persist([{
      key: 'BACKEND|FAILED|GET|/wb/evicted|7.40', category: 'FAILED', source: 'BACKEND',
      component: 'backend', method: 'GET', route: '/wb/evicted', subsystem: 'other', version: '7.40',
      status: 500, detail: undefined, count: 5000,
      firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z', users: 12,
    }]);

    // What a post-eviction recurrence looks like: same key, count back at 1.
    store.persist([{
      key: 'BACKEND|FAILED|GET|/wb/evicted|7.40', category: 'FAILED', source: 'BACKEND',
      component: 'backend', method: 'GET', route: '/wb/evicted', subsystem: 'other', version: '7.40',
      status: 500, detail: undefined, count: 1,
      firstSeen: '2026-06-01T00:00:00.000Z', lastSeen: '2026-06-01T00:00:00.000Z', users: 1,
    }]);

    const row = store.loadPersisted().find((r: any) => r.route === '/wb/evicted');
    assert.equal(row.count, 5000, 'eviction erased history');
    assert.equal(row.users, 12, 'the affected-user count went backwards');
    assert.equal(row.firstSeen, '2026-01-01T00:00:00.000Z', 'first-seen moved forward');
    assert.equal(row.lastSeen, '2026-06-01T00:00:00.000Z', 'last-seen did not move forward');
  });
});

describe('restore', () => {
  test('restored entries are not re-flushed', () => {
    // Re-marking everything at startup would rewrite the whole table on every boot for no gain.
    diag.recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/restore/one', status: 500 });
    diag.flushDiagnosticsNow();

    diag.clearDiagnostics();                     // memory only — disk keeps the row
    const restored = diag.restoreDiagnostics();
    assert.ok(restored >= 1, 'nothing was restored');
    assert.equal(diag.diagnosticPersistenceStatus().pending, 0, 'restore dirtied clean entries');
  });

  test('a restored entry is not treated as happening right now', () => {
    // The severity model's growth term asks "are most occurrences inside the last five minutes".
    // Seeding that window from disk would make every restart look like a spike in everything.
    diag.recordDiagnostic({
      category: 'MATCHMAKING_FAILURE', method: 'GET', url: '/game/matchmakingservice/x', status: 500,
      accountId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    diag.flushDiagnosticsNow();
    const live = diag.getDiagnostics({ limit: 10 })[0];

    diag.clearDiagnostics();
    diag.restoreDiagnostics();
    const back = diag.getDiagnostics({ limit: 10 })[0];

    assert.equal(back.count, live.count, 'the count did not survive');
    assert.equal(back.affectedUsers, live.affectedUsers, 'the affected-user count did not survive');
    assert.ok(back.score < live.score, `restored history must not score as live activity (${back.score} vs ${live.score})`);
  });

  test('clearing the view does not delete the history', () => {
    // Two different acts, and conflating them would mean "dismiss this from my screen" quietly
    // meant "destroy the evidence".
    diag.recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/restore/keep', status: 500 });
    diag.flushDiagnosticsNow();
    diag.clearDiagnostics();
    assert.equal(store.persistedCount(), 1, 'a plain clear deleted persisted history');

    diag.clearDiagnostics({ persisted: true });
    assert.equal(store.persistedCount(), 0, 'an explicit destructive clear left rows behind');
  });
});

describe('the store cannot become the outage', () => {
  test('no account identifier reaches the database', () => {
    // The aggregate hashes account ids and keeps only a cardinality. Persisting must not be the
    // place that undoes it — a file on disk outlives the process and gets copied around.
    const accountId = 'abcdef0123456789abcdef0123456789';
    diag.recordDiagnostic({ category: 'AUTH_FAILURE', method: 'GET', url: '/priv/one', status: 401, accountId });
    diag.flushDiagnosticsNow();
    const serialised = JSON.stringify(store.loadPersisted());
    assert.ok(!serialised.includes('abcdef0123456789'), `an account id was persisted: ${serialised}`);
  });

  test('tokens in a detail string are redacted before they are written', () => {
    diag.recordDiagnostic({
      category: 'AUTH_FAILURE', method: 'DELETE',
      url: '/account/api/oauth/sessions/kill/eg1~someverylongtokenvalue',
      status: 401, detail: 'failed for eg1~someverylongtokenvalue',
    });
    diag.flushDiagnosticsNow();
    const serialised = JSON.stringify(store.loadPersisted());
    assert.ok(!serialised.includes('someverylongtokenvalue'), `a token was persisted: ${serialised}`);
  });

  test('a write SQLite refuses returns 0 instead of throwing', () => {
    // The real failure shape, driven rather than simulated: a bad binding makes better-sqlite3 throw
    // mid-transaction. `persist` must roll back, report nothing written, and leave the connection
    // usable — a diagnostic flush that poisons the database would be the worst possible outcome.
    const bad = {
      key: 'BACKEND|FAILED|GET|/degrade/bad|7.40', category: 'FAILED', source: 'BACKEND',
      component: 'backend', method: 'GET', route: '/degrade/bad', subsystem: 'other',
      version: '7.40', status: 500, detail: undefined,
      count: { not: 'a number' } as any,     // better-sqlite3 refuses to bind an object
      firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z', users: 0,
    };
    let written: number | undefined;
    assert.doesNotThrow(() => { written = store.persist([bad]); });
    assert.equal(written, 0, 'a failed write reported success');

    // The connection still works afterwards, which is the half that would actually hurt.
    diag.recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/degrade/after', status: 500 });
    assert.equal(diag.flushDiagnosticsNow(), 1, 'the store never recovered from a failed write');
    assert.equal(store.persistedCount(), 1);
  });

  test('with no database at all, recording still works and startup still succeeds', () => {
    // The production degradation path: `getDatabase()` throws when the database was never opened.
    // Diagnostics being non-durable is a bad day; diagnostics preventing a backend from starting is
    // a worse one, so this asserts the whole module stays usable with the store refusing to come up.
    const r = runChild('nodb', `
      const d = require(${JSON.stringify(DIAG_MODULE)});
      // Deliberately NO initDatabase() — the store cannot come up.
      const durable = d.startDiagnosticPersistence();
      d.recordDiagnostic({ category: 'FAILED', method: 'GET', url: '/nodb/one', status: 500 });
      const flushed = d.flushDiagnosticsNow();
      const rows = d.getDiagnostics({ limit: 10 });
      console.log('<<<' + JSON.stringify({
        durable, flushed, routes: rows.map((x) => x.route),
        status: d.diagnosticPersistenceStatus(),
      }) + '>>>');
      process.exit(0);
    `, path.join(TMP, 'never-created.db'));

    const m = r.out.match(/<<<([\s\S]*?)>>>/);
    assert.ok(m, `the child did not survive without a database (exit ${r.code}):\n${r.out.slice(0, 1200)}`);
    const got = JSON.parse(m![1]);
    assert.equal(r.code, 0, 'a missing database took the process down');
    assert.equal(got.durable, false, 'the store claimed to be durable with no database');
    assert.equal(got.status.durable, false, 'the reported status disagrees with reality');
    assert.equal(got.flushed, 0, 'a flush with no store claimed to have written rows');
    assert.deepEqual(got.routes, ['/nodb/one'], 'in-memory recording stopped working');
  });
});

describe('measured cost, not assumed cost', () => {
  test('persistence does not put meaningful work on the recording path', () => {
    // The brief was explicit that "lightweight" has to be measured. 20k records with the durable
    // store enabled; the threshold is deliberately loose because CI machines vary — it is there to
    // catch a per-event disk write, which would be orders of magnitude over it, not to police
    // microseconds.
    const N = 20_000;
    const started = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      // `route-N`, not `N`: normaliseRoute collapses a purely numeric segment to `{n}`, which would
      // have made all 20,000 events one key and quietly turned this into a different test.
      diag.recordDiagnostic({ category: 'FAILED', method: 'GET', url: `/perf/route-${i % 50}`, status: 500 });
    }
    const perCallUs = Number(process.hrtime.bigint() - started) / 1000 / N;

    assert.equal(store.persistedCount(), 0, 'recording reached the disk');
    assert.ok(perCallUs < 50, `recordDiagnostic cost ${perCallUs.toFixed(2)}us/call with persistence on`);

    const flushStart = process.hrtime.bigint();
    const written = diag.flushDiagnosticsNow();
    const flushMs = Number(process.hrtime.bigint() - flushStart) / 1e6;

    assert.equal(written, 50, `${N} events should collapse to 50 rows, got ${written}`);
    assert.ok(flushMs < 1000, `flushing 50 rows took ${flushMs.toFixed(1)}ms`);
    console.log(`      [measured] record ${perCallUs.toFixed(2)}us/call · flush ${written} rows in ${flushMs.toFixed(1)}ms`);
  });
});
