import path from 'path';
import fs from 'fs';

// Minimal .env loader (no dependency): populate process.env from "Main backend/.env" if present,
// without overriding variables already set in the real shell environment. Runs before the Config
// literal below reads process.env, so editing .env is enough to switch LOCAL ↔ GLOBAL.
(function loadDotEnv() {
  try {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
    console.log(`[Config] Loaded environment overrides from ${envPath}`);
  } catch { /* ignore a malformed .env */ }
})();

export const Config = {
  /** Server.
   *
   *  HTTP_PORT is env-overridable because in global P2P mode 3551 does NOT belong to this process:
   *  Cobalt hard-codes the game's redirect to 127.0.0.1:3551, and there nova-proxy sits, forwarding
   *  the game up to the shared coordinator. The local backend then runs alongside it as a HOST AGENT
   *  on NOVA_PORT (3552 by convention) — see COORDINATOR_URL below. Two processes cannot share a
   *  port, and when they raced for it the loser silently never came up. */
  HOST: '127.0.0.1',
  HTTP_PORT: parseInt(process.env.NOVA_PORT || '3551', 10),
  HTTPS_PORT: 443,
  XMPP_PORT: 5222,

  /** JWT */
  JWT_SECRET: 'nova-backend-secret-key-change-in-production',
  TOKEN_EXPIRY_HOURS: 8,

  /** Client IDs that Fortnite uses */
  FORTNITE_CLIENT_IDS: [
    'ec684b8c687f479fadea3cb2ad83f5c6', // Fortnite PC (S7-S8 era)
    '3446cd72694c4a4485d81b77adbb2141', // Fortnite PC (alt)
    '34a02cf8f4414e29b15921876da36f9a', // Fortnite (launcher)
  ],

  /** Target season config — build 7.40 is Chapter 1 Season 7 (Season 8 begins at 8.00) */
  SEASON_NUMBER: 7,
  CHAPTER_NUMBER: 1,
  BATTLE_PASS_LEVEL: 100,
  ACCOUNT_LEVEL: 1000,

  /** Game server the client is told to connect to after matchmaking (the Reboot gameserver host).
   *  Env-overridable so you can point at localhost (testing), a playit.gg tunnel (global), or the
   *  Dell box WITHOUT editing code:
   *    LOCAL  → leave unset (defaults to 127.0.0.1:7777)
   *    GLOBAL → NOVA_GAME_SERVER_IP=your-tunnel.playit.gg  NOVA_GAME_SERVER_PORT=12345          */
  GAME_SERVER_IP: process.env.NOVA_GAME_SERVER_IP || '127.0.0.1',
  GAME_SERVER_PORT: parseInt(process.env.NOVA_GAME_SERVER_PORT || '7777', 10),

  /** Reboot-style static routing table: comma-separated "address:port:playlist" entries. A player is
   *  routed to the entry whose playlist matches their ticket; anything unmatched falls back to
   *  GAME_SERVER_IP/PORT. Empty = every playlist uses the single GAME_SERVER above. Example:
   *    NOVA_GAME_SERVERS="127.0.0.1:7777:playlist_defaultsolo,127.0.0.1:7778:playlist_defaultduo"   */
  GAME_SERVERS: process.env.NOVA_GAME_SERVERS || '',

  /** WebSocket URL the client is handed for the matchmaking (MMS) service. Local uses the loopback
   *  redirect; global (Cloudflare Tunnel) would be wss://your-coordinator-domain.                   */
  MMS_URL: process.env.NOVA_MMS_URL || 'ws://127.0.0.1:3551',

  /** P2P host-election. When ON (NOVA_HOST_ELECTION=1): the first player to matchmake a playlist
   *  with no live gameserver is elected HOST (their launcher spins up the Reboot server); everyone
   *  else WAITS on the matchmaking screen until that server registers, then is routed to it. When
   *  OFF (default): behaves as a simple single-server setup (immediate Play, config/registered
   *  address) — keeps single-PC / LAN testing working unchanged.                                    */
  HOST_ELECTION: process.env.NOVA_HOST_ELECTION === '1',
  /** How long (ms) a player may sit on the matchmaking screen waiting for the host's server. */
  HOST_ELECTION_WAIT_MS: parseInt(process.env.NOVA_HOST_ELECTION_WAIT_MS || '150000', 10),

  /** The shared coordinator this backend answers to (NOVA_COORDINATOR), which is what turns it from
   *  a standalone backend into a HOST AGENT.
   *
   *  Empty (default) = standalone: this process serves the game itself and decides hosting from its
   *  own matchmaking demand — single-PC / LAN, unchanged.
   *
   *  Set = global P2P: the game talks to the coordinator (via nova-proxy), so ALL demand and the
   *  host election live there. This process stops deciding for itself and instead asks the
   *  coordinator "should I serve?" — it exists purely to run a gameserver on THIS machine when the
   *  coordinator elects it, because the coordinator is a Linux box and cannot run Fortnite. */
  COORDINATOR_URL: (process.env.NOVA_COORDINATOR || '').trim().replace(/\/+$/, ''),
  /** How often (ms) the host agent asks the coordinator whether it should be serving. */
  HOST_AGENT_POLL_MS: parseInt(process.env.NOVA_HOST_AGENT_POLL_MS || '3000', 10),

  /** How long (ms) after its first player a match still accepts new joiners. Past this the server
   *  is treated as "in progress" and the next player to press Play hosts a FRESH match instead of
   *  being dropped into one that already started. Time-based because the game server has no
   *  "the bus has flown" signal to report.
   *
   *  MUST stay comfortably BELOW the gameserver's warmup hold (Defines::WarmupWaitSeconds = 90s in
   *  the Reboot DLL), because a player routed here still has to load the map — roughly 30s. At 60s
   *  the last person we send still boards the bus; at 90s they would load in after it had left. If
   *  you raise the warmup hold, raise this too, keeping the same ~30s of headroom. */
  JOIN_WINDOW_MS: parseInt(process.env.NOVA_JOIN_WINDOW_MS || '60000', 10),

  /** Optional shared secret for gameserver registration. If set (NOVA_REGISTER_SECRET), the
   *  register/unregister endpoints require a matching `secret` in the body — prevents anyone who
   *  finds the public coordinator URL from poisoning the routing table. Empty = open (default). */
  REGISTER_SECRET: process.env.NOVA_REGISTER_SECRET || '',

  // ── Tailscale auto-mesh ────────────────────────────────────────────────────────────────────
  /** Tailscale auth key handed to authenticated launchers so they can join the tailnet silently.
   *  Generate a REUSABLE + EPHEMERAL + PRE-APPROVED key in the Tailscale admin console and set it
   *  as NOVA_TS_AUTHKEY. Empty = the mesh stays off and the launcher falls back to the old flow. */
  TS_AUTHKEY: process.env.NOVA_TS_AUTHKEY || '',
  /** Tailscale API access token (`tskey-api-…`) or OAuth client secret.
   *
   *  PREFERRED over TS_AUTHKEY. A plain auth key is SINGLE-USE unless it was explicitly created
   *  reusable, so the first machine that joins consumes it and every machine after that silently
   *  fails to reach the mesh — which looks like the mesh being broken rather than a spent key.
   *  With this set, the coordinator mints a FRESH key per request instead, so every machine gets
   *  its own and there is nothing to run out of. */
  TS_API_KEY: process.env.NOVA_TS_API_KEY || '',
  /** Tailnet to mint keys for. "-" means "the tailnet that owns the token", which is what you want
   *  unless the token belongs to more than one. */
  TS_TAILNET: process.env.NOVA_TS_TAILNET || '-',
  /** How long (ms) an announced machine stays "available to host" without re-announcing. */
  MESH_CANDIDATE_TTL_MS: parseInt(process.env.NOVA_MESH_TTL_MS || '90000', 10),
  /** How long (ms) to defer electing a weaker machine while a materially better one might step up.
   *  After this grace the weaker machine hosts anyway, so a match never stalls. */
  MESH_ELECTION_GRACE_MS: parseInt(process.env.NOVA_MESH_GRACE_MS || '20000', 10),

  // ── Anti-cheat ─────────────────────────────────────────────────────────────────────────────
  /** 24h accumulated severity at which an account is auto-banned. 0 (default) = detection only.
   *  Off by default on purpose: on a small private server, wrongly locking out a friend is worse
   *  than reviewing a real cheater a day later. */
  AC_AUTOBAN_AT: parseInt(process.env.NOVA_AC_AUTOBAN_AT || '0', 10),
  /** Shared secret for the anti-cheat admin views. Falls back to REGISTER_SECRET when unset; if
   *  BOTH are empty the admin endpoints refuse everyone rather than opening up. */
  AC_ADMIN_SECRET: process.env.NOVA_AC_ADMIN_SECRET || '',

  /** EOS (Epic Online Services) identifiers */
  EOS_DEPLOYMENT_ID: 'nova_deployment',
  EOS_PRODUCT_ID: 'prod-fn',
  EOS_SANDBOX_ID: 'fn',
  EOS_ORG_ID: 'nova_organization',

  /** Paths */
  DATA_DIR: path.resolve(__dirname, '..', 'data'),
  CERTS_DIR: path.resolve(__dirname, '..', 'certs'),
  CLOUDSTORAGE_DIR: path.resolve(__dirname, '..', 'data', 'cloudstorage'),
  PROFILES_DIR: path.resolve(__dirname, '..', 'data', 'profiles'),

  /** Database.
   *  NOVA_DB_PATH exists so a test run can be pointed at a scratch file. Without it every local
   *  experiment writes into the one real database, and "did my new endpoint work" and "did I just
   *  edit live player accounts" become the same question. */
  DB_PATH: process.env.NOVA_DB_PATH
    ? path.resolve(process.env.NOVA_DB_PATH)
    : path.resolve(__dirname, '..', 'data', 'nova.db'),

  /** Ensure directories exist */
  init() {
    const dirs = [this.DATA_DIR, this.CERTS_DIR, this.CLOUDSTORAGE_DIR, this.PROFILES_DIR];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }
} as const;
