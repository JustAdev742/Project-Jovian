/**
 * Durable backing for the diagnostics aggregate.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────────────────────────
 *
 * The aggregate lived only in memory, which meant the single most valuable record in the system —
 * what was failing in the seconds before a crash — was the one record guaranteed not to survive it.
 * A restart also wiped the history, so "did this start after the last deploy?" was unanswerable, and
 * `DIAGNOSTIC_COVERAGE.md` listed it as the largest gap.
 *
 * ── THE SHAPE, AND WHY IT IS NOT WRITE-THROUGH ───────────────────────────────────────────────────
 *
 * `recordDiagnostic` runs on error paths, including inside the `uncaughtException` handler. A
 * synchronous SQLite write per event would put disk I/O on the hot path of a process that is already
 * failing, and a 500-error storm would become a 500-write storm.
 *
 * So: memory stays authoritative for reads, writes are marked dirty, and a timer flushes the changed
 * rows in ONE transaction. The exposure is bounded by the flush interval, not by the event rate.
 *
 * Two things close the remaining window:
 *   - `flushNow()` is called from the crash handler, so the last thing before a crash is written by
 *     the crash itself. That is the whole point; a store that persists everything except the crash
 *     would miss the only record nobody can reproduce.
 *   - The flush is idempotent. Replaying it writes the same rows, so a double flush during shutdown
 *     cannot corrupt or double-count anything.
 *
 * ── BOUNDED, ON DISK AS WELL AS IN MEMORY ────────────────────────────────────────────────────────
 *
 * `MAX_ROWS` caps the table. Pruning drops the least useful first — lowest count, then oldest — for
 * the same reason the in-memory evictor does: a noisy low-severity row must never push out a rare
 * high-severity one. Unbounded disk growth on a coordinator nobody watches is how a diagnostic
 * system becomes the outage.
 */
import { getDatabase } from '../../database';

/** One persisted aggregate row. Mirrors the in-memory entry, minus the parts that do not survive. */
export interface PersistedDiagnostic {
  key: string;
  category: string;
  source: string;
  component: string;
  method: string;
  route: string;
  subsystem: string;
  version: string;
  status?: number;
  detail?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Distinct affected users, already hashed by the aggregate. A number, never the identities. */
  users: number;
}

const MAX_ROWS = 2000;

let ready = false;

/**
 * Create the table. Safe to call repeatedly.
 *
 * Returns false rather than throwing when the database is unavailable — diagnostics degrading to
 * in-memory-only is a bad day; diagnostics preventing the backend from starting is a worse one.
 */
export function initDiagnosticStore(): boolean {
  try {
    const db = getDatabase();
    db.run(`
      CREATE TABLE IF NOT EXISTS diagnostics (
        key         TEXT PRIMARY KEY,
        category    TEXT NOT NULL,
        source      TEXT NOT NULL,
        component   TEXT,
        method      TEXT NOT NULL,
        route       TEXT NOT NULL,
        subsystem   TEXT,
        version     TEXT,
        status      INTEGER,
        detail      TEXT,
        count       INTEGER NOT NULL DEFAULT 0,
        first_seen  TEXT NOT NULL,
        last_seen   TEXT NOT NULL,
        users       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_diagnostics_last_seen ON diagnostics(last_seen);
    `);
    ready = true;
    return true;
  } catch (e: any) {
    console.warn(`[Diagnostics] durable store unavailable (${e?.message || e}) — memory only`);
    ready = false;
    return false;
  }
}

/** Everything on disk, newest activity first. Used to rehydrate the aggregate at startup. */
export function loadPersisted(): PersistedDiagnostic[] {
  if (!ready) return [];
  try {
    const rows = getDatabase().exec(
      `SELECT key, category, source, component, method, route, subsystem, version,
              status, detail, count, first_seen, last_seen, users
         FROM diagnostics ORDER BY last_seen DESC LIMIT ?`,
      [MAX_ROWS],
    );
    if (!rows.length || !rows[0].values) return [];
    return rows[0].values.map((v: any[]) => ({
      key: String(v[0]), category: String(v[1]), source: String(v[2]),
      component: String(v[3] ?? ''), method: String(v[4]), route: String(v[5]),
      subsystem: String(v[6] ?? ''), version: String(v[7] ?? 'unknown'),
      status: v[8] === null || v[8] === undefined ? undefined : Number(v[8]),
      detail: v[9] === null || v[9] === undefined ? undefined : String(v[9]),
      count: Number(v[10]) || 0, firstSeen: String(v[11]), lastSeen: String(v[12]),
      users: Number(v[13]) || 0,
    }));
  } catch (e: any) {
    console.warn(`[Diagnostics] could not load persisted diagnostics: ${e?.message || e}`);
    return [];
  }
}

