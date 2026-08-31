/**
 * Regression tests for the persistence layer.
 *
 * The defect these exist for is a LOST UPDATE, not a crash and not corruption. `incrementPlayerStat`
 * read the current value and wrote `current + delta` back as two separate statements. Inside one
 * process that is safe by accident — better-sqlite3 is synchronous and Node is single-threaded, so
 * nothing can interleave between the read and the write — and it stops being safe the moment a
 * second process opens the same file, which `backend-eaddrinuse-zombie` makes reachable.
 *
 * Measured with two real processes against one database file, 400 increments each:
 * **407 of 800 landed; 393 were silently lost.** No error, no SQLITE_BUSY, integrity_check clean —
 * just missing kills. After the fix: 800 of 800.
 *
 * That cross-process measurement cannot be reproduced inside a single test process, so it is
 * recorded in REGRESSION_HISTORY.md and what is asserted here instead is the property that made the
 * fix work: the increment is ONE statement that computes the new value inside the database, and a
 * second connection to the same file cannot lose an update. The interleaving test below uses two
 * genuine connections, so it exercises real cross-connection semantics rather than mocking them.
 *
 * Run: npm test
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB = path.join(os.tmpdir(), `nova-database-${process.pid}.db`);
process.env.NOVA_DB_PATH = DB;

// Dynamic for the same reason as friends-auth.test.ts: `import` is hoisted above the assignment
// above, so a static import would resolve Config.DB_PATH to the REAL database. That mistake was
// actually made once — see REGRESSION_HISTORY.md.
let dbm: any;

function assertScratchDatabase(resolved: string): void {
  const real = path.resolve(__dirname, '..', 'data', 'nova.db');
  assert.notEqual(path.resolve(resolved), path.resolve(real), 'REFUSING TO RUN against the real database');
  assert.ok(path.resolve(resolved).startsWith(path.resolve(os.tmpdir())), `REFUSING TO RUN: ${resolved} is not a temp path`);
}

before(async () => {
  const { Config } = await import('./config');
  assertScratchDatabase(Config.DB_PATH);
  dbm = await import('./database');
  await dbm.initDatabase();
});

after(() => {
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { fs.unlinkSync(f); } catch { /* fine */ }
  }
});

describe('incrementPlayerStat', () => {
  test('creates the row when absent and accumulates', () => {
    dbm.incrementPlayerStat('acct-a', 'br_kills', 1);
    dbm.incrementPlayerStat('acct-a', 'br_kills', 4);
    assert.equal(dbm.getPlayerStats('acct-a').br_kills, 5);
  });

  test('handles a negative delta', () => {
    dbm.incrementPlayerStat('acct-b', 'br_score', 10);
    dbm.incrementPlayerStat('acct-b', 'br_score', -3);
    assert.equal(dbm.getPlayerStats('acct-b').br_score, 7);
  });

  test('does not disturb a sibling stat on the same account', () => {
    dbm.setPlayerStat('acct-c', 'br_matchesplayed', 42);
    dbm.incrementPlayerStat('acct-c', 'br_kills', 1);
    const s = dbm.getPlayerStats('acct-c');
    assert.equal(s.br_matchesplayed, 42);
    assert.equal(s.br_kills, 1);
  });

  test('sees writes made by another connection to the same file', () => {
    // Honest about its scope: this shows the two connections agree on the row, NOT that the update
    // is race-free. An earlier version of this test claimed the latter and was WRONG — it passed
    // against the old read-modify-write, because two synchronous calls in one process run strictly
    // one after the other and never interleave. Losing an update needs the other writer to land
    // BETWEEN this function's read and its write, which cannot happen inside a single-threaded
    // process. The cross-process proof is the harness recorded in REGRESSION_HISTORY.md
    // (407/800 before, 800/800 after); the structural guard below is what protects it here.
    const outsider = new Database(DB);
    try {
      outsider.prepare(
        `INSERT INTO player_stats (account_id, stat_name, stat_value, updated_at)
         VALUES (?, ?, 1, datetime('now'))
         ON CONFLICT(account_id, stat_name) DO UPDATE SET stat_value = stat_value + 1`,
      ).run('acct-race', 'br_kills');
    } finally {
      outsider.close();
    }
    dbm.incrementPlayerStat('acct-race', 'br_kills', 1);
    assert.equal(dbm.getPlayerStats('acct-race').br_kills, 2);
  });

  test('is a SINGLE atomic statement — no read-modify-write', () => {
    // This is the guard with teeth, verified by reverting the fix and watching it fail. A
    // read-then-write cannot be made safe across processes by any amount of care at the call site,
    // so the property worth pinning is structural: the new value is computed INSIDE the database.
    const src = fs.readFileSync(path.join(__dirname, 'database.ts'), 'utf8');
    const fn = src.match(/export function incrementPlayerStat[\s\S]*?\n}/)?.[0];
    assert.ok(fn, 'incrementPlayerStat not found');
    assert.ok(
      /ON CONFLICT[\s\S]*DO UPDATE SET stat_value = stat_value \+/.test(fn!),
      'incrementPlayerStat must increment via an UPSERT that adds inside SQL',
    );
    assert.ok(
      !/SELECT/i.test(fn!) && !/setPlayerStat\(/.test(fn!),
      'incrementPlayerStat must not read the current value and write it back — that loses updates '
      + 'across processes (measured: 393 of 800 increments lost)',
    );
  });
});

