import { FastifyInstance } from 'fastify';
import { promises as dns } from 'dns';
import { requireAuth } from '../../middleware/auth.middleware';
import { generateUUID } from '../../utils/uuid';
import { Config } from '../../config';
import { setHostSpec, hostStatus, stopServer, markServerInjected } from './hostRunner';
import { lobbyProximityScore, regionLabel } from './regions';

// ═══════════════════════════════════════════════════════════════════════════
//  NOVA MATCHMAKING  —  gameserver routing table + P2P host registry
// ───────────────────────────────────────────────────────────────────────────
//  The client can't host a match; a real Fortnite server (Project Reboot game-
//  server DLL) hosts it. This module's job is to hand every player a *reachable
//  gameserver address* for their playlist. Servers come from three sources, in
//  priority order:
//    1. LIVE registrations  — a running host announces itself via
//       POST /nova/api/gameserver/register  (+ heartbeats). This is the global
//       path: the host runs behind a free playit.gg tunnel and registers that
//       public address, so friends anywhere can connect.
//    2. STATIC table        — Config.GAME_SERVERS ("addr:port:playlist,…").
//    3. CONFIG fallback     — Config.GAME_SERVER_IP/PORT (defaults 127.0.0.1:7777),
//       which guarantees single-machine / LAN testing always resolves to *something*.
// ═══════════════════════════════════════════════════════════════════════════

interface GameServerEntry {
  address: string;              // what the client connects to (IP or tunnel host)
  port: number;
  playlist: string;             // lowercased playlist id, or '*' for any
  region: string;               // region code, or '*' for any
  source: 'static' | 'dynamic'; // static = from config, dynamic = live registration
  name: string;
  players: number;
  maxPlayers: number;
  status: 'ready' | 'starting';
  lastSeen: number;             // ms epoch of last heartbeat/registration
}

/** Registered gameservers, keyed by `address:port:playlist`. */
const gameServers = new Map<string, GameServerEntry>();

/** A live (dynamic) server is dropped if it hasn't heartbeat within this window. */
const DYNAMIC_TTL_MS = 60 * 1000;

/**
 * Mint a single-use Tailscale auth key, one per machine that asks.
 *
 * Replaces handing out one static key forever. Keys are created:
 *   • single-use   — each machine gets its own, so there is no shared secret to leak or exhaust
 *   • pre-approved — the device joins without an admin clicking Approve, which is the whole point
 *                    of the launcher doing this silently
 *   • NOT ephemeral — an ephemeral node is removed when it goes offline, which would drop a host
 *                    from the tailnet the moment it closed the launcher
 *   • 90 minutes   — long enough to cover a slow install-and-reboot, short enough that a key
 *                    captured in a log is worthless by the time anyone reads it
 *
 * Accepts either a `tskey-api-…` access token or an OAuth client secret; both are Bearer tokens
 * against the same endpoint. Tailnet "-" means "whichever tailnet owns this token".
 */