/**
 * Write these rows, replacing whatever is there for the same keys.
 *
 * ON CONFLICT ... DO UPDATE rather than INSERT OR REPLACE: the latter deletes and re-inserts, which
 * would churn the index and lose the row's identity on every flush.
 *
 * THE COUNTERS ARE MONOTONIC, AND THAT IS NOT A DETAIL. The obvious version — `count=excluded.count`
 * — loses history the moment the in-memory aggregate evicts a key: memory is capped at 400 distinct
 * problems, so a rare failure can be dropped, recur, restart from 1, and overwrite a disk row that
 * said 5,000. `MAX` makes the stored count "the highest this key has ever reached", which is the
 * only reading that is stable across eviction. `first_seen` takes `MIN` for the same reason: when
 * something first went wrong must not move forward because memory forgot.
 *
 * Deliberate reset stays possible, and stays explicit: `clearPersisted()`.
 */
export function persist(rows: PersistedDiagnostic[]): number {
  if (!ready || rows.length === 0) return 0;
  try {
    const db = getDatabase();
    db.run('BEGIN');
    try {
      for (const r of rows) {
        db.run(
          `INSERT INTO diagnostics
             (key, category, source, component, method, route, subsystem, version,
              status, detail, count, first_seen, last_seen, users)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET
             count=MAX(excluded.count, diagnostics.count),
             users=MAX(excluded.users, diagnostics.users),
             first_seen=MIN(excluded.first_seen, diagnostics.first_seen),
             last_seen=MAX(excluded.last_seen, diagnostics.last_seen),
             status=excluded.status, detail=excluded.detail`,
          [
            r.key, r.category, r.source, r.component ?? '', r.method, r.route,
            r.subsystem ?? '', r.version ?? 'unknown',
            r.status ?? null, r.detail ?? null,
            r.count, r.firstSeen, r.lastSeen, r.users,
          ],
        );
      }
      db.run('COMMIT');
    } catch (inner) {
      // A half-written flush would leave counts inconsistent with memory, which is worse than a
      // skipped one — memory is authoritative and the next flush rewrites everything dirty anyway.
      try { db.run('ROLLBACK'); } catch { /* the transaction is already gone */ }
      throw inner;
    }
    prune();
    return rows.length;
  } catch (e: any) {
    console.warn(`[Diagnostics] flush failed: ${e?.message || e}`);
    return 0;
  }
}

/**
 * Keep the table under MAX_ROWS, dropping the least useful first.
 *
 * Order matters and mirrors the in-memory evictor: lowest count first, oldest as the tiebreak. A
 * single CRITICAL row seen twice is worth more than a LOW row seen 4,000 times, and an evictor that
 * sorted by recency alone would delete exactly the rare thing you kept the store for.
 */
function prune(): void {
  try {
    const db = getDatabase();
    const c = db.exec('SELECT COUNT(*) FROM diagnostics');
    const total = Number(c?.[0]?.values?.[0]?.[0] ?? 0);
    if (total <= MAX_ROWS) return;
    db.run(
      `DELETE FROM diagnostics WHERE key IN (
         SELECT key FROM diagnostics ORDER BY count ASC, last_seen ASC LIMIT ?
       )`,
      [total - MAX_ROWS],
    );
  } catch {
    // Pruning is housekeeping. Failing it must not fail the flush that just succeeded.
  }
}

/** Wipe the table. Test hook, and the only way to reset history deliberately. */
export function clearPersisted(): void {
  if (!ready) return;
  try { getDatabase().run('DELETE FROM diagnostics'); } catch { /* nothing to clear */ }
}

/** How many rows are on disk. Exposed so the dashboard can show whether persistence is working. */
export function persistedCount(): number {
  if (!ready) return 0;
  try {
    const c = getDatabase().exec('SELECT COUNT(*) FROM diagnostics');
    return Number(c?.[0]?.values?.[0]?.[0] ?? 0);
  } catch {
    return 0;
  }
}

export function storeReady(): boolean {
  return ready;
}
