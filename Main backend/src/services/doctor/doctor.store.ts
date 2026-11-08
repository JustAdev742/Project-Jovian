/**
 * The fleet doctor store, on the coordinator: every reporting player, their live problem lines and
 * their latest doctor reports.
 *
 * Its own SQLite file (Config.DOCTOR_DB_PATH), not the account database: this is append-heavy
 * telemetry with retention, and keeping it apart means a burst here can never slow a login.
 *
 * Bounded by design — the coordinator is a home server:
 *   - live lines: newest LINES_PER_PLAYER per player, and LINES_TOTAL overall
 *   - reports:    newest REPORTS_PER_PLAYER per player (the full report stored gzipped)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { Config } from '../../config';
import type { LiveLine } from './doctor.validate';

export const RETENTION = { LINES_PER_PLAYER: 2000, LINES_TOTAL: 200_000, REPORTS_PER_PLAYER: 3 };

let db: Database.Database | null = null;
let insertsSincePrune = 0;

export function doctorDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(Config.DOCTOR_DB_PATH), { recursive: true });
  db = new Database(Config.DOCTOR_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      account_id TEXT PRIMARY KEY, display_name TEXT, launcher_version TEXT, machine TEXT,
      first_seen TEXT, last_seen TEXT, last_line_at TEXT, last_report_at TEXT,
      verdict TEXT, open_total INTEGER DEFAULT 0, p0 INTEGER DEFAULT 0, p1 INTEGER DEFAULT 0,
      lines_dropped INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, received_at TEXT NOT NULL,
      src TEXT, sev TEXT, rule TEXT, status TEXT, t TEXT, text TEXT
    );
    CREATE INDEX IF NOT EXISTS lines_by_player ON lines(account_id, id);
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, received_at TEXT NOT NULL,
      launcher_version TEXT, summary_json TEXT NOT NULL, full_gz BLOB
    );
    CREATE INDEX IF NOT EXISTS reports_by_player ON reports(account_id, id);
  `);
  return db;
}

/** Tests only: drop the handle so a fresh path can be opened. */
export function closeDoctorDb(): void {
  if (db) { db.close(); db = null; }
}

function touchPlayer(accountId: string, displayName: string, launcher: string, now: string) {
  doctorDb().prepare(`
    INSERT INTO players (account_id, display_name, launcher_version, first_seen, last_seen)
    VALUES (@a, @n, @v, @t, @t)
    ON CONFLICT(account_id) DO UPDATE SET
      display_name = excluded.display_name,
      launcher_version = COALESCE(NULLIF(excluded.launcher_version, ''), players.launcher_version),
      last_seen = excluded.last_seen
  `).run({ a: accountId, n: displayName, v: launcher, t: now });
}

export function recordLines(accountId: string, displayName: string, launcher: string, lines: LiveLine[], dropped: number): number {
  const d = doctorDb();
  const now = new Date().toISOString();
  const ins = d.prepare('INSERT INTO lines (account_id, received_at, src, sev, rule, status, t, text) VALUES (?,?,?,?,?,?,?,?)');
  d.transaction(() => {
    touchPlayer(accountId, displayName, launcher, now);
    for (const l of lines) ins.run(accountId, now, l.src, l.sev, l.rule, l.status, l.t, l.text);
    d.prepare('UPDATE players SET last_line_at = ?, lines_dropped = lines_dropped + ? WHERE account_id = ?')
      .run(lines.length ? now : null, Math.max(0, dropped | 0), accountId);
  })();
  insertsSincePrune += lines.length;
  if (insertsSincePrune >= 500) prune();
  return lines.length;
}

/** Keep each player's newest lines and the overall total bounded. Cheap: index-ordered deletes. */
export function prune(): void {
  const d = doctorDb();
  insertsSincePrune = 0;
  const players = d.prepare('SELECT account_id FROM players').all() as { account_id: string }[];
  const cut = d.prepare(`DELETE FROM lines WHERE account_id = ? AND id <= (
    SELECT id FROM lines WHERE account_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`);
  d.transaction(() => {
    for (const p of players) cut.run(p.account_id, p.account_id, RETENTION.LINES_PER_PLAYER);
    d.prepare('DELETE FROM lines WHERE id <= (SELECT id FROM lines ORDER BY id DESC LIMIT 1 OFFSET ?)').run(RETENTION.LINES_TOTAL);
  })();
}

