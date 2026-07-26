import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { Config } from '../../config';
import { getHostDemand, registerDynamicServer, unregisterDynamicServer } from './matchmaking.routes';

//==================================================================================================
//  HOST RUNNER — the backend owns the gameserver process.
//
//  Hosting is driven by the IN-GAME Play (ready up) press, not by the launcher starting up. The
//  sequence is:
//
//    1. The launcher starts the game and hands us a launch SPEC (POST /nova/api/host/config) — the
//       exact command line for a headless server on this machine. It does not start one.
//    2. The player presses Play in game. That opens the MMS websocket, which is counted as demand
//       (see matchmakingStarted in matchmaking.routes).
//    3. If someone is waiting and there is no live server, we spawn the server ourselves and
//       register it, so matchmaking releases the player into it.
//    4. When nobody is waiting any more — or the host's game has gone — we kill it.
//
//  WHERE STEP 3'S DECISION COMES FROM depends on how this backend was started:
//
//    STANDALONE (no NOVA_COORDINATOR) — single PC or LAN. The game talks to this backend, so this
//    backend sees the demand and decides for itself. Unchanged behaviour.
//
//    HOST AGENT (NOVA_COORDINATOR set) — global P2P. The game talks to the shared coordinator via
//    nova-proxy, so ALL demand and the host election live there and this process cannot see any of
//    it. It asks the coordinator instead, on a loop, and acts on the answer. This is the piece that
//    makes global play work: the coordinator knows who is waiting and picks the host, but it runs on
//    Linux and cannot run Fortnite — so the decision has to be carried back to a Windows machine
//    that can.
//
//  Why the launcher sends the argv instead of us building it: Fortnite's argument list is fiddly and
//  has broken this setup more than once. It is built in Rust (build_fortnite_args) and stays there;
//  duplicating it here would guarantee the two drift apart.
//==================================================================================================

export interface HostSpec {
  exe: string;
  cwd: string;
  args: string[];
  env?: [string, string][];
  port: number;
  playlist: string;
  region: string;
  /** Address other machines should use (tailnet IP); the local matchmaker always uses loopback. */
  address?: string;
  /** Who this machine is, so the coordinator's election can identify it among the mesh candidates. */
  accountId?: string;
  /** Shown to other players in the server list. */
  name?: string;
}

let spec: HostSpec | null = null;
let child: ChildProcess | null = null;
let startedAt = 0;
let lastError: string | null = null;
let lastVerdict = '';

/**
 * A spawned process is NOT yet a game server.
 *
 * It boots as an ordinary Fortnite client — logging in, loading its profile, reaching the menu —
 * and only becomes a server about a minute later, when the launcher injects the Reboot DLL and it
 * travels to the map and starts listening on 7777. Advertising it as ready the moment it spawns
 * sends waiting players at a port with nothing behind it; they were being released into a match
 * that did not exist yet. So it is published as 'starting' (live, but not joinable) until the
 * launcher confirms the injection worked.
 */
let serverReady = false;
/** When the launcher told us the DLL went in, so a missing readiness marker can't strand everyone. */
let injectedAt = 0;

/**
 * The gameserver announces itself when it is genuinely accepting players. Injection is NOT that
 * moment: loading the DLL only starts the work. It then scans signatures, sets the playlist, brings
 * up the beacon and calls InitListen — about thirteen seconds during which nothing is listening on
 * 7777 and the map's PlayerStarts do not exist yet.
 *
 * Releasing players on "injected" is what put someone into a match before the world was there. The
 * server logged it plainly — "Player joined too early or unable to find playerstart!" — and dropped
 * them at hardcoded fallback coordinates on the main island instead of the pre-match spawn island.
 */
// ONLY this line. "Ready to start match!" looks equally good and is NOT: it prints while the join
// beacon is still paused, so releasing on it sent the player at a server that was actively refusing
// connections. This is the one line printed immediately after the beacon is opened.
const READY_MARKERS = ['Players may join now!'];

/** How long after injection to give up waiting for the marker and advertise anyway. Generous: a real
 *  run reaches it in ~13s. Better a late join than a lobby that never opens on an unfamiliar build. */