async function mintTailnetKey(): Promise<string> {
  const url = `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(Config.TS_TAILNET)}/keys`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Config.TS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      capabilities: { devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [] } } },
      expirySeconds: 5400,
      description: 'Project Nova launcher (auto-minted)',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // Read the body: Tailscale explains refusals properly (bad scope, unknown tailnet, tag policy),
    // and "HTTP 403" on its own sends you looking in the wrong place.
    const detail = await res.text().catch(() => '');
    throw new Error(`Tailscale API ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  const body: any = await res.json();
  const key = body?.key;
  if (typeof key !== 'string' || !key) throw new Error('Tailscale API returned no key');
  return key;
}

function serverKey(address: string, port: number, playlist: string): string {
  return `${address}:${port}:${playlist}`;
}

/** Load the static "addr:port:playlist" routing table from config (once, at startup). */
function loadStaticServers(): void {
  const raw = (Config.GAME_SERVERS || '').trim();
  if (!raw) return;
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const bits = seg.split(':');
    const address = (bits[0] || '').trim();
    if (!address) continue;
    const port = parseInt(bits[1] || '7777', 10);
    const playlist = (bits[2] || '*').trim().toLowerCase();
    const key = serverKey(address, port, playlist);
    gameServers.set(key, {
      address, port, playlist, region: '*', source: 'static',
      name: 'Nova (static)', players: 0, maxPlayers: 100, status: 'ready', lastSeen: Date.now(),
    });
    console.log(`[Matchmaking] Static gameserver: ${address}:${port} playlist=${playlist}`);
  }
}
loadStaticServers();

/**
 * Register (or heartbeat) a dynamic gameserver programmatically.
 *
 * The HTTP endpoint is for hosts announcing themselves over the network; this is the same operation
 * for a server THIS backend started itself (see hostRunner), where going out over HTTP to our own
 * port would be pointless indirection.
 */
export function registerDynamicServer(
  address: string, port: number, playlist: string, region: string, name: string,
  status: 'ready' | 'starting' = 'ready',
): void {
  const pl = (playlist || '*').toLowerCase();
  const key = serverKey(address, port, pl);
  const existing = gameServers.get(key);
  gameServers.set(key, {
    address, port, playlist: pl,
    region: (region || '*').toUpperCase(),
    source: 'dynamic',
    name,
    players: existing?.players ?? 0,
    maxPlayers: existing?.maxPlayers ?? 100,
    status,
    lastSeen: Date.now(),
  });
  if (!existing) {
    console.log(`[Matchmaking] Registered gameserver ${address}:${port} playlist=${pl} status=${status}`);
  }
  // Same rule as the HTTP registration path: a server that is still booting has NOT satisfied the
  // host election, so it must not release the reservation. See the note there.
  if (status === 'ready') clearPendingForServer(pl);
}

/** Remove a dynamic server this backend registered. */
export function unregisterDynamicServer(address: string, port: number, playlist: string): void {
  const key = serverKey(address, port, (playlist || '*').toLowerCase());
  if (gameServers.delete(key)) {
    matchOpenedAt.delete(key);
    console.log(`[Matchmaking] Unregistered gameserver ${address}:${port}`);
  }
}

/** A server is usable if static, or dynamic and not expired. */
function isLive(e: GameServerEntry): boolean {
  return e.source === 'static' || (Date.now() - e.lastSeen) < DYNAMIC_TTL_MS;
}

// ───────────────────────────────────────────────────────────────────────────
//  JOINABILITY — "is there a server I can actually get into right now?"
//  A server being ALIVE is not the same as being JOINABLE. If it's full, or its match already
//  started, sending another player there means they load in and sit there broken. In that case the
//  right answer is for a new host to spin up a fresh match instead.
// ───────────────────────────────────────────────────────────────────────────

/** serverKey → when the first player was routed to it (i.e. when its match effectively began). */
const matchOpenedAt = new Map<string, number>();

/** Stamp the join window the first time a player is routed to this server. */
function markMatchOpened(e?: GameServerEntry): void {
  if (!e) return;
  const key = serverKey(e.address, e.port, e.playlist);
  if (!matchOpenedAt.has(key)) {
    matchOpenedAt.set(key, Date.now());
    console.log(`[Matchmaking] Match opened on ${e.address}:${e.port} — joinable for ${Math.round(Config.JOIN_WINDOW_MS / 1000)}s`);
  }
}

/** How many players we've actually routed to this server (sessions are per playlist/region, and a
 *  server serves a playlist/region — so the session player count IS its occupancy). Falls back to
 *  whatever the host self-reported, whichever is higher. */
function occupancyFor(e: GameServerEntry): number {
  let n = 0;
  for (const s of activeSessions.values()) {
    const plOk = e.playlist === '*' || s.playlistId.toLowerCase() === e.playlist;
    const rgOk = e.region === '*' || (s.region || '').toUpperCase() === e.region;
    if (plOk && rgOk) n += s.players.length;
  }
  return Math.max(n, e.players || 0);
}

/** Has this server's match been running long enough that new players can no longer join it?
 *  Time-based on purpose: the game server doesn't report "the bus has flown", and a wrong guess
 *  here only costs an extra host, whereas routing someone into a started match strands them. */
function matchInProgress(e: GameServerEntry): boolean {
  const opened = matchOpenedAt.get(serverKey(e.address, e.port, e.playlist));
  return !!opened && (Date.now() - opened) > Config.JOIN_WINDOW_MS;
}

function isJoinable(e: GameServerEntry): boolean {
  if (!isLive(e) || e.status !== 'ready') return false;
  // `|| 100` would be wrong here: a server reporting maxPlayers = 0 is FULL, not unconfigured.
  const max = Number.isFinite(e.maxPlayers) ? e.maxPlayers : 100;
  if (occupancyFor(e) >= max) return false;
  if (matchInProgress(e)) return false;
  return true;
}

/** Rank candidates: open slots first, then live/dynamic over static, then freshest. */
function pickBest(list: GameServerEntry[]): GameServerEntry | undefined {
  if (list.length === 0) return undefined;
  return [...list].sort((a, b) => {
    const aOpen = a.players < a.maxPlayers ? 0 : 1;
    const bOpen = b.players < b.maxPlayers ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    if (a.source !== b.source) return a.source === 'dynamic' ? -1 : 1;
    return b.lastSeen - a.lastSeen;
  })[0];
}

/**
 * Resolve the gameserver a player should be sent to.
 * @param playlist optional playlist id (matched case-insensitively; '*' servers match anything)
 * Always returns a connectable address — never null — falling back to the config server so a
 * fresh single-machine setup still works with zero registration.
 */
function resolveGameServer(
  playlist?: string,
  region?: string,
  requireJoinable = false
): { address: string; port: number; entry?: GameServerEntry } {
  const pl = (playlist || '').toLowerCase();
  const rg = (region || '').toUpperCase();
  // requireJoinable = "I'm placing a NEW player" → full / already-started servers don't count.
  // Otherwise = "where does this already-placed player connect?" → any live server is fine.
  const ready = requireJoinable
    ? [...gameServers.values()].filter(isJoinable)
    : [...gameServers.values()].filter(isLive).filter(e => e.status === 'ready');

  const regionOk = (e: GameServerEntry) => e.region === '*' || !rg || e.region === rg;
  const byPlaylist = pl ? ready.filter(e => e.playlist === pl && regionOk(e)) : [];
  const anyPlaylist = ready.filter(e => e.playlist === '*' && regionOk(e));

  const pick = pickBest(byPlaylist) || pickBest(anyPlaylist) || pickBest(ready);
  if (pick) return { address: pick.address, port: pick.port, entry: pick };

  // No registered server → config single-server fallback (localhost by default).
  return { address: Config.GAME_SERVER_IP, port: Config.GAME_SERVER_PORT };
}

/** Purge expired dynamic servers. */
function reapDeadServers(): void {
  for (const [key, e] of gameServers) {
    if (e.source === 'dynamic' && (Date.now() - e.lastSeen) >= DYNAMIC_TTL_MS) {
      gameServers.delete(key);
      // Drop its join window too — otherwise the map grows forever, and if the same
      // address:port hosts again it would be born already "in progress".
      matchOpenedAt.delete(key);
      // And release the host-election reservation this server satisfied. Without this, a host that
      // dies WITHOUT unregistering (crash, power cut, killed process) keeps every other machine
      // answered with 'another-host-pending' for the full HOST_ELECTION_WAIT_MS — 150 seconds during
      // which nobody can be elected and every waiting player times out of matchmaking.
      clearPendingForServer(e.playlist);
      console.log(`[Matchmaking] Dropped stale gameserver ${e.address}:${e.port} (no heartbeat)`);
    }
  }
}
setInterval(reapDeadServers, 30 * 1000);

// ───────────────────────────────────────────────────────────────────────────
//  P2P HOST ELECTION
//  The LAUNCHER (not the game) decides host-vs-join at launch by calling
//  GET /nova/api/matchmaking/should-i-host. If no live server exists for a playlist, the first
//  caller is elected host (its launcher spins up the Reboot gameserver + playit + registers).
//  A short-lived "pending host" reservation stops a second launcher from also hosting during the
//  boot window; it clears when a server registers or after HOST_ELECTION_WAIT_MS.
// ───────────────────────────────────────────────────────────────────────────

/** `since` = when the slot was claimed (absolute cap). `lastSeen` = when the holder last asked,
 *  which is what detects a holder that has crashed or been closed. See decideHost. */
interface PendingHost { accountId: string; since: number; lastSeen: number; }
/** How long a reservation survives without its holder polling. The host agent polls every
 *  HOST_AGENT_POLL_MS (3s), so 15s is five missed polls — long enough to ride out a hiccup, short
 *  enough that a crashed host does not strand everyone else in matchmaking. */
const RESERVATION_IDLE_MS = 15_000;
const pendingHosts = new Map<string, PendingHost>(); // key: `${playlist}:${region}`

function playlistKey(playlist: string, region: string): string {
  return `${(playlist || '').toLowerCase()}:${(region || '').toUpperCase()}`;
}

/** True if a real (registered/static) gameserver is live for this playlist — not just the config
 *  fallback. The MMS handler uses this to gate the Play frame while the host's server boots. */
// ───────────────────────────────────────────────────────────────────────────
//  LIVE MATCHMAKING DEMAND
//
//  "Demand" = players sitting in matchmaking RIGHT NOW, i.e. someone has pressed Play in-game. The
//  MMS websocket is an exact signal for this: it opens when the client enters matchmaking and closes
//  when it leaves, so the count is always the number of players actually waiting.
//
//  This exists so the launcher can start a gameserver in response to a real in-game Play press, and
//  shut it down once nobody is waiting and the host has left — instead of starting one eagerly at
//  launcher-Play time and keeping it alive for the launcher's whole lifetime.
// ───────────────────────────────────────────────────────────────────────────

interface Waiter { since: number; playlist: string; region: string; }
const waitingPlayers = new Map<number, Waiter>();
let waiterSeq = 0;

/** A client entered matchmaking (MMS websocket opened). Returns a handle for matchmakingEnded(). */
export function matchmakingStarted(playlist?: string, region?: string): number {
  const id = ++waiterSeq;
  waitingPlayers.set(id, {
    since: Date.now(),
    playlist: (playlist || '').toLowerCase(),
    region: (region || '').toUpperCase(),
  });
  console.log(`[Matchmaking] player entered matchmaking (${waitingPlayers.size} waiting)`);
  return id;
}

/** A client left matchmaking (MMS websocket closed, joined, or timed out). */
export function matchmakingEnded(id: number): void {
  if (waitingPlayers.delete(id)) {
    console.log(`[Matchmaking] player left matchmaking (${waitingPlayers.size} waiting)`);
  }
}

/**
 * A waiter is only ever removed when its websocket closes — so a HALF-OPEN socket (the machine slept,
 * the network dropped, the game crashed without a FIN) leaves one behind forever. That single ghost
 * makes `needsHost` permanently true, which means a host is elected for nobody and the gameserver
 * never reaches its idle path and never shuts down.
 *
 * Nothing legitimately waits longer than the matchmaker's own timeout — it closes the socket at
 * HOST_ELECTION_WAIT_MS — so anything past that plus a generous margin is a leak, not a player.
 */
const WAITER_MAX_AGE_MS = Config.HOST_ELECTION_WAIT_MS + 90 * 1000;

function reapStaleWaiters(): void {
  const now = Date.now();
  for (const [id, w] of waitingPlayers) {
    if (now - w.since > WAITER_MAX_AGE_MS) {
      waitingPlayers.delete(id);
      console.log(`[Matchmaking] Dropped a stale matchmaking waiter (socket never closed; ${waitingPlayers.size} left)`);
    }
  }
}
setInterval(reapStaleWaiters, 30 * 1000).unref?.();

/**
 * What the launcher polls. `needsHost` is the actionable bit: somebody is waiting to play and there
 * is no live server for them, so this machine should start one.
 */
export function getHostDemand(playlist?: string, region?: string): {
  waiting: number; needsHost: boolean; oldestWaitMs: number; hasServer: boolean;
} {
  const now = Date.now();
  const waiters = [...waitingPlayers.values()];
  const oldest = waiters.reduce((acc, w) => Math.min(acc, w.since), now);
  const hasServer = hasLiveGameServer(playlist, region);
  return {
    waiting: waiters.length,
    hasServer,
    needsHost: waiters.length > 0 && !hasServer,
    oldestWaitMs: waiters.length ? now - oldest : 0,
  };
}

/**
 * Is there a live server at this exact address:port, whatever playlist it registered under?
 *
 * Distinct from hasLiveGameServer on purpose: that one asks "can a NEW player join something?", which
 * goes false the moment a match starts. A host asking "am I still the one serving?" must get yes for
 * as long as its process is up — otherwise the coordinator would tell it to stand down mid-match and
 * elect a second host for the players already in it.
 */
function findServerAt(address: string, port: number): GameServerEntry | undefined {
  for (const e of gameServers.values()) {
    if (e.address === address && e.port === port) return e;
  }
  return undefined;
}

export function hasLiveGameServer(playlist?: string, region?: string): boolean {
  // Deliberately JOINABLE, not merely live. The MMS handler uses this to decide when to release a
  // waiting player into the match — releasing them into a full or already-started server is exactly
  // the case we're trying to avoid. When this is false, decideHost() elects a new host instead.
  return !!resolveGameServer(playlist, region, true).entry;
}

// ───────────────────────────────────────────────────────────────────────────
//  TAILSCALE AUTO-MESH — candidate registry + capability-based host selection
//  Every launcher announces itself on login with its Tailscale IP and machine specs. When a match
//  needs a host we pick the BEST-SUITED announced machine rather than simply whoever pressed Play
//  first — and if that better machine never steps up, the grace timer lets the caller host anyway
//  so a match can never stall.
// ───────────────────────────────────────────────────────────────────────────

interface MeshCandidate {
  accountId: string;
  tsIp: string;      // 100.x Tailscale IP — numeric, so the game can always parse it
  cpuCores: number;
  ramGB: number;
  netScore: number;  // 0-100, measured launcher-side
  /** Where this machine is. Drives proximity in the election — see electionScore. Older launchers
   *  don't send it; those candidates score neutrally rather than being excluded. */
  region: string;
  score: number;     // hardware only; the election combines this with proximity
  lastSeen: number;
}

const meshCandidates = new Map<string, MeshCandidate>(); // key: accountId
/** When we first deferred an election for a playlist (so a better machine can take the host role). */
const electionDeferredSince = new Map<string, number>();

/** Weighted capability score. CPU and RAM dominate — they decide whether a Reboot server can
 *  actually hold a lobby — with network quality as a modifier. */
function scoreCandidate(cpuCores: number, ramGB: number, netScore: number): number {
  const cpu = Math.min(Math.max(cpuCores, 0), 16) / 16;
  const ram = Math.min(Math.max(ramGB, 0), 32) / 32;
  const net = Math.min(Math.max(netScore, 0), 100) / 100;
  return Math.round((cpu * 45 + ram * 35 + net * 20) * 100) / 100;
}

/** The regions of everyone currently waiting for this playlist — the people a host has to serve. */
function waitingRegions(playlist: string, region: string): string[] {
  const pl = (playlist || '').toLowerCase();
  const rg = (region || '').toUpperCase();
  return [...waitingPlayers.values()]
    .filter((w) => (!pl || !w.playlist || w.playlist === pl) && (!rg || !w.region || w.region === rg))
    .map((w) => w.region)
    .filter(Boolean);
}

/**
 * What the election actually ranks on: can this machine run a server, AND will it feel good to play on.
 *
 * PROXIMITY DOMINATES, AND THAT IS THE POINT. Hardware decides whether a Reboot server can hold a
 * lobby at all, which is a threshold rather than a gradient — past "enough", more RAM buys nothing a
 * player can feel. Distance is the opposite: it is felt continuously and cannot be compensated for.
 * A mid-range PC two hops away beats a monster on another continent every time, so the weights say
 * so — 65% proximity, 35% hardware.
 *
 * Worked example. A 4-core/8GB machine in-region scores ~0.35×30 + 0.65×100 = 75. A 16-core/32GB
 * machine 250ms away scores ~0.35×95 + 0.65×0 = 33. The local mid-range machine wins decisively,
 * which is the correct answer and the opposite of what the old hardware-only score returned.
 *
 * WHEN EVERYONE IS IN ONE REGION — the normal case today — every candidate gets proximity 100 and
 * this collapses to the old hardware ranking, scaled. Existing single-country setups are unaffected.
 */
function electionScore(c: MeshCandidate, waiterRegions: string[]): number {
  const prox = lobbyProximityScore(c.region, waiterRegions);
  return Math.round((usefulHardware(c.score) * 0.35 + prox * 0.65) * 100) / 100;
}

/**
 * Hardware SATURATES. Weighting the raw score linearly was wrong, and testing caught it.
 *
 * With a linear weight, a lobby of three Europeans and one Australian elected the AUSTRALIAN host,
 * because its 16-core/32GB machine outscored a European 4-core/8GB box by ~3× on hardware and that
 * swamped the proximity gap. Three players were being given 206ms so one could have a beefier host.
 * That is exactly the failure this whole change exists to prevent.
 *
 * The mistake was treating hardware as a gradient when it is really a threshold: a machine either
 * can carry a 100-player Reboot server or it cannot, and above that line more RAM buys nothing any
 * player can perceive. h/(h+15) encodes that — a modest 4c/8GB machine already reaches ~70, a
 * top-end one ~87. Better hardware still wins between equally-placed candidates, but it can no
 * longer purchase its way past a continent.
 */
function usefulHardware(hwScore: number): number {
  const h = Math.max(0, hwScore);
  return Math.round((100 * h) / (h + 15) * 100) / 100;
}

/** Announced machines that are still within their TTL (expired ones are reaped here). */
function liveCandidates(): MeshCandidate[] {
  const now = Date.now();
  for (const [k, c] of meshCandidates) {
    if (now - c.lastSeen > Config.MESH_CANDIDATE_TTL_MS) meshCandidates.delete(k);
  }
  return [...meshCandidates.values()];
}

/** The Tailscale IP a given account announced (used so a host registers its 100.x address). */
export function meshIpFor(accountId: string): string | null {
  const c = meshCandidates.get(accountId);
  return c && c.tsIp ? c.tsIp : null;
}

/** Decide whether the caller should host or join, reserving a pending-host slot if it hosts.
 *  Capability-aware: if a materially better machine is announced and available, defer briefly so it
 *  can take the host role — but never longer than MESH_ELECTION_GRACE_MS, so a match can't stall. */
function decideHost(
  accountId: string,
  playlist: string,
  region: string
): { host: boolean; reason: string; betterHost?: string; retryMs?: number; score?: number } {
  if (hasLiveGameServer(playlist, region)) return { host: false, reason: 'live-server-exists' };

  const key = playlistKey(playlist, region);
  const pending = pendingHosts.get(key);

  /* A RESERVATION MUST DIE WHEN ITS HOLDER STOPS ASKING.
   *
   * This used to expire only on a fixed 150s timer from the moment it was made. A machine that won
   * the election and then never delivered — crashed on load, was closed, failed to launch — kept the
   * slot locked for the full 150 seconds, and every other player was told "another-host-pending" and
   * sat in matchmaking watching nothing happen. Seen exactly that: one PC pressed Play at 05:47:51
   * and was blocked until 05:50:21 by a laptop that had been crashing all afternoon.
   *
   * The holder polls should-i-serve every 3s while it is genuinely working on it (HOST_AGENT_POLL_MS),
   * so silence is a reliable signal that it is gone. Two conditions now, and either frees the slot:
   *
   *   • IDLE  — no poll from the holder for RESERVATION_IDLE_MS. Catches the crash case in seconds
   *             instead of minutes, which is the whole point.
   *   • TOTAL — the original absolute cap, kept so a machine that keeps polling forever while stuck
   *             "booting" cannot hold the slot indefinitely.
   */
  const now = Date.now();
  const idleFor = pending ? now - (pending.lastSeen ?? pending.since) : 0;
  const expired = !!pending && (
    idleFor > RESERVATION_IDLE_MS ||
    (now - pending.since) > Config.HOST_ELECTION_WAIT_MS
  );

  if (pending && expired && pending.accountId !== accountId) {
    console.log(
      `[Mesh] Releasing stale host reservation for ${key} held by ${pending.accountId} ` +
      `(idle ${Math.round(idleFor / 1000)}s) — it never delivered a server.`,
    );
    pendingHosts.delete(key);
  }

  // Someone else is genuinely bringing a server up for this playlist.
  if (pending && !expired && pending.accountId !== accountId) {
    return { host: false, reason: 'another-host-pending' };
  }

  // The holder is still asking — keep its claim alive.
  if (pending && pending.accountId === accountId) {
    pending.lastSeen = now;
  }

  // Belt and braces: a server that has REGISTERED but is still booting is also "someone bringing a
  // server up", even if its reservation has since expired. Without this, a host that takes longer
  // than HOST_ELECTION_WAIT_MS to reach the lobby loses its claim and a second machine is elected
  // on top of it — the same double-host, just via a slower route.
  // Same playlist/region semantics resolveGameServer uses: '*' matches anything.
  const pl = (playlist || '').toLowerCase();
  const rg = (region || '').toUpperCase();
  const booting = [...gameServers.values()].some(
    (e) =>
      isLive(e) &&
      e.status === 'starting' &&
      (e.playlist === '*' || e.playlist === pl) &&
      (e.region === '*' || !rg || e.region === rg),
  );
  if (booting) {
    return { host: false, reason: 'another-host-pending' };
  }

  // Selection among announced mesh machines — capability AND proximity, see electionScore.
  const candidates = liveCandidates();
  const waiters = waitingRegions(playlist, region);
  const me = candidates.find(c => c.accountId === accountId);
  const scored = candidates.map(c => ({ c, s: electionScore(c, waiters) }));
  const bestEntry = scored.reduce<{ c: MeshCandidate; s: number } | null>(
    (b, e) => (!b || e.s > b.s ? e : b), null);
  const best = bestEntry?.c ?? null;
  const myScore = me ? electionScore(me, waiters) : undefined;

  if (best && me && myScore !== undefined && bestEntry && best.accountId !== accountId && bestEntry.s > myScore * 1.15) {
    const since = electionDeferredSince.get(key) ?? Date.now();
    electionDeferredSince.set(key, since);
    if (Date.now() - since < Config.MESH_ELECTION_GRACE_MS) {
      // A clearly better machine is online — give it a moment to take the host role. "Better" now
      // means better FOR THE PEOPLE WAITING, so this can defer to a slower machine that is closer,
      // which is the intended behaviour rather than a regression.
      console.log(
        `[Mesh] Deferring to ${best.accountId} (${regionLabel(best.region)}) — ` +
        `score ${bestEntry.s} vs ${myScore} for ${waiters.length} waiter(s)`,
      );
      return { host: false, reason: 'better-host-available', betterHost: best.accountId, retryMs: 5000, score: myScore };
    }
    // Grace elapsed and the better machine never stepped up — host here rather than stall.
  }

  electionDeferredSince.delete(key);
  // Preserve `since` when the SAME machine re-reserves. The holder polls every 3s, so overwriting it
  // each time would push the absolute cap forward forever and it would never fire — the very thing it
  // exists to prevent. Only `lastSeen` moves on a re-poll.
  const prev = pendingHosts.get(key);
  pendingHosts.set(key, {
    accountId,
    since: prev && prev.accountId === accountId ? prev.since : Date.now(),
    lastSeen: Date.now(),
  });
  return { host: true, reason: 'elected', score: myScore };
}

/** Clear pending-host reservations satisfied by a newly-registered server. */
function clearPendingForServer(playlist: string): void {
  if (playlist === '*') { pendingHosts.clear(); return; }
  const pl = playlist.toLowerCase();
  for (const [k] of pendingHosts) { if (k.startsWith(pl + ':')) pendingHosts.delete(k); }
}

// ───────────────────────────────────────────────────────────────────────────
//  Lightweight session tracking (for the admin list / player counts). The
//  address the client actually uses is always resolved live from the registry.
// ───────────────────────────────────────────────────────────────────────────

interface GameSession {
  sessionId: string;
  playlistId: string;
  region: string;
  players: string[];
  createdAt: Date;
}

const activeSessions = new Map<string, GameSession>();
const playerSessionMap = new Map<string, string>();

/** The client's build id (bucketId[0]); echoed back so the client accepts the session. */
let lastBuildUniqueId = '0';

/**
 * Chapter 1-era clients can put a NUMERIC playlist id in the bucketId instead of a name — 7.40 is
 * in that band. Left unmapped, a ticket for "2" never matches a gameserver registered as
 * "Playlist_DefaultSolo", so the player sits on the matchmaking screen while a perfectly good
 * server is sitting idle. Names are passed through untouched.
 */
const NUMERIC_PLAYLISTS: Record<string, string> = {
  '2': 'Playlist_DefaultSolo',
  '10': 'Playlist_DefaultDuo',
  '9': 'Playlist_DefaultSquad',
  '11': 'Playlist_Fill_Squads',
  '50': 'Playlist_50v50',
};

function normalisePlaylist(playlist: string): string {
  return NUMERIC_PLAYLISTS[playlist.trim()] || playlist;
}

function findSessionForPlaylist(playlistId: string, region: string): GameSession | undefined {
  for (const [, s] of activeSessions) {
    if (s.playlistId === playlistId && s.region === region) return s;
  }
  return undefined;
}

function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [id, s] of activeSessions) {
    if (now - s.createdAt.getTime() > 30 * 60 * 1000) {
      for (const p of s.players) playerSessionMap.delete(p);
      activeSessions.delete(id);
    }
  }
}
setInterval(cleanupStaleSessions, 5 * 60 * 1000);

export async function matchmakingRoutes(fastify: FastifyInstance): Promise<void> {

  // ═══════════════════════════════════════════════
  //  MATCHMAKING TICKET (queue entry point)
  // ═══════════════════════════════════════════════

  fastify.get('/fortnite/api/matchmaking/session/findPlayer/:accountId', async (_req, reply) => {
    return reply.send([]);
  });

  /**
   * GET /fortnite/api/game/v2/matchmakingservice/ticket/player/:accountId
   * The player asks for a matchmaking ticket. We resolve the gameserver for their
   * playlist and hand back the MMS websocket URL; the MMS state machine then walks
   * the client Connecting → … → Play, after which it fetches session info below.
   */
  fastify.get('/fortnite/api/game/v2/matchmakingservice/ticket/player/:accountId', {
    preHandler: requireAuth,
  }, async (request, reply) => {
    const accountId = (request as any).accountId;
    const displayName = (request as any).displayName || 'NovaPlayer';
    const query = request.query as Record<string, string>;
    const bucketParts = (query['bucketId'] || '').split(':');
    const region = bucketParts[2] || query['player.option.preferredRegion'] || 'NAE';
    const playlistId = normalisePlaylist(bucketParts[3] || query.playlistId || 'Playlist_DefaultSolo');
    // Remember the client's build id (bucketId[0]); a missing/mismatched buildUniqueId
    // in the session response makes the client discard the session before connecting.
    if (bucketParts[0]) lastBuildUniqueId = bucketParts[0];

    // Drop the player from any previous session.
    const prev = playerSessionMap.get(accountId);
    if (prev) {
      const s = activeSessions.get(prev);
      if (s) {
        s.players = s.players.filter(p => p !== accountId);
        if (s.players.length === 0) activeSessions.delete(prev);
      }
      playerSessionMap.delete(accountId);
    }

    // Resolve which gameserver this player will be sent to.
    const gs = resolveGameServer(playlistId, region);

    // Track the session (grouped by playlist/region) for the admin list & counts.
    let session = findSessionForPlaylist(playlistId, region);
    if (!session) {
      session = {
        sessionId: `nova-session-${generateUUID()}`,
        playlistId, region, players: [], createdAt: new Date(),
      };
      activeSessions.set(session.sessionId, session);
    }
    if (!session.players.includes(accountId)) session.players.push(accountId);
    playerSessionMap.set(accountId, session.sessionId);

    // First player routed here starts this match's join window; later arrivals are only accepted
    // while it's still open (see matchInProgress).
    markMatchOpened(gs.entry);

    console.log(`[Matchmaking] ${displayName} → ${gs.address}:${gs.port} (${playlistId}/${region}) via ${gs.entry ? gs.entry.source : 'config-fallback'}`);

    return reply.send({
      serviceUrl: Config.MMS_URL,
      ticketType: 'mms-player',
      payload: JSON.stringify({
        playerId: accountId,
        partyPlayerIds: [accountId],
        bucketId: query['bucketId'] || '',
        attributes: { 'player.option.partyId': generateUUID() },
        expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
        nonce: generateUUID(),
        sessionId: session.sessionId,
        serverAddress: gs.address,
        serverPort: gs.port,
        playlistId,
        region,
      }),
      signature: generateUUID(),
    });
  });

  // ═══════════════════════════════════════════════
  //  SESSION INFO
  // ═══════════════════════════════════════════════

  // The client hits this to obtain the session JOIN KEY (not the server address);
  // it expects exactly { accountId, sessionId, key }.
  fastify.get('/fortnite/api/game/v2/matchmaking/account/:accountId/session/:sessionId', async (request, reply) => {
    const { accountId, sessionId } = request.params as { accountId: string; sessionId: string };
    return reply.send({ accountId, sessionId, key: 'none' });
  });

  // The client fetches the actual server address + settings here. The sessionId is
  // minted by the MMS handler, so it usually isn't in activeSessions — we resolve the
  // gameserver live from the registry regardless.
  fastify.get('/fortnite/api/matchmaking/session/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const s = activeSessions.get(sessionId);
    return reply.send(buildSessionResponse(sessionId, s));
  });

  fastify.post('/fortnite/api/matchmaking/session/:sessionId/join', async (_req, reply) => {
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════
  //  GAMESERVER REGISTRY  (the P2P host announces itself here)
  // ═══════════════════════════════════════════════

  /**
   * POST /nova/api/gameserver/register
   * A running gameserver (or the launcher's host helper) announces a connectable
   * address. For LOCAL: { address:"127.0.0.1", port:7777 }. For GLOBAL via playit.gg:
   * { address:"your-tunnel.playit.gg", port:45678 }. Call again periodically to
   * heartbeat (or it expires after 60s). playlist defaults to '*' (serves everything).
   */
  fastify.post('/nova/api/gameserver/register', async (request, reply) => {
    const b = (request.body || {}) as any;
    if (Config.REGISTER_SECRET && b.secret !== Config.REGISTER_SECRET) {
      return reply.status(403).send({ error: 'invalid or missing registration secret' });
    }
    let address = String(b.address || '').trim();
    if (!address) return reply.status(400).send({ error: 'address required' });
    // Fortnite parses serverAddress as a NUMERIC IP — it won't resolve/parse a hostname (e.g. a
    // playit *.ply.gg address → "Failed to parse ip address" / FindSessionFailure). Resolve
    // hostnames to an IPv4 here so the client always gets an IP it can connect to (this also
    // sidesteps any client-side DNS blocking).
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address) && !address.includes(':')) {
      try {
        const ips = await dns.resolve4(address);
        if (ips && ips[0]) { console.log(`[Matchmaking] Resolved host ${address} → ${ips[0]}`); address = ips[0]; }
      } catch (e: any) {
        console.warn(`[Matchmaking] Could not resolve ${address}: ${e?.message}`);
      }
    }
    const port = parseInt(String(b.port ?? 7777), 10);
    const playlist = String(b.playlist || '*').trim().toLowerCase();
    const region = String(b.region || '*').trim().toUpperCase();
    const key = serverKey(address, port, playlist);
    const existing = gameServers.get(key);
    const entry: GameServerEntry = {
      address, port, playlist, region,
      source: 'dynamic',
      name: String(b.name || existing?.name || 'Nova host'),
      players: Number.isFinite(+b.players) ? +b.players : (existing?.players || 0),
      maxPlayers: Number.isFinite(+b.maxPlayers) ? +b.maxPlayers : (existing?.maxPlayers || 100),
      status: b.status === 'starting' ? 'starting' : 'ready',
      lastSeen: Date.now(),
    };
    gameServers.set(key, entry);
    // Only a READY server releases the host reservation.
    //
    // This used to clear on any registration, including `starting`. That opened a window nobody
    // was guarding: the reservation was gone, but joinability requires status 'ready', and a
    // Fortnite server takes 60-90 seconds to get there. Any second machine polling in between saw
    // "someone is waiting, no joinable server, nobody reserved" and was elected too — so one
    // waiting player produced two servers, and the second machine started hosting the moment its
    // launcher opened, before its own player had finished loading.
    if (entry.status === 'ready') clearPendingForServer(playlist);
    if (!existing) console.log(`[Matchmaking] Gameserver registered: ${address}:${port} playlist=${playlist} region=${region} status=${entry.status}`);
    return reply.send({ success: true, key, ttlMs: DYNAMIC_TTL_MS });
  });

  /** POST /nova/api/gameserver/unregister  { address, port, playlist? } */
  fastify.post('/nova/api/gameserver/unregister', async (request, reply) => {
    const b = (request.body || {}) as any;
    if (Config.REGISTER_SECRET && b.secret !== Config.REGISTER_SECRET) {
      return reply.status(403).send({ error: 'invalid or missing registration secret' });
    }
    const address = String(b.address || '').trim();
    const port = parseInt(String(b.port ?? 7777), 10);
    const playlist = String(b.playlist || '*').trim().toLowerCase();

    // "*" means "this machine is no longer hosting ANYTHING" — remove every entry for that
    // address:port whatever playlist it registered under. A leaving host does not know (and should
    // not have to remember) which playlist keys it created, and a failed unregister is expensive:
    // the dead server lingers in the registry and should-i-host keeps routing players to it until
    // the 60s TTL expires, so they sit on the matchmaking screen and time out.
    let removed = 0;
    const affectedPlaylists: string[] = [];
    if (playlist === '*') {
      for (const [key, entry] of [...gameServers.entries()]) {
        if (entry.address === address && entry.port === port) {
          gameServers.delete(key);
          matchOpenedAt.delete(key);
          affectedPlaylists.push(entry.playlist);
          removed++;
        }
      }
    } else {
      const key = serverKey(address, port, playlist);
      if (gameServers.delete(key)) {
        matchOpenedAt.delete(key);
        affectedPlaylists.push(playlist);
        removed++;
      }
    }

    // Also drop any pending-host reservation for those playlists, so the next player to press Play
    // is elected immediately instead of waiting on a host that has gone.
    for (const pl of affectedPlaylists) clearPendingForServer(pl);

    if (removed > 0) {
      console.log(`[Matchmaker] Unregistered ${address}:${port} (${removed} entr${removed === 1 ? 'y' : 'ies'})`);
    }
    return reply.send({ success: removed > 0, removed });
  });

  /** GET /nova/api/gameservers  — list the routing table (for the launcher/admin UI). */
  fastify.get('/nova/api/gameservers', async (_request, reply) => {
    const servers = [...gameServers.values()]
      .filter(isLive)
      .map(e => ({
        address: e.address, port: e.port, playlist: e.playlist, region: e.region,
        source: e.source, name: e.name, players: e.players, maxPlayers: e.maxPlayers,
        status: e.status, ageSec: Math.round((Date.now() - e.lastSeen) / 1000),
      }));
    const active = resolveGameServer();
    return reply.send({ servers, count: servers.length, resolvedDefault: active });
  });

  /**
   * GET /nova/api/matchmaking/should-i-host?accountId=&playlist=&region=
   * The LAUNCHER calls this at launch to decide whether to spin up the Reboot gameserver (host)
   * or just launch the player's client (join). Reserves a pending-host slot on election.
   */
  /**
   * GET /nova/api/matchmaking/host-demand?playlist=&region=
   * Live count of players sitting in matchmaking, and whether one of them needs a server started.
   * The launcher polls this so hosting follows the in-game Play press.
   */
  /**
   * POST /nova/api/host/config
   * The launcher hands over the exact command for a headless server on this machine, and the
   * backend takes over the server's lifecycle from there: started when the in-game Play press
   * creates demand and there is nothing to join, stopped when nobody is matchmaking any more.
   * Body: { exe, cwd, args[], env?[], port?, playlist?, region?, address? }  — send null to clear.
   */
  fastify.post('/nova/api/host/config', async (request, reply) => {
    const body = request.body as any;
    if (body === null || body?.clear === true) {
      // Stop BEFORE clearing. The spec holds the address and port this machine published, so
      // clearing it first left the shutdown path with nothing to unregister — the server was killed
      // but stayed advertised on the coordinator until its 60s heartbeat TTL expired, and every
      // player who matchmade in that window was routed to an address with nothing behind it.
      stopServer('launcher cleared the host config');
      setHostSpec(null);
      return reply.send({ ok: true, cleared: true });
    }
    const res = setHostSpec(body);
    if (!res.ok) return reply.status(400).send({ ok: false, error: res.error });
    return reply.send({ ok: true, ...hostStatus() });
  });

  /** GET /nova/api/host/status — is this machine hosting, and since when. */
  fastify.get('/nova/api/host/status', async (_request, reply) => {
    return reply.send(hostStatus());
  });

  /**
   * POST /nova/api/host/ready
   * The launcher has injected the Reboot DLL. That does NOT make the process joinable — it has to
   * scan signatures, set the playlist and call InitListen first, which takes another ~13 seconds. The
   * server is advertised as 'starting' until it says so itself in its own output (see READY_MARKERS
   * in hostRunner); treating injection as readiness dropped players into a world that did not exist
   * yet, at hardcoded fallback coordinates on the main island.
   */
  fastify.post('/nova/api/host/ready', async (_request, reply) => {
    return reply.send(markServerInjected());
  });

  fastify.get('/nova/api/matchmaking/host-demand', async (request, reply) => {
    const q = request.query as Record<string, string>;
    return reply.send(getHostDemand(q.playlist, q.region));
  });

  fastify.get('/nova/api/matchmaking/should-i-host', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const accountId = q.accountId || q.account || 'anon';
    const playlist = q.playlist || 'Playlist_DefaultSolo';
    const region = q.region || 'NAE';
    const gs = resolveGameServer(playlist, region);

    if (!Config.HOST_ELECTION) {
      // Host-election off → launcher should not auto-host; use whatever server is configured/live.
      return reply.send({ host: false, reason: 'host-election-disabled', playlist, region, server: `${gs.address}:${gs.port}` });
    }

    const decision = decideHost(accountId, playlist, region);
    return reply.send({
      ...decision,
      playlist, region,
      server: gs.entry ? `${gs.address}:${gs.port}` : null,
      waitMs: Config.HOST_ELECTION_WAIT_MS,
      tsIp: meshIpFor(accountId), // the address this machine should register if it hosts
    });
  });

  /**
   * GET /nova/api/host/should-i-serve?accountId=&playlist=&region=&address=&port=
   *
   * The single question a HOST AGENT asks the coordinator, on a loop: "should this machine be
   * running a gameserver right now?" It is the join between two things that used to be answered in
   * different places — live demand (who has pressed Play) and the host election (whose machine
   * should carry it) — which is why hosting could not work globally: the machine that could run a
   * server decided from its own local view, and the coordinator that had the full picture had no way
   * to act on it, being a Linux box that cannot run Fortnite.
   *
   * `address`/`port` are how the caller identifies the server it already has up. Without them a host
   * mid-match reads as "some other machine is serving", and the coordinator would answer stand-down
   * to the very machine holding the match together.
   */
  fastify.get('/nova/api/host/should-i-serve', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const accountId = q.accountId || q.account || 'anon';
    const playlist = q.playlist || 'Playlist_DefaultSolo';
    const region = q.region || 'NAE';
    const address = (q.address || '').trim();
    const port = parseInt(q.port || '7777', 10);

    const demand = getHostDemand(playlist, region);
    const mineEntry = address ? findServerAt(address, port) : undefined;
    const mine = !!mineEntry && isLive(mineEntry);
    const occupancy = mineEntry ? occupancyFor(mineEntry) : 0;
    const base = { waiting: demand.waiting, hasServer: demand.hasServer, occupancy, mine, playlist, region };

    if (!Config.HOST_ELECTION) {
      return reply.send({ ...base, serve: false, reason: 'host-election-disabled' });
    }

    // Already serving. Keep going while anyone is waiting OR anyone is in the match — the agent
    // applies its own grace period on top, because players briefly count as neither while they load.
    if (mine) {
      const stillNeeded = demand.waiting > 0 || occupancy > 0;
      return reply.send({
        ...base,
        serve: stillNeeded,
        reason: stillNeeded ? 'already-serving' : 'no-demand',
      });
    }

    // Nobody has pressed Play. Starting a server here would burn a machine for nobody.
    if (demand.waiting === 0) {
      return reply.send({ ...base, serve: false, reason: 'no-demand' });
    }

    // Somebody else already has a joinable match up — this player joins it instead of hosting.
    if (demand.hasServer) {
      return reply.send({ ...base, serve: false, reason: 'live-server-exists' });
    }

    // Real demand and nothing to join: run the election.
    const decision = decideHost(accountId, playlist, region);
    return reply.send({
      ...base,
      serve: decision.host,
      reason: decision.reason,
      betterHost: decision.betterHost,
      retryMs: decision.retryMs,
      score: decision.score,
    });
  });

  // ── Tailscale auto-mesh ────────────────────────────────────────────────────

  /**
   * POST /nova/api/mesh/announce
   * A launcher announces it is online and available to host, with its Tailscale IP and specs.
   * Re-post every ~30s to stay "available" (entries expire after MESH_CANDIDATE_TTL_MS).
   * Body: { accountId, tsIp, cpuCores, ramGB, netScore }
   */
  fastify.post('/nova/api/mesh/announce', async (request, reply) => {
    const b = (request.body || {}) as any;
    const accountId = String(b.accountId || '').trim();
    if (!accountId) return reply.status(400).send({ error: 'accountId required' });
    const tsIp = String(b.tsIp || '').trim();
    const cpuCores = Number(b.cpuCores) || 1;
    const ramGB = Number(b.ramGB) || 1;
    const netScore = Number(b.netScore) || 50;
    // Older launchers don't send a region. They score neutrally rather than being excluded — an
    // out-of-date client should still be able to host, just without proximity working in its favour.
    const region = String(b.region || '').trim().toUpperCase();
    const score = scoreCandidate(cpuCores, ramGB, netScore);
    const existed = meshCandidates.has(accountId);
    meshCandidates.set(accountId, { accountId, tsIp, cpuCores, ramGB, netScore, region, score, lastSeen: Date.now() });
    if (!existed) {
      console.log(`[Mesh] Candidate online: ${accountId} @ ${tsIp || 'no-ts-ip'} (${cpuCores}c/${ramGB}GB, ${regionLabel(region)}, hw score ${score})`);
    }
    return reply.send({ success: true, score, ttlMs: Config.MESH_CANDIDATE_TTL_MS });
  });

  /** GET /nova/api/mesh/candidates — who is available to host right now, best first. */
  fastify.get('/nova/api/mesh/candidates', async (_request, reply) => {
    const list = liveCandidates()
      .sort((a, b) => b.score - a.score)
      .map(c => ({ ...c, ageSec: Math.round((Date.now() - c.lastSeen) / 1000) }));
    return reply.send({ candidates: list, count: list.length });
  });

  /**
   * GET /nova/api/tailnet-authkey
   * Hands the tailnet auth key to an AUTHENTICATED launcher so it can join the mesh silently.
   * Requires NOVA_TS_AUTHKEY to be set on the coordinator; the value is never logged.
   */
  fastify.get('/nova/api/tailnet-authkey', { preHandler: requireAuth }, async (_request, reply) => {
    // MINT A FRESH KEY PER MACHINE when an API token is available.
    //
    // A static NOVA_TS_AUTHKEY is single-use unless it was created reusable, and the admin console
    // only offers that toggle when the key is generated. So the first PC to join consumes it and
    // every machine afterwards fails at `tailscale up` — with no error the player can act on. The
    // symptom is a launcher that works perfectly on one machine and cannot reach the mesh on any
    // other, which reads as the mesh being broken rather than a key that has been spent.
    //
    // Minting sidesteps the whole problem: each machine gets its own key, so there is nothing to
    // run out of and nothing to rotate by hand.
    if (Config.TS_API_KEY) {
      try {
        const key = await mintTailnetKey();
        return reply.send({ authKey: key, minted: true });
      } catch (e: any) {
        // Fall through to the static key rather than failing outright — a spent static key still
        // works for a machine already on the tailnet, and a broken API token should not take the
        // mesh down for everyone.
        console.warn(`[Tailnet] could not mint a key (${e?.message || e}) — falling back to NOVA_TS_AUTHKEY`);
      }
    }
    if (!Config.TS_AUTHKEY) {
      return reply.status(503).send({
        error: 'tailnet auth key not configured — set NOVA_TS_API_KEY (preferred: mints a fresh key per machine) or NOVA_TS_AUTHKEY on the coordinator',
      });
    }
    return reply.send({ authKey: Config.TS_AUTHKEY, minted: false });
  });

  // Back-compat: a listen-server that reports readiness maps onto a dynamic registration.
  fastify.post('/nova/api/session/:sessionId/host-ready', async (request, reply) => {
    const b = (request.body || {}) as any;
    if (b.hostAddress) {
      const address = String(b.hostAddress).trim();
      const port = parseInt(String(b.hostPort ?? 7777), 10);
      const key = serverKey(address, port, '*');
      gameServers.set(key, {
        address, port, playlist: '*', region: '*', source: 'dynamic',
        name: String(b.name || 'Nova host'), players: 0, maxPlayers: 100,
        status: 'ready', lastSeen: Date.now(),
      });
      console.log(`[Matchmaking] Host ready (via host-ready): ${address}:${port}`);
    }
    return reply.send({ success: true });
  });

  // ═══════════════════════════════════════════════
  //  CANCEL TICKET / LEAVE SESSION
  // ═══════════════════════════════════════════════

  fastify.delete('/fortnite/api/game/v2/matchmakingservice/ticket/player/:accountId', async (request, reply) => {
    const { accountId } = request.params as { accountId: string };
    const sessionId = playerSessionMap.get(accountId);
    if (sessionId) {
      const s = activeSessions.get(sessionId);
      if (s) {
        s.players = s.players.filter(p => p !== accountId);
        if (s.players.length === 0) activeSessions.delete(sessionId);
      }
      playerSessionMap.delete(accountId);
    }
    return reply.status(204).send();
  });

  // ═══════════════════════════════════════════════
  //  NOVA ADMIN: SESSION LIST
  // ═══════════════════════════════════════════════

  fastify.get('/nova/api/sessions', async (_request, reply) => {
    const sessions: any[] = [];
    for (const [id, s] of activeSessions) {
      const gs = resolveGameServer(s.playlistId, s.region);
      sessions.push({
        sessionId: id,
        server: `${gs.address}:${gs.port}`,
        host: gs.entry?.name || 'config-fallback',
        playlist: s.playlistId,
        region: s.region,
        playerCount: s.players.length,
        createdAt: s.createdAt.toISOString(),
      });
    }
    return reply.send({ sessions, totalActive: sessions.length });
  });
}

function buildSessionResponse(sessionId: string, s: GameSession | undefined): any {
  const gs = resolveGameServer(s?.playlistId, s?.region);
  const max = gs.entry?.maxPlayers || 100;
  const count = s?.players?.length ?? gs.entry?.players ?? 0;
  return {
    id: sessionId,
    ownerId: 'nova',
    ownerName: gs.entry?.name || 'Nova',
    serverName: 'Nova',
    // Always hand the client a connectable address — resolved live from the gameserver
    // registry (registered host → static table → config fallback 127.0.0.1:7777).
    serverAddress: gs.address,
    serverPort: gs.port,
    totalPlayers: count,
    maxPublicPlayers: max,
    openPublicPlayers: Math.max(0, max - count),
    // The client reads BOTH public and private counts as numbers. A missing
    // openPrivatePlayers/maxPrivatePlayers fails with "Unable to read session settings".
    maxPrivatePlayers: 0,
    openPrivatePlayers: 0,
    attributes: {
      REGION_s: s?.region || 'NAE',
      GAMEMODE_s: 'FORTATHENA',
      ALLOWBROADCASTING_b: true,
      PLAYLISTNAME_s: s?.playlistId || 'Playlist_DefaultSolo',
      ALLOWJOININPROGRESS_b: true,
      SESSIONKEY_s: sessionId.replace(/-/g, ''),
      BEACONPORT_i: 15009,
    },
    publicPlayers: s?.players || [],
    privatePlayers: [],
    allowJoinInProgress: true,
    shouldAdvertise: false,
    isDedicated: false,
    usesStats: false,
    allowInvites: true,
    usesPresence: false,
    allowJoinViaPresence: true,
    allowJoinViaPresenceFriendsOnly: false,
    buildUniqueId: lastBuildUniqueId,
    lastUpdated: new Date().toISOString(),
    started: true,
  };
}