export function recordReport(accountId: string, displayName: string, launcher: string, summary: any, full: object | null): void {
  const d = doctorDb();
  const now = new Date().toISOString();
  const fullGz = full ? zlib.gzipSync(Buffer.from(JSON.stringify(full))) : null;
  const sev = summary?.summary?.bySeverity || {};
  d.transaction(() => {
    touchPlayer(accountId, displayName, launcher, now);
    d.prepare('INSERT INTO reports (account_id, received_at, launcher_version, summary_json, full_gz) VALUES (?,?,?,?,?)')
      .run(accountId, now, launcher, JSON.stringify(summary), fullGz);
    d.prepare(`UPDATE players SET last_report_at = ?, machine = ?, verdict = ?, open_total = ?, p0 = ?, p1 = ? WHERE account_id = ?`)
      .run(now, summary?.machine || null, summary?.verdict?.lead || null, summary?.summary?.open || 0, sev.P0 || 0, sev.P1 || 0, accountId);
    d.prepare(`DELETE FROM reports WHERE account_id = ? AND id <= (
      SELECT id FROM reports WHERE account_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(accountId, accountId, RETENTION.REPORTS_PER_PLAYER);
  })();
}

export interface PlayerRow {
  account_id: string; display_name: string; launcher_version: string | null; machine: string | null;
  first_seen: string; last_seen: string; last_line_at: string | null; last_report_at: string | null;
  verdict: string | null; open_total: number; p0: number; p1: number; lines_dropped: number;
}

export function listPlayers(): PlayerRow[] {
  return doctorDb().prepare('SELECT * FROM players ORDER BY last_seen DESC').all() as PlayerRow[];
}

export function getPlayer(accountId: string): PlayerRow | undefined {
  return doctorDb().prepare('SELECT * FROM players WHERE account_id = ?').get(accountId) as PlayerRow | undefined;
}

export function latestReport(accountId: string): { receivedAt: string; summary: any; full: any | null } | null {
  const row = doctorDb().prepare('SELECT received_at, summary_json, full_gz FROM reports WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(accountId) as any;
  if (!row) return null;
  return {
    receivedAt: row.received_at,
    summary: JSON.parse(row.summary_json),
    full: row.full_gz ? JSON.parse(zlib.gunzipSync(row.full_gz).toString('utf8')) : null,
  };
}

export interface LineRow extends LiveLine { id: number; account_id: string; received_at: string; display_name?: string }

/** Lines after `since` (oldest first), or the newest `limit` when since = 0. */
export function linesSince(since: number, opts: { accountId?: string; limit?: number; minSev?: string } = {}): LineRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.accountId) { where.push('l.account_id = ?'); args.push(opts.accountId); }
  if (opts.minSev) {
    const order = ['P0', 'P1', 'P2', 'P3', 'INFO'];
    const allowed = order.slice(0, order.indexOf(opts.minSev) + 1);
    if (allowed.length) { where.push(`l.sev IN (${allowed.map(() => '?').join(',')})`); args.push(...allowed); }
  }
  const base = `SELECT l.*, p.display_name FROM lines l LEFT JOIN players p ON p.account_id = l.account_id`;
  const w = where.length ? ` AND ${where.join(' AND ')}` : '';
  if (since > 0) {
    return doctorDb().prepare(`${base} WHERE l.id > ?${w} ORDER BY l.id ASC LIMIT ?`).all(since, ...args, limit) as LineRow[];
  }
  const rows = doctorDb().prepare(`${base} WHERE 1=1${w} ORDER BY l.id DESC LIMIT ?`).all(...args, limit) as LineRow[];
  return rows.reverse();
}

/** Problems across the fleet, from each player's latest summary: who has what. */
export type FleetProblem = { key: string; title: string; severity: string; players: number; occurrences: number; who: { id: string; name: string }[] };
export function fleetProblems(): FleetProblem[] {
  const rows = doctorDb().prepare(`
    SELECT r.account_id, r.summary_json, p.display_name FROM reports r
    JOIN (SELECT account_id, MAX(id) AS id FROM reports GROUP BY account_id) m ON m.id = r.id
    LEFT JOIN players p ON p.account_id = r.account_id`).all() as any[];
  const agg = new Map<string, FleetProblem>();
  for (const r of rows) {
    let s: any;
    try { s = JSON.parse(r.summary_json); } catch { continue; }
    for (const f of s.top || []) {
      // Group by the finding id + discriminator, not the full key, so the same problem on two
      // machines is one row even when a per-machine detail differs.
      const k = String(f.key || f.id);
      const e = agg.get(k) || { key: k, title: f.title, severity: f.severity, players: 0, occurrences: 0, who: [] as FleetProblem['who'] };
      e.players += 1;
      if (e.who.length < 20) e.who.push({ id: r.account_id, name: r.display_name || String(r.account_id).slice(0, 8) });
      e.occurrences += Number(f.count) || 0;
      agg.set(k, e);
    }
  }
  const order = ['P0', 'P1', 'P2', 'P3', 'INFO'];
  return [...agg.values()].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || b.players - a.players || b.occurrences - a.occurrences);
}