const READY_FALLBACK_MS = 60 * 1000;

/** Every line the gameserver prints reaches us through /nova/api/logs/ingest. Watch for the marker. */
export function noteServerOutput(message: string): void {
  if (!isHosting() || serverReady || !message) return;
  if (READY_MARKERS.some(m => message.includes(m))) {
    markServerReady('the gameserver reported it is accepting players');
  }
}

/** The launcher calls this once it has injected the Reboot DLL. The process is a server-in-progress
 *  from here — not yet joinable. */
export function markServerInjected(): { ok: boolean; hosting: boolean } {
  if (!isHosting()) return { ok: false, hosting: false };
  if (!injectedAt) {
    injectedAt = Date.now();
    console.log(`[HostRunner] Reboot injected — waiting for the gameserver to open its lobby`);
  }
  return { ok: true, hosting: true };
}

export function markServerReady(why: string): { ok: boolean; hosting: boolean } {
  if (!isHosting()) return { ok: false, hosting: false };
  if (!serverReady) {
    serverReady = true;
    console.log(`[HostRunner] Gameserver is READY — now joinable (${why})`);
    void register();
  }
  return { ok: true, hosting: true };
}

/** Only ever launch the Fortnite client binary. This endpoint takes a path from a local caller, so
 *  it must not become a way to run something arbitrary. */
const ALLOWED_EXE = 'fortniteclient-win64-shipping.exe';

/** Set when NOVA_COORDINATOR points us at a shared coordinator (see the header). */
const COORDINATOR = Config.COORDINATOR_URL;
const AGENT_MODE = !!COORDINATOR;

export function setHostSpec(next: HostSpec | null): { ok: boolean; error?: string } {
  if (next === null) {
    spec = null;
    // Otherwise the launcher keeps showing the last thing the coordinator said, long after this
    // machine stopped taking part.
    lastVerdict = '';
    return { ok: true };
  }
  const base = path.basename(String(next.exe || '')).toLowerCase();
  if (base !== ALLOWED_EXE) {
    return { ok: false, error: `refusing to host with '${base}' — only ${ALLOWED_EXE} is allowed` };
  }
  if (!Array.isArray(next.args)) return { ok: false, error: 'args must be an array' };

  spec = {
    ...next,
    port: Number(next.port) || 7777,
    playlist: (next.playlist || '*').toLowerCase(),
    region: (next.region || '*').toUpperCase(),
  };
  console.log(
    `[HostRunner] Ready to host on demand (${spec.exe}, port ${spec.port})` +
    (AGENT_MODE ? ` — taking orders from ${COORDINATOR}` : ' — deciding locally')
  );
  return { ok: true };
}

export function isHosting(): boolean {
  return !!child && child.exitCode === null && !child.killed;
}

/**
 * Contract version between the launcher and this agent. BUMP IT whenever the launcher needs
 * behaviour an older agent does not have.
 *
 * The agent outlives the launcher — it keeps running after the window closes — so after an update you
 * get a new launcher talking to an old agent that answers every health check perfectly while missing
 * the thing that was just fixed. Sniffing for individual fields caught that once and then missed it
 * the next time; a number the launcher can compare against does not have that failure mode.
 *
 * 2 = waits for the gameserver's own readiness marker before advertising it as joinable.
 */
export const AGENT_PROTOCOL = 2;

export function hostStatus() {
  return {
    agentProtocol: AGENT_PROTOCOL,
    configured: !!spec,
    hosting: isHosting(),
    pid: isHosting() ? child!.pid : null,
    upSeconds: isHosting() ? Math.round((Date.now() - startedAt) / 1000) : 0,
    lastError,
    /** 'standalone' = decides from its own demand; 'agent' = obeys the coordinator. */
    mode: AGENT_MODE ? 'agent' : 'standalone',
    /** False while the process is still booting to the menu — live, but not yet joinable. */
    ready: serverReady,
    coordinator: COORDINATOR || null,
    /** The coordinator's most recent answer, so the launcher can show WHY it is or isn't hosting. */
    verdict: lastVerdict,
  };
}

