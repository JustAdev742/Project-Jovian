// @ts-ignore
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import { Config } from './config';
import { generateUUID } from './utils/uuid';

let db: SqlJsDatabase;

export async function initDatabase(): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();

  // Load existing DB file if present
  if (fs.existsSync(Config.DB_PATH)) {
    const buffer = fs.readFileSync(Config.DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // ═══════════════════════════════════════════════
  //  CORE TABLES (existing)
  // ═══════════════════════════════════════════════
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      banned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      client_id TEXT,
      grant_type TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      host_account_id TEXT NOT NULL,
      playlist_id TEXT DEFAULT 'Playlist_DefaultSolo',
      region TEXT DEFAULT 'NAE',
      host_address TEXT,
      host_port INTEGER DEFAULT 7777,
      state TEXT DEFAULT 'WAITING',
      max_players INTEGER DEFAULT 100,
      created_at TEXT DEFAULT (datetime('now'))
    );
    -- LawinServer-style profile store: the WHOLE athena profile as one JSON blob per account.
    -- This is the source of truth for the locker — the client's exact EquipBattleRoyaleCustomization
    -- payload is written in and handed straight back on QueryProfile, so there is no dynamic rebuild
    -- and no GUID<->templateId translation to drift. Replaces the old normalized loadouts model.
    CREATE TABLE IF NOT EXISTS athena_profiles (
      account_id TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ═══════════════════════════════════════════════
  //  PHASE 1: NEW TABLES
  // ═══════════════════════════════════════════════

  // Player stats (replaces hardcoded buildStatsResponse)
  db.run(`
    CREATE TABLE IF NOT EXISTS player_stats (
      account_id TEXT NOT NULL,
      stat_name TEXT NOT NULL,
      stat_value INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, stat_name)
    );
  `);

  // Player inventory (owned items)
  db.run(`
    CREATE TABLE IF NOT EXISTS inventory (
      account_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      favorite INTEGER DEFAULT 0,
      item_seen INTEGER DEFAULT 1,
      acquired_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, item_id)
    );
  `);

  // Currency balances
  db.run(`
    CREATE TABLE IF NOT EXISTS currency (
      account_id TEXT PRIMARY KEY,
      mtx_purchased INTEGER DEFAULT 999999,
      mtx_earned INTEGER DEFAULT 0
    );
  `);

  // Friends list
  db.run(`
    CREATE TABLE IF NOT EXISTS friends (
      account_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      status TEXT DEFAULT 'accepted',
      direction TEXT DEFAULT 'outgoing',
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, friend_id)
    );
  `);

  // Achievements
  db.run(`
    CREATE TABLE IF NOT EXISTS achievements (
      account_id TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, achievement_id)
    );
  `);

  // Match history
  db.run(`
    CREATE TABLE IF NOT EXISTS match_history (
      match_id TEXT PRIMARY KEY,
      session_id TEXT,
      playlist_id TEXT,
      region TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      host_account_id TEXT
    );
  `);

  // Match participants (per-match stats for each player)
  db.run(`
    CREATE TABLE IF NOT EXISTS match_participants (
      match_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      kills INTEGER DEFAULT 0,
      placement INTEGER DEFAULT 0,
      xp_earned INTEGER DEFAULT 0,
      damage_dealt INTEGER DEFAULT 0,
      time_alive_seconds INTEGER DEFAULT 0,
      PRIMARY KEY (match_id, account_id)
    );
  `);

  // Saved loadouts (equipped cosmetics)
  db.run(`
    CREATE TABLE IF NOT EXISTS loadouts (
      account_id TEXT NOT NULL,
      slot_name TEXT NOT NULL,
      item_ids TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (account_id, slot_name)
    );
  `);

  // Telemetry events
  db.run(`
    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT,
      event_type TEXT NOT NULL,
      event_data TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Global config / title storage
  db.run(`
    CREATE TABLE IF NOT EXISTS global_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Anti-cheat: one row per detection. Kept as an append-only audit trail rather than a single
  // "suspicion score" column so a decision can always be explained after the fact.
  db.run(`
    CREATE TABLE IF NOT EXISTS anticheat_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      rule TEXT NOT NULL,
      severity INTEGER NOT NULL,
      detail TEXT,
      match_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Ensure default account
  const existing = db.exec("SELECT id FROM accounts WHERE id = 'nova-default-account'");
  if (existing.length === 0 || existing[0].values.length === 0) {
    db.run("INSERT INTO accounts (id, display_name, email) VALUES (?, ?, ?)",
      ['nova-default-account', 'NovaPlayer', 'nova@projectnova.local']);
  }

  saveDb();
  console.log('[Database] SQLite (sql.js) initialized with', 13, 'tables at', Config.DB_PATH);
  return db;
}

// Persistence is DEBOUNCED — a burst of mutations coalesces into one write instead of blocking
// the event loop on every mutation with a full-image export — and ATOMIC — written to a temp file
// then renamed, so a crash mid-write can't corrupt nova.db. Errors are logged, not swallowed.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let savePending = false;
let exitHookInstalled = false;

function writeDbToDisk(): void {
  if (!savePending || !db) return;
  savePending = false;
  try {
    const buffer = Buffer.from(db.export());
    const tmp = Config.DB_PATH + '.tmp';
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, Config.DB_PATH); // atomic replace on the same filesystem
  } catch (e: any) {
    console.error('[Database] Failed to persist DB:', e?.message || e);
    savePending = true; // keep it dirty so the next flush retries
  }
}

function saveDb(): void {
  savePending = true;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Best-effort synchronous flush of any pending write when the process exits.
    process.once('exit', () => { if (saveTimer) clearTimeout(saveTimer); writeDbToDisk(); });
  }
  if (saveTimer) return; // a flush is already scheduled
  saveTimer = setTimeout(() => { saveTimer = null; writeDbToDisk(); }, 200);
}

export function getDatabase(): SqlJsDatabase {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

// ═══════════════════════════════════════════════
//  ACCOUNTS
// ═══════════════════════════════════════════════

export function ensureAccount(accountId: string, displayName: string): string {
  const existing = db.exec("SELECT id FROM accounts WHERE id = ?", [accountId]);
  if (existing.length > 0 && existing[0].values.length > 0) return accountId;
  db.run("INSERT INTO accounts (id, display_name) VALUES (?, ?)", [accountId, displayName]);
  // Seed currency for new accounts
  db.run("INSERT OR IGNORE INTO currency (account_id, mtx_purchased, mtx_earned) VALUES (?, ?, ?)",
    [accountId, 999999, 0]);
  saveDb();
  return accountId;
}

// ═══════════════════════════════════════════════
//  ATHENA PROFILE BLOB (LawinServer-style store)
// ═══════════════════════════════════════════════

/** The account's whole athena profile as a JSON string, or null if it has never been seeded. */
export function getAthenaProfileJson(accountId: string): string | null {
  const r = db.exec("SELECT profile_json FROM athena_profiles WHERE account_id = ?", [accountId]);
  if (r.length === 0 || r[0].values.length === 0) return null;
  return r[0].values[0][0] as string;
}

/** Upsert the account's whole athena profile blob. Debounced atomic persist via saveDb(). */
export function saveAthenaProfileJson(accountId: string, json: string): void {
  db.run(
    `INSERT INTO athena_profiles (account_id, profile_json, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(account_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = datetime('now')`,
    [accountId, json]
  );
  saveDb();
}

export function getAccount(accountId: string): { id: string; display_name: string; email: string; banned: number } | undefined {
  const result = db.exec("SELECT id, display_name, email, banned FROM accounts WHERE id = ?", [accountId]);
  if (result.length === 0 || result[0].values.length === 0) return undefined;
  const row = result[0].values[0];
  return { id: row[0] as string, display_name: row[1] as string, email: row[2] as string, banned: row[3] as number };
}

/**
 * Reverse of getAccount: resolve a display name to its account id.
 * The gameserver only ever learns a joining player's DISPLAY name (it parses it out of the
 * connect URL), so this is how it gets from a player in a match back to a Nova account.
 */
export function getAccountIdByDisplayName(displayName: string): string | undefined {
  const result = db.exec("SELECT id FROM accounts WHERE display_name = ?", [displayName]);
  if (result.length === 0 || result[0].values.length === 0) return undefined;
  return result[0].values[0][0] as string;
}

// ═══════════════════════════════════════════════
//  TOKENS
// ═══════════════════════════════════════════════

export function storeToken(token: string, accountId: string, clientId: string, grantType: string, expiresAt: string): void {
  db.run("INSERT OR REPLACE INTO tokens (token, account_id, client_id, grant_type, expires_at) VALUES (?, ?, ?, ?, ?)",
    [token, accountId, clientId, grantType, expiresAt]);
  saveDb();
}

export function validateToken(token: string): string | null {
  const result = db.exec("SELECT account_id, expires_at FROM tokens WHERE token = ?", [token]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  const row = result[0].values[0];
  if (new Date(row[1] as string) < new Date()) return null;
  return row[0] as string;
}

// ═══════════════════════════════════════════════
//  PLAYER STATS
// ═══════════════════════════════════════════════

export function getPlayerStats(accountId: string): Record<string, number> {
  const result = db.exec("SELECT stat_name, stat_value FROM player_stats WHERE account_id = ?", [accountId]);
  const stats: Record<string, number> = {};
  if (result.length > 0) {
    for (const row of result[0].values) {
      stats[row[0] as string] = row[1] as number;
    }
  }
  return stats;
}

export function setPlayerStat(accountId: string, statName: string, value: number): void {
  db.run(
    "INSERT OR REPLACE INTO player_stats (account_id, stat_name, stat_value, updated_at) VALUES (?, ?, ?, datetime('now'))",
    [accountId, statName, value]
  );
  saveDb();
}

export function incrementPlayerStat(accountId: string, statName: string, delta: number): void {
  // Get current value first
  const result = db.exec("SELECT stat_value FROM player_stats WHERE account_id = ? AND stat_name = ?", [accountId, statName]);
  const current = (result.length > 0 && result[0].values.length > 0) ? (result[0].values[0][0] as number) : 0;
  setPlayerStat(accountId, statName, current + delta);
}

/** Seed default stats for a new player (all zeroes) */
export function seedDefaultStats(accountId: string): void {
  const existingStats = getPlayerStats(accountId);
  if (Object.keys(existingStats).length > 0) return; // Already seeded

  const modes = ['playlist_defaultsolo', 'playlist_defaultduo', 'playlist_defaultsquad'];
  const statTypes = ['br_placetop1', 'br_kills', 'br_matchesplayed', 'br_score', 'br_minutesplayed', 'br_lastmodified'];
  const placementStats: Record<string, string[]> = {
    'playlist_defaultsolo': ['br_placetop10', 'br_placetop25'],
    'playlist_defaultduo': ['br_placetop5', 'br_placetop12'],
    'playlist_defaultsquad': ['br_placetop3', 'br_placetop6'],
  };

  for (const mode of modes) {
    for (const stat of statTypes) {
      const key = `${stat}_keyboardmouse_m0_${mode}`;
      db.run("INSERT OR IGNORE INTO player_stats (account_id, stat_name, stat_value) VALUES (?, ?, ?)", [accountId, key, 0]);
    }
    for (const ps of (placementStats[mode] || [])) {
      const key = `${ps}_keyboardmouse_m0_${mode}`;
      db.run("INSERT OR IGNORE INTO player_stats (account_id, stat_name, stat_value) VALUES (?, ?, ?)", [accountId, key, 0]);
    }
  }
  saveDb();
}

// ═══════════════════════════════════════════════
//  LEADERBOARDS
// ═══════════════════════════════════════════════

export function getLeaderboard(statName: string, limit: number = 100, offset: number = 0): { accountId: string; value: number }[] {
  const result = db.exec(
    "SELECT account_id, stat_value FROM player_stats WHERE stat_name = ? ORDER BY stat_value DESC LIMIT ? OFFSET ?",
    [statName, limit, offset]
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any) => ({ accountId: row[0] as string, value: row[1] as number }));
}

// ═══════════════════════════════════════════════
//  INVENTORY
// ═══════════════════════════════════════════════

export function getInventory(accountId: string): { item_id: string; template_id: string; quantity: number; favorite: number; item_seen: number }[] {
  const result = db.exec(
    "SELECT item_id, template_id, quantity, favorite, item_seen FROM inventory WHERE account_id = ?",
    [accountId]
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any) => ({
    item_id: row[0] as string,
    template_id: row[1] as string,
    quantity: row[2] as number,
    favorite: row[3] as number,
    item_seen: row[4] as number,
  }));
}

export function addInventoryItem(accountId: string, templateId: string, itemId?: string, quantity: number = 1): string {
  const id = itemId || generateUUID().replace(/-/g, '');
  db.run(
    "INSERT OR IGNORE INTO inventory (account_id, item_id, template_id, quantity) VALUES (?, ?, ?, ?)",
    [accountId, id, templateId, quantity]
  );
  saveDb();
  return id;
}

export function removeInventoryItem(accountId: string, itemId: string): boolean {
  db.run("DELETE FROM inventory WHERE account_id = ? AND item_id = ?", [accountId, itemId]);
  saveDb();
  return true;
}

export function hasInventoryItem(accountId: string, templateId: string): boolean {
  const result = db.exec("SELECT item_id FROM inventory WHERE account_id = ? AND template_id = ?", [accountId, templateId]);
  return result.length > 0 && result[0].values.length > 0;
}

export function updateInventoryItemFlags(accountId: string, itemId: string, favorite?: boolean, itemSeen?: boolean): void {
  if (favorite !== undefined) {
    db.run("UPDATE inventory SET favorite = ? WHERE account_id = ? AND item_id = ?", [favorite ? 1 : 0, accountId, itemId]);
  }
  if (itemSeen !== undefined) {
    db.run("UPDATE inventory SET item_seen = ? WHERE account_id = ? AND item_id = ?", [itemSeen ? 1 : 0, accountId, itemId]);
  }
  saveDb();
}

// ═══════════════════════════════════════════════
//  CURRENCY
// ═══════════════════════════════════════════════

export function getCurrency(accountId: string): { mtx_purchased: number; mtx_earned: number } {
  const result = db.exec("SELECT mtx_purchased, mtx_earned FROM currency WHERE account_id = ?", [accountId]);
  if (result.length === 0 || result[0].values.length === 0) {
    // Seed new account with default currency
    db.run("INSERT INTO currency (account_id, mtx_purchased, mtx_earned) VALUES (?, ?, ?)", [accountId, 999999, 0]);
    saveDb();
    return { mtx_purchased: 999999, mtx_earned: 0 };
  }
  const row = result[0].values[0];
  return { mtx_purchased: row[0] as number, mtx_earned: row[1] as number };
}

export function updateCurrency(accountId: string, delta: number): boolean {
  const current = getCurrency(accountId);
  const total = current.mtx_purchased + current.mtx_earned;
  if (total + delta < 0) return false; // Insufficient funds

  // Deduct from earned first, then purchased
  if (delta < 0) {
    let remaining = Math.abs(delta);
    const earnedDeduct = Math.min(current.mtx_earned, remaining);
    remaining -= earnedDeduct;
    db.run("UPDATE currency SET mtx_purchased = mtx_purchased - ?, mtx_earned = mtx_earned - ? WHERE account_id = ?",
      [remaining, earnedDeduct, accountId]);
  } else {
    db.run("UPDATE currency SET mtx_earned = mtx_earned + ? WHERE account_id = ?", [delta, accountId]);
  }
  saveDb();
  return true;
}

// ═══════════════════════════════════════════════
//  FRIENDS
// ═══════════════════════════════════════════════

export function getFriends(accountId: string): { friend_id: string; status: string; direction: string; created_at: string }[] {
  const result = db.exec(
    "SELECT friend_id, status, direction, created_at FROM friends WHERE account_id = ?",
    [accountId]
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any) => ({
    friend_id: row[0] as string,
    status: row[1] as string,
    direction: row[2] as string,
    created_at: row[3] as string,
  }));
}

export function addFriend(accountId: string, friendId: string, status: string = 'pending'): void {
  db.run("INSERT OR REPLACE INTO friends (account_id, friend_id, status, direction) VALUES (?, ?, ?, 'outgoing')",
    [accountId, friendId, status]);
  db.run("INSERT OR REPLACE INTO friends (account_id, friend_id, status, direction) VALUES (?, ?, ?, 'incoming')",
    [friendId, accountId, status]);
  saveDb();
}

export function acceptFriend(accountId: string, friendId: string): void {
  db.run("UPDATE friends SET status = 'accepted' WHERE account_id = ? AND friend_id = ?", [accountId, friendId]);
  db.run("UPDATE friends SET status = 'accepted' WHERE account_id = ? AND friend_id = ?", [friendId, accountId]);
  saveDb();
}

export function removeFriend(accountId: string, friendId: string): void {
  db.run("DELETE FROM friends WHERE account_id = ? AND friend_id = ?", [accountId, friendId]);
  db.run("DELETE FROM friends WHERE account_id = ? AND friend_id = ?", [friendId, accountId]);
  saveDb();
}

export function blockUser(accountId: string, blockedId: string): void {
  removeFriend(accountId, blockedId); // Remove friendship first
  db.run("INSERT OR REPLACE INTO friends (account_id, friend_id, status, direction) VALUES (?, ?, 'blocked', 'outgoing')",
    [accountId, blockedId]);
  saveDb();
}

// ═══════════════════════════════════════════════
//  ACHIEVEMENTS
// ═══════════════════════════════════════════════

export function getAchievements(accountId: string): { achievement_id: string; unlocked_at: string }[] {
  const result = db.exec("SELECT achievement_id, unlocked_at FROM achievements WHERE account_id = ?", [accountId]);
  if (result.length === 0) return [];
  return result[0].values.map((row: any) => ({
    achievement_id: row[0] as string,
    unlocked_at: row[1] as string,
  }));
}

export function unlockAchievement(accountId: string, achievementId: string): boolean {
  const existing = db.exec("SELECT achievement_id FROM achievements WHERE account_id = ? AND achievement_id = ?",
    [accountId, achievementId]);
  if (existing.length > 0 && existing[0].values.length > 0) return false; // Already unlocked
  db.run("INSERT INTO achievements (account_id, achievement_id) VALUES (?, ?)", [accountId, achievementId]);
  saveDb();
  return true;
}

// ═══════════════════════════════════════════════
//  MATCH HISTORY
// ═══════════════════════════════════════════════

export function recordMatch(sessionId: string, playlistId: string, region: string, hostAccountId: string): string {
  const matchId = `match-${generateUUID()}`;
  db.run(
    "INSERT INTO match_history (match_id, session_id, playlist_id, region, host_account_id) VALUES (?, ?, ?, ?, ?)",
    [matchId, sessionId, playlistId, region, hostAccountId]
  );
  saveDb();
  return matchId;
}

export function endMatch(matchId: string): void {
  db.run("UPDATE match_history SET ended_at = datetime('now') WHERE match_id = ?", [matchId]);
  saveDb();
}

export function recordMatchParticipant(
  matchId: string, accountId: string, kills: number, placement: number,
  xpEarned: number, damageDealt: number, timeAlive: number
): void {
  db.run(
    "INSERT OR REPLACE INTO match_participants (match_id, account_id, kills, placement, xp_earned, damage_dealt, time_alive_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [matchId, accountId, kills, placement, xpEarned, damageDealt, timeAlive]
  );
  saveDb();
}

/** Who hosted a match and who was in it — the authority check for untrusted result reports. */
export function getMatchMeta(matchId: string): { hostAccountId: string | null; participants: string[] } | undefined {
  const m = db.exec("SELECT host_account_id FROM match_history WHERE match_id = ?", [matchId]);
  if (m.length === 0 || m[0].values.length === 0) return undefined;
  const p = db.exec("SELECT account_id FROM match_participants WHERE match_id = ?", [matchId]);
  return {
    hostAccountId: (m[0].values[0][0] as string) || null,
    participants: p.length === 0 ? [] : p[0].values.map((r: any) => r[0] as string),
  };
}

export function getMatchHistory(accountId: string, limit: number = 20): any[] {
  const result = db.exec(
    `SELECT mh.match_id, mh.playlist_id, mh.region, mh.started_at, mh.ended_at,
            mp.kills, mp.placement, mp.xp_earned, mp.damage_dealt, mp.time_alive_seconds
     FROM match_history mh
     JOIN match_participants mp ON mh.match_id = mp.match_id
     WHERE mp.account_id = ?
     ORDER BY mh.started_at DESC LIMIT ?`,
    [accountId, limit]
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any) => ({
    matchId: row[0], playlistId: row[1], region: row[2], startedAt: row[3], endedAt: row[4],
    kills: row[5], placement: row[6], xpEarned: row[7], damageDealt: row[8], timeAlive: row[9],
  }));
}

// ═══════════════════════════════════════════════
//  LOADOUTS
// ═══════════════════════════════════════════════

export function getLoadout(accountId: string): Record<string, string[]> {
  const result = db.exec("SELECT slot_name, item_ids FROM loadouts WHERE account_id = ?", [accountId]);
  const loadout: Record<string, string[]> = {};
  if (result.length > 0) {
    for (const row of result[0].values) {
      try { loadout[row[0] as string] = JSON.parse(row[1] as string); } catch { loadout[row[0] as string] = []; }
    }
  }
  return loadout;
}

export function setLoadoutSlot(accountId: string, slotName: string, itemIds: string[]): void {
  db.run(
    "INSERT OR REPLACE INTO loadouts (account_id, slot_name, item_ids) VALUES (?, ?, ?)",
    [accountId, slotName, JSON.stringify(itemIds)]
  );
  saveDb();
}

// ═══════════════════════════════════════════════
//  TELEMETRY
// ═══════════════════════════════════════════════

let telemetryInserts = 0;
export function logTelemetry(accountId: string | null, eventType: string, eventData: any): void {
  db.run(
    "INSERT INTO telemetry (account_id, event_type, event_data) VALUES (?, ?, ?)",
    [accountId, eventType, JSON.stringify(eventData)]
  );
  // Bound the table so an in-memory DB can't grow without limit (OOM). Trim occasionally rather
  // than on every insert. Keep the most recent 5000 events.
  if (++telemetryInserts % 200 === 0) {
    db.run("DELETE FROM telemetry WHERE id NOT IN (SELECT id FROM telemetry ORDER BY id DESC LIMIT 5000)");
  }
  // Don't saveDb on every telemetry event — too frequent. Batch save periodically via flushDb().
}

export function getTelemetry(accountId: string, limit: number = 50): any[] {
  const result = db.exec(
    "SELECT event_type, event_data, created_at FROM telemetry WHERE account_id = ? ORDER BY id DESC LIMIT ?",
    [accountId, limit]
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any) => ({
    eventType: row[0],
    eventData: row[1] ? JSON.parse(row[1] as string) : null,
    createdAt: row[2],
  }));
}

// ═══════════════════════════════════════════════
//  GLOBAL CONFIG
// ═══════════════════════════════════════════════

export function getGlobalConfig(key: string): string | null {
  const result = db.exec("SELECT value FROM global_config WHERE key = ?", [key]);
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0] as string;
}

export function setGlobalConfig(key: string, value: string): void {
  db.run("INSERT OR REPLACE INTO global_config (key, value, updated_at) VALUES (?, ?, datetime('now'))", [key, value]);
  saveDb();
}

// ═══════════════════════════════════════════════
//  SESSION MANAGEMENT (enhanced)
// ═══════════════════════════════════════════════

export function getSessionParticipants(sessionId: string): string[] {
  const result = db.exec(
    "SELECT account_id FROM match_participants WHERE match_id IN (SELECT match_id FROM match_history WHERE session_id = ?)",
    [sessionId]
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any) => row[0] as string);
}

// ═══════════════════════════════════════════════
//  ANTI-CHEAT
// ═══════════════════════════════════════════════

export function insertAnticheatFlag(
  accountId: string, rule: string, severity: number, detail: string, matchId?: string
): void {
  db.run(
    "INSERT INTO anticheat_flags (account_id, rule, severity, detail, match_id) VALUES (?, ?, ?, ?, ?)",
    [accountId, rule, severity, detail, matchId || null]
  );
  saveDb();
}

export function getAnticheatFlags(accountId?: string, limit: number = 100): {
  id: number; accountId: string; rule: string; severity: number; detail: string; matchId: string | null; createdAt: string;
}[] {
  const capped = Math.min(Math.max(limit, 1), 500);
  const result = accountId
    ? db.exec("SELECT id, account_id, rule, severity, detail, match_id, created_at FROM anticheat_flags WHERE account_id = ? ORDER BY id DESC LIMIT ?", [accountId, capped])
    : db.exec("SELECT id, account_id, rule, severity, detail, match_id, created_at FROM anticheat_flags ORDER BY id DESC LIMIT ?", [capped]);
  if (result.length === 0) return [];
  return result[0].values.map((r: any) => ({
    id: r[0] as number, accountId: r[1] as string, rule: r[2] as string, severity: r[3] as number,
    detail: r[4] as string, matchId: r[5] as string | null, createdAt: r[6] as string,
  }));
}

/** Total severity accumulated by an account in the last `hours` — the number enforcement acts on. */
export function getAnticheatRisk(accountId: string, hours: number = 24): number {
  const result = db.exec(
    "SELECT COALESCE(SUM(severity), 0) FROM anticheat_flags WHERE account_id = ? AND created_at > datetime('now', ?)",
    [accountId, `-${Math.max(1, hours)} hours`]
  );
  if (result.length === 0 || result[0].values.length === 0) return 0;
  return Number(result[0].values[0][0]) || 0;
}

export function setAccountBanned(accountId: string, banned: boolean): void {
  db.run("UPDATE accounts SET banned = ? WHERE id = ?", [banned ? 1 : 0, accountId]);
  saveDb();
}

/** Force an immediate atomic persist (used for periodic telemetry batching + shutdown), bypassing
 *  the debounce. */
export function flushDb(): void {
  savePending = true;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeDbToDisk();
}