describe('idempotent seeding — a race must not throw', () => {
  // ensureAccount and getCurrency both SELECT, find nothing, then INSERT. Two processes can pass
  // that check together; with a bare INSERT the loser throws SQLITE_CONSTRAINT_PRIMARYKEY on a race
  // whose correct outcome is "the row exists now, which is what you wanted".
  test('ensureAccount tolerates the row appearing underneath it', () => {
    const outsider = new Database(DB);
    try {
      outsider.prepare('INSERT OR IGNORE INTO accounts (id, display_name) VALUES (?, ?)').run('acct-race2', 'other');
      assert.doesNotThrow(() => dbm.ensureAccount('acct-race2', 'mine'));
    } finally {
      outsider.close();
    }
  });

  test('getCurrency tolerates the row appearing underneath it', () => {
    const outsider = new Database(DB);
    try {
      outsider.prepare('INSERT OR IGNORE INTO currency (account_id, mtx_purchased, mtx_earned) VALUES (?, 1, 2)')
        .run('acct-race3');
      assert.doesNotThrow(() => dbm.getCurrency('acct-race3'));
    } finally {
      outsider.close();
    }
  });

  test('ensureAccount is idempotent and does not rename an existing account', () => {
    dbm.ensureAccount('acct-d', 'FirstName');
    dbm.ensureAccount('acct-d', 'SecondName');
    assert.equal(dbm.getAccount('acct-d').display_name, 'FirstName');
  });
});

describe('token storage', () => {
  test('purges expired tokens, keeps live ones', () => {
    // Nothing cleaned this table before: 201 rows on the real database, all 201 expired, oldest
    // from 2026-05-02. It grows with logins x players forever.
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const shim = dbm.getDatabase();

    shim.run('INSERT OR REPLACE INTO tokens (token, account_id, client_id, grant_type, expires_at) VALUES (?,?,?,?,?)',
      ['stale-1', 'acct-t', 'c', 'password', past]);
    shim.run('INSERT OR REPLACE INTO tokens (token, account_id, client_id, grant_type, expires_at) VALUES (?,?,?,?,?)',
      ['stale-2', 'acct-t', 'c', 'password', past]);
    shim.run('INSERT OR REPLACE INTO tokens (token, account_id, client_id, grant_type, expires_at) VALUES (?,?,?,?,?)',
      ['live-old', 'acct-t', 'c', 'password', future]);

    dbm.storeToken('live-new', 'acct-t', 'c', 'password', future);

    // exec() returns sql.js's shape: an ARRAY of result sets, each {columns, values}.
    const rows = shim.exec('SELECT token FROM tokens ORDER BY token')[0].values.map((r: any[]) => r[0]);
    assert.deepEqual(rows, ['live-new', 'live-old'], 'expired tokens must go, live ones must stay');
  });

  test('an expired token does not validate, purged or not', () => {
    const shim = dbm.getDatabase();
    shim.run('INSERT OR REPLACE INTO tokens (token, account_id, client_id, grant_type, expires_at) VALUES (?,?,?,?,?)',
      ['expired-check', 'acct-t', 'c', 'password', new Date(Date.now() - 1000).toISOString()]);
    assert.equal(dbm.validateToken('expired-check'), null);
  });
});

describe('the exec() shim', () => {
  test('a failing query does not leave the cached statement in raw mode', () => {
    // better-sqlite3's raw mode is sticky and SURVIVES A THROW — verified directly: after
    // `stmt.raw().all()` throws, a plain `stmt.all()` returns arrays instead of objects. The shim
    // resets it in a `finally` for that reason. Nothing today depends on it, which is precisely why
    // it is worth a test: the failure mode would be a silent shape change, not an error.
    const shim = dbm.getDatabase();
    const SQL = 'SELECT account_id, stat_name FROM player_stats WHERE account_id = ?';
    const before = shim.exec(SQL, ['acct-a']);
    assert.equal(before[0].columns[0], 'account_id');

    assert.throws(() => shim.exec(SQL, []), /parameter/i);

    const after = shim.exec(SQL, ['acct-a']);
    assert.deepEqual(after[0].columns, before[0].columns, 'the result shape must be unchanged after a failure');
    assert.deepEqual(after[0].values, before[0].values);
  });

  test('returns [] rather than an empty result set, as sql.js did', () => {
    const shim = dbm.getDatabase();
    assert.deepEqual(shim.exec('SELECT stat_value FROM player_stats WHERE account_id = ?', ['nobody']), []);
  });

  test('coerces undefined and boolean bindings the way sql.js did', () => {
    const shim = dbm.getDatabase();
    // better-sqlite3 throws on both; the shim normalises so the ~78 existing call sites keep working.
    assert.doesNotThrow(() => shim.run('INSERT OR REPLACE INTO accounts (id, display_name, email, banned) VALUES (?, ?, ?, ?)',
      ['acct-e', 'E', undefined, true]));
    assert.equal(dbm.getAccount('acct-e').banned, 1);
  });
});