/** The address OTHER machines must use to reach a server on this box. Loopback only works for the
 *  host's own client, so a tailnet address is what makes a match joinable from anywhere. */
function publicAddress(): string {
  return (spec?.address || '').trim() || '127.0.0.1';
}

function startServer(): void {
  if (!spec || isHosting()) return;

  try {
    const env = { ...process.env };
    for (const [k, v] of spec.env || []) env[k] = v;

    console.log(`[HostRunner] Demand with no server — starting the gameserver...`);
    child = spawn(spec.exe, spec.args, {
      cwd: spec.cwd,
      env,
      windowsHide: true,
      // Detached so a backend restart doesn't take the running match down with it. We still hold the
      // handle for the normal stop path.
      detached: false,
      stdio: 'ignore',
    });
    startedAt = Date.now();
    lastError = null;
    serverReady = false; // a brand new process is a client until the DLL goes in
    injectedAt = 0;

    child.on('error', (e) => {
      lastError = String(e?.message || e);
      console.error(`[HostRunner] Failed to start the gameserver: ${lastError}`);
      child = null;
      void deregister();
    });

    child.on('exit', (code, signal) => {
      console.log(`[HostRunner] Gameserver exited (code=${code} signal=${signal})`);
      child = null;
      serverReady = false;
      injectedAt = 0;
      void deregister();
    });

    console.log(`[HostRunner] Gameserver started (pid ${child.pid}) — registering it`);
    void register();
  } catch (e: any) {
    lastError = String(e?.message || e);
    console.error(`[HostRunner] Could not start the gameserver: ${lastError}`);
    child = null;
  }
}

export function stopServer(reason: string): void {
  if (!isHosting()) return;
  console.log(`[HostRunner] Stopping the gameserver (${reason})`);
  void deregister();
  try { child!.kill(); } catch { /* already gone */ }
  child = null;
  serverReady = false;
}

// ── Publishing this machine's server ────────────────────────────────────────────────────────────
// Standalone: write straight into our own registry — the game asks THIS backend for an address.
// Agent: POST to the coordinator, which is the only registry anyone else reads. The address must be
// the tailnet one; publishing 127.0.0.1 globally would send every joiner to their own machine.

async function register(): Promise<void> {
  if (!spec) return;
  const name = spec.name || 'Nova (auto-host)';
  const status = serverReady ? 'ready' : 'starting';
  if (!AGENT_MODE) {
    registerDynamicServer('127.0.0.1', spec.port, spec.playlist, spec.region, name, status);
    return;
  }
  try {
    await fetch(`${COORDINATOR}/nova/api/gameserver/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: publicAddress(),
        port: spec.port,
        playlist: spec.playlist,
        region: spec.region,
        name,
        status,
        secret: Config.REGISTER_SECRET || undefined,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e: any) {
    console.warn(`[HostRunner] Could not publish this server to the coordinator: ${e?.message || e}`);
  }
}

async function deregister(): Promise<void> {
  if (!spec) return;
  if (!AGENT_MODE) {
    unregisterDynamicServer('127.0.0.1', spec.port, spec.playlist);
    return;
  }
  try {
    await fetch(`${COORDINATOR}/nova/api/gameserver/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // '*' removes every entry for this address:port whatever playlist it went in under. A stale
      // registration is expensive: joiners keep being routed to a server that has gone.
      body: JSON.stringify({
        address: publicAddress(), port: spec.port, playlist: '*',
        secret: Config.REGISTER_SECRET || undefined,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch { /* the coordinator also expires us after 60s of no heartbeat */ }
}

/**
 * WHY THERE IS NO "nobody is waiting, so shut down" TIMER.
 *
 * It is tempting, and it was wrong twice over:
 *
 *  1. A player stops counting as "waiting" the moment they join — the client withdraws its
 *     matchmaking ticket as part of joining, so demand AND occupancy both read zero seconds into a
 *     perfectly healthy match.
 *  2. The server is not even a server yet. It boots as an ordinary Fortnite client and only becomes
 *     one when the Reboot DLL is injected ~45s later. An idle timer measured from spawn expires
 *     while the thing it is judging is still starting up, and kills it just before it works.
 *
 * So the server's life is tied to things that are actually observable: the process exiting (match
 * over, or a crash), the launcher clearing the host config (the player closed their game or the
 * launcher), and a long backstop for a process that has wedged. Nothing else.
 */
const MAX_SERVER_AGE_MS = parseInt(process.env.NOVA_MAX_SERVER_AGE_MS || String(3 * 60 * 60 * 1000), 10);

function overstayed(): boolean {
  return isHosting() && Date.now() - startedAt > MAX_SERVER_AGE_MS;
}

/** Standalone tick — this backend can see the demand itself. */
function tickLocal(): void {
  if (!spec) return;

  if (!isHosting()) {
    // Only act on REAL demand: somebody pressed Play in game and has nothing to join.
    if (getHostDemand(spec.playlist, spec.region).needsHost) startServer();
    return;
  }

  // We are hosting. Keep the registration fresh so the matchmaker keeps routing to us.
  checkReadyFallback();
  void register();
  if (overstayed()) stopServer(`running for over ${Math.round(MAX_SERVER_AGE_MS / 60000)} minutes`);
}

/** Open the lobby anyway if the gameserver never printed a marker we recognise. */
function checkReadyFallback(): void {
  if (serverReady || !injectedAt) return;
  if (Date.now() - injectedAt >= READY_FALLBACK_MS) {
    markServerReady(`no readiness marker after ${Math.round(READY_FALLBACK_MS / 1000)}s — opening anyway`);
  }
}

/** Agent tick — the coordinator holds the demand and runs the election, so we ask it. */
async function tickAgent(): Promise<void> {
  if (!spec) return;

  const url =
    `${COORDINATOR}/nova/api/host/should-i-serve` +
    `?accountId=${encodeURIComponent(spec.accountId || 'anon')}` +
    `&playlist=${encodeURIComponent(spec.playlist)}` +
    `&region=${encodeURIComponent(spec.region)}` +
    `&address=${encodeURIComponent(publicAddress())}` +
    `&port=${spec.port}`;

  let verdict: any;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    verdict = await res.json();
  } catch (e: any) {
    // The coordinator is unreachable. Do NOT act on that: starting a server would be guessing, and
    // stopping one would kill a match in progress over what may be a two-second network blip.
    lastVerdict = `coordinator unreachable (${e?.message || e})`;
    return;
  }

  const line = `${verdict.serve ? 'serve' : 'stand down'} — ${verdict.reason} (waiting ${verdict.waiting}, in match ${verdict.occupancy})`;
  if (line !== lastVerdict) {
    console.log(`[HostRunner] Coordinator says: ${line}`);
    lastVerdict = line;
  }

  if (!isHosting()) {
    if (verdict.serve) {
      console.log(`[HostRunner] Coordinator elected this machine as host — starting the gameserver`);
      startServer();
    }
    return;
  }

  // Already hosting. Keep the registration alive whatever the coordinator's latest verdict says —
  // "stand down" here means "no one is queuing", NOT "your match is over", and those are very
  // different things once people have actually loaded in. See MAX_SERVER_AGE_MS above for why this
  // deliberately has no idle timer.
  checkReadyFallback();
  void register();
  if (overstayed()) stopServer(`running for over ${Math.round(MAX_SERVER_AGE_MS / 60000)} minutes`);
}

/** Guards against a slow coordinator letting two ticks overlap. */
let ticking = false;

const timer = setInterval(() => {
  if (!AGENT_MODE) { tickLocal(); return; }
  if (ticking) return;
  ticking = true;
  void tickAgent().finally(() => { ticking = false; });
}, AGENT_MODE ? Config.HOST_AGENT_POLL_MS : 3000);
timer.unref();

/** Called when the backend shuts down, so a match doesn't outlive it as an orphan. */
export function shutdownHostRunner(): void {
  stopServer('backend shutting down');
}

// Actually run it. Without this the gameserver survives a backend restart as an orphan process that
// still holds port 7777, so the next elected host silently fails to bind and nobody can join.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => { shutdownHostRunner(); process.exit(0); });
}
process.on('exit', () => { try { child?.kill(); } catch { /* best effort */ } });
