// src/useLauncher.ts
// Everything the launcher DOES, separated from how it looks.
//
// This logic was previously interleaved with markup in a 1100-line screen component, which made it
// impossible to change the interface without risking the launch sequence. The behaviour here is
// carried over deliberately unchanged — several steps in it look arbitrary and are not, so the
// comments explaining why a wait is 45 seconds or why a watcher was deleted travel with the code.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { readBinaryFile, exists } from "@tauri-apps/api/fs";
import { join } from "@tauri-apps/api/path";
import {
  startBackend,
  AGENT,
  AGENT_PORT,
  COORDINATOR,
  agentReady,
  coordinatorReachable,
  localBackendReady,
  proxyIsForwarding,
} from "./novaApi";
import type { ServiceHealth } from "./novaApi";
import type { Session } from "./auth";

export const PLAYLIST = "Playlist_DefaultSolo";
export const REGION = "NAE";

export type BuildItem = { id: string; path: string; name: string; coverDataUrl?: string };

/** What this machine is doing in the mesh right now. The UI's warm/cold state comes from this. */
export type MeshRole = "offline" | "connected" | "hosting";

export type MeshStatus = { connected: boolean; ip?: string | null; detail: string; needsRestart?: boolean };

/* ── helpers ─────────────────────────────────────────────────────────────────────────────────── */

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null as any, bytes.subarray(i, i + chunk) as any);
  }
  return btoa(binary);
}

export function getFolderName(p: string) {
  const parts = p.split(/\\|\//).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/**
 * Turn the agent's raw record of the coordinator's answer into something a player can act on.
 * Worth doing: "why am I not hosting" is otherwise invisible, and the honest answers here are all
 * different situations — nobody wants a match, someone else already has one, or the coordinator
 * can't be reached at all.
 */
export function hostVerdictText(verdict: string): string {
  const v = (verdict || "").toLowerCase();
  if (v.includes("unreachable")) return "Can’t reach the Nova coordinator — check your connection.";
  if (v.includes("no-demand")) return "Connected. Press Play in game to find or host a match.";
  if (v.includes("live-server-exists")) return "Someone’s already hosting — press Play to drop into their match.";
  if (v.includes("another-host-pending")) return "Another player is starting a match — hang on.";
  if (v.includes("better-host-available")) return "A better-suited player is being asked to host first…";
  if (v.includes("host-election-disabled")) return "Host election is off on the coordinator — nobody will auto-host.";
  return "Connected to Project Nova.";
}

/**
 * Register a gameserver with BOTH the coordinator and the LOCAL backend.
 *
 * Only used by the MANUAL playit.gg path, where the player pastes a public address for a server they
 * are running themselves. The automatic path does not come through here: the host agent registers
 * and heartbeats its own server, because it is the only thing that knows for certain whether that
 * process is still alive.
 */
async function registerHostEverywhere(address: string, port: number, name: string) {
  await invoke("p2p_register_host", { coordinator: COORDINATOR, address, port, name });
  // The local backend reaches its own gameserver on loopback regardless of the mesh address.
  invoke("p2p_register_host", { coordinator: AGENT, address: "127.0.0.1", port, name }).catch(() => {});
}

/* ── the hook ────────────────────────────────────────────────────────────────────────────────── */

export type LauncherApi = ReturnType<typeof useLauncher>;

export function useLauncher(user: Session | null, notify: (t: { kind: "success" | "error" | "warn" | "info"; title: string; body?: string; action?: { label: string; onClick: () => void } }) => void) {
  const [path, setPath] = useState<string | null>(null);
  const [builds, setBuilds] = useState<BuildItem[]>([]);
  const [isLaunching, setIsLaunching] = useState(false);
  const [EOR, setEOR] = useState(false);
  const [p2pMode, setP2pMode] = useState<boolean>(localStorage.getItem("p2pMode") !== "false");

  const [status, setStatus] = useState<string>("");
  const [role, setRole] = useState<MeshRole>("offline");
  const [injecting, setInjecting] = useState(false);
  const [playitAddr, setPlayitAddr] = useState("");
  const [mesh, setMesh] = useState<MeshStatus | null>(null);
  /* Is the shared backend reachable from this PC?
     Polled continuously rather than only at launch, because the honest answer changes on its own —
     the coordinator runs on one machine on a home connection, and when its link drops every player
     is cut off at once. Without this the launcher has nothing to say and the player reasonably
     concludes the app is broken. See the banner in AppShell. */
  const [health, setHealth] = useState<ServiceHealth>({ coordinator: "checking", detail: "" });

  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const announceRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The address we registered as host, so we can unregister exactly that one on the way out. */
  const hostAddrRef = useRef<string | null>(null);
  /** Guards against two host attempts racing (the immediate path and the demand watcher). */
  const hostingRef = useRef(false);
  /** Which server PID we've already injected into, so a 3s poll can't fire injection repeatedly. */
  const injectedPidRef = useRef<number | null>(null);
  /**
   * Generation counter for watchHostState.
   *
   * That watcher is an unbounded 3-second poll that only ends when the player's game is seen
   * running and then exits. Two cases left it running forever: a launch where the game never
   * appears (so it never sees it go), and unmount — signing out tore down the component while the
   * loop carried on polling and calling setState into a dead tree. Pressing Play again then started
   * a SECOND loop alongside the first, both fighting over the same status line and both able to
   * fire injection.
   *
   * Bumping this invalidates every older watcher; each iteration checks it and returns.
   */
  const watchGen = useRef(0);

  const fail = useCallback((title: string, body?: string) => notify({ kind: "error", title, body }), [notify]);

  /* ── persistence ───────────────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    const savedPath = localStorage.getItem("buildPath");
    if (savedPath) setPath(savedPath);

    const rawEOR = localStorage.getItem("EOR");
    if (rawEOR !== null) setEOR(rawEOR === "true");

    const savedBuilds = localStorage.getItem("ProjectMP.builds");
    if (savedBuilds) {
      try {
        const parsed = JSON.parse(savedBuilds) as BuildItem[];
        setBuilds(parsed);
        if (!savedPath && parsed.length > 0) setPath(parsed[0].path);
      } catch { /* ignore */ }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("ProjectMP.builds", JSON.stringify(builds));
  }, [builds]);

  useEffect(() => {
    if (path) localStorage.setItem("buildPath", path);
    else localStorage.removeItem("buildPath");
  }, [path]);

  // Clean up every timer this hook owns, in one place — and stop the host watcher, which is a
  // loop rather than an interval and so would otherwise survive unmount.
  useEffect(() => () => {
    if (announceRef.current) clearInterval(announceRef.current);
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    watchGen.current += 1;
  }, []);

  /* ── is the game still up? ─────────────────────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    let t: number | null = null;
    let seenRunning = false;
    const startedAt = Date.now();
    const run = async () => {
      try {
        const r = await invoke("is_fortnite_client_running");
        if (cancelled) return;
        if (r === true) { seenRunning = true; return; }
        // r === false: only clear "launching" once the client was actually seen running (then it
        // closed), or after a grace period if launch failed — NOT on the first tick before the game
        // process has appeared (that race re-enabled PLAY early and allowed a double-launch).
        if (seenRunning || Date.now() - startedAt > 60000) setIsLaunching(false);
      } catch {
        /* transient error — keep the launching state, don't re-enable PLAY */
      }
    };
    if (isLaunching) {
      run();
      t = window.setInterval(run, 3000);
    }
    return () => {
      cancelled = true;
      if (t) window.clearInterval(t);
    };
  }, [isLaunching]);

  /* ── Tailscale auto-mesh (silent background service) ────────────────────────────────────────
   * On login we bring a Tailscale node up headlessly and announce this machine's capability
   * (CPU/RAM/latency) to the coordinator. That is what makes hosting automatic: the coordinator can
   * pick the best-suited machine, and every player already has a routable numeric 100.x address, so
   * there is no port forwarding, no tunnel, and no manual address to paste. */
  useEffect(() => {
    if (!user) return;
    // Respect the P2P setting: someone testing on a single PC / LAN has opted out of the global
    // service, and must not have a network client installed on their machine for it.
    if (!p2pMode) return;
    const accountId = user.accountId;
    const token = user.token || "";
    if (!accountId) return;
    let cancelled = false;

    (async () => {
      try {
        const st: any = await invoke("mesh_bring_up", {
          coordinator: COORDINATOR,
          accountId,
          token,
          hostname: `nova-${String(accountId).slice(0, 8)}`,
        });
        if (!cancelled) {
          setMesh({ connected: !!st?.connected, ip: st?.ip ?? null, detail: st?.detail || "", needsRestart: !!st?.needsRestart });
          if (st?.connected) setRole((r) => (r === "hosting" ? r : "connected"));
        }
      } catch (e) {
        if (!cancelled) setMesh({ connected: false, ip: null, detail: String(e) });
      }
      if (cancelled) return;
      // Stay "available to host" while the launcher is open (entries expire server-side).
      if (announceRef.current) clearInterval(announceRef.current);
      announceRef.current = setInterval(() => {
        invoke("mesh_announce", { coordinator: COORDINATOR, accountId }).catch(() => {});
      }, 30000);
    })();

    return () => {
      cancelled = true;
      if (announceRef.current) { clearInterval(announceRef.current); announceRef.current = null; }
    };
  }, [user?.accountId, user?.token, p2pMode]);

  /* ── host lifecycle ─────────────────────────────────────────────────────────────────────────
   * DELIBERATELY EMPTY. There used to be a second watcher here that policed the server by PID and
   * unregistered it when `serverAlive` went false.
   *
   * It read that PID from `get_server_pid()` — the process THIS LAUNCHER spawned. The launcher does
   * not spawn the server any more; the host agent does. So `serverAlive` was permanently false, and
   * every 5 seconds this deleted the agent's live registration from the coordinator while the match
   * was running perfectly well. The agent re-registered ~3s later, so the server appeared to blink
   * in and out of existence — which with two players would have told the second one no server
   * existed and had them host a rival match.
   *
   * The agent owns the process, so the agent's /nova/api/host/status is the only honest answer to
   * "is this machine hosting". watchHostState already reads it. One watcher, one source of truth. */

  // Closing the launcher must stand this machine down entirely — otherwise the agent keeps answering
  // the coordinator's elections and hosting matches for a player who has gone. sendBeacon rather
  // than fetch because the page is being torn down and an ordinary request would be cancelled in
  // flight.
  useEffect(() => {
    const onUnload = () => {
      try {
        navigator.sendBeacon(
          `${AGENT}/nova/api/host/config`,
          new Blob([JSON.stringify({ clear: true })], { type: "application/json" }),
        );
      } catch { /* best effort */ }
      const address = hostAddrRef.current;
      if (!address) return;
      invoke("p2p_unregister_host", { coordinator: COORDINATOR, address, port: 7777 }).catch(() => {});
      invoke("stop_server_instance").catch(() => {});
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  /* ── anti-cheat attestation ─────────────────────────────────────────────────────────────────
   * While the game is running, report the modules loaded into it so the coordinator can compare
   * them against the known-good set. It no-ops when the game is closed, and a failure here must
   * never interrupt play — it is a signal for review, not a gate. */
  useEffect(() => {
    if (!user?.token) return;
    const tick = () => { invoke("attest_now", { coordinator: COORDINATOR, token: user.token }).catch(() => {}); };
    tick();
    const id = setInterval(tick, 120000);
    return () => clearInterval(id);
  }, [user?.token]);

  /* ── becoming a gameserver ─────────────────────────────────────────────────────────────────── */

  /**
   * Turn the agent's freshly-spawned process INTO a game server.
   *
   * The backend can start Fortnite but it cannot inject a DLL, so without this the process it spawns
   * boots to the main menu as an ordinary headless client and sits there — logging in, querying its
   * profile, never listening on 7777. That is exactly what "the game server didn’t start" looked
   * like: a server process very much alive, that was never a server.
   *
   * The 45s wait is not arbitrary — injecting before the menu is reached crashes the game. Targeted
   * by PID because the host is also running their own client, and picking the wrong one of two
   * identically-named processes would turn the player's own game into the server.
   */
  const becomeGameserver = useCallback(async (pid?: number | null) => {
    if (!pid || injectedPidRef.current === pid) return;
    injectedPidRef.current = pid;

    await new Promise((r) => setTimeout(r, 45000));

    for (let attempt = 1; attempt <= 3; attempt++) {
      // Nothing to inject into any more — it crashed, or the match was cancelled.
      const st: any = await invoke("host_session_state").catch(() => null);
      if (st && !st.serverAlive && st.serverPid === pid) break;
      try {
        await invoke("inject_reboot", { dllPath: null, pid });
        // The DLL is in, but the server is NOT joinable yet — it still has to scan signatures, set
        // the playlist and start listening. The agent waits for the server to announce that itself
        // before advertising it, so this only tells the agent to start watching for it.
        await fetch(`${AGENT}/nova/api/host/ready`, { method: "POST" }).catch(() => {});
        setStatus("Server starting up — you’ll drop in once the lobby is open…");
        return;
      } catch (e) {
        if (attempt === 3) {
          setStatus("Couldn’t start the match server: " + String(e));
          fail("The match server didn’t start", String(e));
          injectedPidRef.current = null; // let a later attempt retry
          return;
        }
        setStatus(`Match server not ready yet — retrying (${attempt}/3)…`);
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
  }, [fail]);

  const watchHostState = useCallback(async (meshIp: string | null) => {
    let sawClient = false;
    let announced = false;
    const address = meshIp || "127.0.0.1";
    // Claim this generation. Any watcher started later — or an unmount — makes this one stale.
    const gen = ++watchGen.current;
    // Nothing has answered yet; used only to stop an unreachable agent polling in silence forever.
    let consecutiveAgentFailures = 0;

    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      if (watchGen.current !== gen) return; // superseded or unmounted

      // Player closed the game — clear the host config so the agent stops the server and drops out
      // of the coordinator's registry.
      const st: any = await invoke("host_session_state").catch(() => null);
      if (st?.clientPid) sawClient = true;
      if (sawClient && st && !st.clientAlive) {
        try {
          await fetch(`${AGENT}/nova/api/host/config`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clear: true }),
          });
        } catch { /* the agent may already be gone */ }
        hostingRef.current = false;
        hostAddrRef.current = null;
        setRole("connected");
        setStatus("You left the game — server stopped.");
        return;
      }

      let host: any = null;
      try {
        host = await (await fetch(`${AGENT}/nova/api/host/status`)).json();
        consecutiveAgentFailures = 0;
      } catch {
        // The agent is not answering. Retrying silently forever is how this used to spin at 3s
        // intervals for the rest of the session with nothing on screen explaining why hosting
        // never happened. Give it a couple of minutes, say so, and stop.
        if (++consecutiveAgentFailures >= 40) {
          setStatus("Lost contact with the local host service — this PC can’t host until you press Play again.");
          return;
        }
        continue;
      }

      // Registration is NOT done here. The agent publishes and heartbeats its own server, because it
      // is the only thing that knows whether that process is still alive — a launcher-side heartbeat
      // kept advertising servers that had already exited, and joiners were routed to them.
      if (host?.hosting && !announced) {
        announced = true;
        hostingRef.current = true;
        hostAddrRef.current = address;
        setRole("hosting");
        setStatus("The coordinator picked your PC — starting the match server…");
        notify({ kind: "info", title: "You’re hosting this match", body: "Your PC is running the server other players join." });
        void becomeGameserver(host.pid);
      } else if (!host?.hosting && announced) {
        announced = false;
        hostingRef.current = false;
        hostAddrRef.current = null;
        injectedPidRef.current = null; // the next elected server is a new process, inject into it too
        setRole("connected");
        setStatus("Match over — server stopped.");
      } else if (!host?.hosting && host?.verdict) {
        // Not hosting: show WHY, straight from the coordinator, instead of a stale "press Play" line.
        setStatus(hostVerdictText(host.verdict));
      }
    }
  }, [becomeGameserver, notify]);

  /* ── launch ────────────────────────────────────────────────────────────────────────────────── */

  const launch = useCallback(async () => {
    setIsLaunching(true);
    setStatus("");
    const launchPath = path || builds[0]?.path;
    if (!launchPath) {
      fail("No game build selected", "Add your Fortnite 7.40 folder in Library first.");
      setIsLaunching(false);
      return;
    }
    if (!user) {
      fail("You’re not signed in");
      setIsLaunching(false);
      return;
    }

    const accountId = user.accountId;
    const token = user.token;
    const p2p = p2pMode;

    try {
      if (!p2p) {
        // SINGLE-PC MODE STILL NEEDS 3551. This path used to launch Fortnite immediately — no
        // proxy, no backend, and no check that anything was listening. But Cobalt redirects every
        // Epic domain to 127.0.0.1:3551 in BOTH modes, so a game started with that port empty is
        // guaranteed to die: "connection refused" on every call, stuck on "Patching" while the
        // hotfix enumeration fails, then "No valid user" and a force-logout reading "Fortnite was
        // not started correctly". Nothing appears in the Logs tab either, because in this mode
        // nothing was ever started to produce any. It looks like the launcher is broken.
        //
        // A restored session is what makes this reachable: sign-in reads localStorage without
        // touching the network, so a player can be signed in, flip P2P off, press Play, and get
        // here with no backend anywhere.
        setStatus("Starting the local Nova backend…");
        let localUp = await localBackendReady();
        if (!localUp) {
          await startBackend();
          for (let i = 0; i < 30 && !localUp; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            localUp = await localBackendReady();
          }
        }
        if (!localUp) {
          fail(
            "Nova's local backend didn't start",
            "Fortnite reaches Nova on 127.0.0.1:3551, and nothing is listening there — the game would " +
              "hang on the loading screen and then close itself. Check nova-agent.log next to the " +
              "launcher, or turn on “Play with everyone” in Settings to use the Nova servers instead.",
          );
          setStatus("Not connected — nothing is listening on 3551.");
          setRole("offline");
          setIsLaunching(false);
          return;
        }
        await invoke("firstlaunch", { path: launchPath, accountId, token, eor: EOR });
        return;
      }

      // 1) Local proxy so the game (Cobalt → 127.0.0.1:3551) reaches the global coordinator, and the
      //    host agent beside it on 3552. The agent is this machine's hands: the coordinator decides
      //    who hosts, but it runs on Linux and cannot start a Fortnite server, so the machine it
      //    elects needs something local that can.
      setStatus("Connecting to Project Nova…");
      await invoke("start_proxy", { coordinator: COORDINATOR, proxyDir: null });

      // Verify the connection is REAL before launching anything. Everything downstream — shared
      // matchmaking, the host election, other players existing at all — depends on 3551 belonging to
      // the proxy, and the failure is otherwise invisible until someone wonders why they are alone.
      let link = await proxyIsForwarding(COORDINATOR);

      // A leftover standalone backend on 3551 is the common cause, and it is recoverable: stop it
      // and let the proxy have the port. Only ever reached once we KNOW the listener is a Nova
      // backend that isn't the coordinator, so this can't take out anything else.
      if (!link.ok && link.reason === "port-taken") {
        setStatus("Freeing the Nova port from an old local backend…");
        try {
          await invoke("free_port", { port: 3551 });
          await new Promise((r) => setTimeout(r, 1200));
          await invoke("start_proxy", { coordinator: COORDINATOR, proxyDir: null });
        } catch { /* fall through to the retry below and report honestly */ }
      }

      for (let i = 0; i < 6 && !link.ok; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        link = await proxyIsForwarding(COORDINATOR);
      }
      if (!link.ok) {
        const fix = link.reason === "port-taken"
          ? " Close it and launch again, or turn off P2P mode in Settings to play on it directly."
          : "";
        fail("Can’t connect to Project Nova", link.detail + fix);
        setStatus("Not connected — " + link.detail);
        setRole("offline");
        setIsLaunching(false);
        return;
      }

      let agentState = await agentReady();
      if (agentState === "stale") {
        // Left over from a previous launcher version. It answers health checks but can't do what
        // this build needs, so reusing it would fail in ways that look like the new code being
        // broken.
        setStatus("Replacing an out-of-date host service…");
        await invoke("free_port", { port: AGENT_PORT }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        agentState = "down";
      }
      let agentUp = agentState === "ok";
      if (!agentUp) {
        setStatus("Starting the local host service…");
        const started = await startBackend(COORDINATOR);
        // The database load takes a few seconds; the spec handover below is pointless until it
        // answers. 30s because a cold first run is slower than any later one.
        for (let i = 0; i < 30 && !agentUp; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          agentUp = (await agentReady()) === "ok";
        }
        if (!agentUp) {
          // Not fatal — you can still JOIN someone else's match without it. But you can never host,
          // so say so plainly and make sure nothing later overwrites that with a cheerier message.
          const why = started.startsWith("error:") ? started.slice(6).trim() : "it didn’t start in time";
          fail(
            "This PC can’t host matches",
            `${why}. You can still join matches other players host. See nova-agent.log next to the launcher.`,
          );
        }
      }

      // 2) Try to join the mesh (no-op if login already did). If it can't come up — e.g. Tailscale's
      //    driver won't initialise on this Windows build — DON'T block: the host can still play
      //    locally. Only cross-internet JOINING needs the mesh, so we just warn that others can't
      //    reach this machine.
      let meshIp: string | null = mesh?.ip ?? null;
      let meshDown = false;
      if (!meshIp) {
        setStatus("Joining the player network…");
        try {
          const st: any = await invoke("mesh_bring_up", {
            coordinator: COORDINATOR, accountId, token: user.token || "",
            hostname: `nova-${String(accountId).slice(0, 8)}`,
          });
          meshIp = st?.ip ?? null;
          setMesh({ connected: !!st?.connected, ip: st?.ip ?? null, detail: st?.detail || "", needsRestart: !!st?.needsRestart });
          if (!st?.connected) meshDown = true;
        } catch {
          meshDown = true;
        }
      }
      if (meshDown && !meshIp) {
        setStatus("Player network is offline — hosting locally (others can't join over the internet until it's fixed).");
      }

      // 3) Host or join? The coordinator scores every announced machine, so it may briefly ask us to
      //    wait while a better-suited player steps up. Re-poll instead of giving up — that gap is
      //    what previously left a joiner stuck on the matchmaking screen forever.
      let decision: any = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        setStatus(attempt === 0 ? "Finding a match…" : "Waiting for the best host to start…");
        decision = await invoke("p2p_should_i_host", {
          coordinator: COORDINATOR, accountId, playlist: PLAYLIST, region: REGION,
        });
        if (decision?.reason !== "better-host-available") break;
        await new Promise((r) => setTimeout(r, decision?.retryMs || 5000));
      }
      if (!meshIp && decision?.tsIp) meshIp = decision.tsIp;

      // Your game ALWAYS launches first and normally. Whether this machine also needs to run a
      // server is decided later, from live demand — see watchHostState.
      setStatus("Launching your game…");
      await invoke("firstlaunch", { path: launchPath, accountId, token, eor: EOR, headless: false });

      // The launcher does NOT start or stop the gameserver any more — the backend owns it.
      //
      // We hand over the exact command line for a headless server on this machine (built in Rust so
      // there is one source of truth for Fortnite's arguments). The backend then starts a server the
      // moment the IN-GAME Play press creates real demand with nothing to join, and stops it again
      // when nobody is matchmaking.
      // NEVER ADVERTISE LOOPBACK AS A HOST ADDRESS.
      //
      // This used to send `address: meshIp || "127.0.0.1"`. Everything from here on is P2P mode —
      // the single-PC path returned long ago, and there 127.0.0.1 is genuinely right — so the
      // fallback could only ever publish loopback to the GLOBAL coordinator. Any other player then
      // gets handed 127.0.0.1, which resolves to their OWN machine, where no server is running.
      //
      // It fails in the worst possible way: matchmaking succeeds, the session is assigned, the game
      // sits on the loading screen for its full connect timeout, and drops back to the lobby with no
      // error. Meanwhile this machine is registered as a live host, so the coordinator keeps telling
      // other players to stand down because a server already exists — one nobody can reach.
      //
      // Without a mesh IP this PC simply cannot host for anyone else, so say so and don't register.
      // Joining still works: that only needs the OTHER machine to be reachable.
      if (!meshIp) {
        setRole("connected");
        setStatus(
          "This PC can’t host for other players (not on the player network) — you can still join matches.",
        );
      } else {
        try {
          const spec: any = await invoke("server_launch_spec", {
            path: launchPath, accountId, token: token ?? "", eor: EOR,
          });
          const res = await fetch(`${AGENT}/nova/api/host/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...spec,
              port: 7777,
              playlist: PLAYLIST,
              region: REGION,
              // The address OTHER players are sent to. Only ever a mesh IP — see above.
              address: meshIp,
              accountId,
              name: user.displayName || "Nova host",
            }),
          });
          if (!res.ok) throw new Error(`agent replied ${res.status}`);
        } catch (e) {
          setStatus("Note: couldn't hand hosting to this machine (" + String(e) + ") — you won't be able to host.");
        }
      }

      // Nothing has been decided yet. `decision` is a SNAPSHOT of the world as it looked a moment
      // ago, and the real choice is made by the coordinator when Play is pressed in game — by which
      // point another player may have started hosting, or stopped. Saying "your PC will host" here
      // was a promise the launcher is in no position to make.
      setRole("connected");
      if (!agentUp) {
        setStatus("Can’t host from this PC (host service didn’t start) — you can still join a match.");
      } else if (decision?.host) {
        setStatus("Connected. No match open yet — press Play in game and yours will likely be the one that starts.");
      } else {
        setStatus("Connected. A match is open — press Play in game to drop into it.");
      }
      void watchHostState(meshIp);
    } catch (err) {
      fail("Launch failed", String(err));
      setStatus("");
      setIsLaunching(false);
    }
  }, [path, builds, user, p2pMode, EOR, mesh?.ip, fail, watchHostState]);

  /* ── manual host controls (playit.gg path) ─────────────────────────────────────────────────── */

  /** Host: inject the Reboot server DLL into the running game (click once at the main menu). */
  const injectServer = useCallback(async () => {
    setInjecting(true);
    setStatus("Injecting Reboot server into your game…");
    try {
      // Prefer the agent's server PID. Without it this falls back to "first process with that name",
      // which once the host is also playing is a coin flip between the server and their own game.
      let pid: number | null = null;
      try { pid = (await (await fetch(`${AGENT}/nova/api/host/status`)).json())?.pid ?? null; } catch { /* fall back */ }
      await invoke("inject_reboot", { dllPath: null, pid });
      setStatus("Reboot injected — your game is hosting on port 7777. Paste your playit address and register it.");
    } catch (e) {
      setStatus("Injection failed: " + String(e));
      fail("Injection failed", String(e));
    } finally {
      setInjecting(false);
    }
  }, [fail]);

  /** Host: register your public playit address so joiners are routed to you. */
  const registerHost = useCallback(async () => {
    const addr = playitAddr.trim();
    const i = addr.lastIndexOf(":");
    if (i <= 0) {
      fail("That address needs a port", "Enter it as host:port — for example abc.playit.gg:40000.");
      return;
    }
    const address = addr.slice(0, i);
    const port = parseInt(addr.slice(i + 1), 10);
    if (!port) {
      fail("That port isn’t a number", "Enter the address as host:port.");
      return;
    }
    try {
      await registerHostEverywhere(address, port, user?.displayName || "Nova host");
      // Keep it registered — the coordinator drops a dynamic server after 60s of silence.
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = setInterval(() => {
        registerHostEverywhere(address, port, user?.displayName || "Nova host").catch(() => {});
      }, 30000);
      setStatus(`Registered ${address}:${port} — heartbeat on.`);
      notify({ kind: "success", title: "Your match is published", body: `Friends can join at ${address}:${port}.` });
    } catch (e) {
      fail("Couldn’t publish your match", String(e));
    }
  }, [playitAddr, user?.displayName, fail, notify]);

  /** Host-also-plays: launch a 2nd Fortnite instance as your client to join your own server. */
  const launchClient = useCallback(async () => {
    const launchPath = path || builds[0]?.path;
    if (!launchPath || !user) {
      fail("Nothing to launch", "Select a build and sign in first.");
      return;
    }
    setStatus("Launching your client instance… (heavy — two Fortnite windows).");
    try {
      await invoke("launch_client_only", {
        path: launchPath,
        accountId: user.accountId,
        token: user.token,
        eor: EOR,
      });
      setStatus("Client launched. In the NEW Fortnite window, press Play to drop into your match.");
    } catch (e) {
      fail("Client launch failed", String(e));
    }
  }, [path, builds, user, EOR, fail]);

  /* ── library ───────────────────────────────────────────────────────────────────────────────── */

  const addBuild = useCallback(async () => {
    const selected = await open({ directory: true });
    if (!selected || typeof selected !== "string") return;
    try {
      const hasEngine = await exists(await join(selected, "Engine"));
      if (!hasEngine) {
        fail("That folder isn’t a Fortnite build", "Pick the folder that contains the 'Engine' directory.");
        return;
      }
      if (builds.length >= 16) {
        fail("Your library is full", "Nova holds 16 builds. Remove one to add another.");
        return;
      }

      const splashPath = await join(selected, "FortniteGame", "Content", "Splash", "Splash.bmp");
      const hasSplash = await exists(splashPath);

      let coverDataUrl: string | undefined;
      if (hasSplash) {
        const bytes = await readBinaryFile(splashPath);
        coverDataUrl = "data:image/bmp;base64," + bytesToBase64(bytes);
      }

      const item: BuildItem = {
        id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
        path: selected,
        name: getFolderName(selected),
        coverDataUrl,
      };
      setBuilds((b) => [item, ...b]);
      setPath(selected);
      notify({ kind: "success", title: `Added ${item.name}` });
    } catch (e) {
      fail("Couldn’t add that build", String(e));
    }
  }, [builds.length, fail, notify]);

  /**
   * Take a build out of the library — with a way back.
   *
   * Removal is one click on a card, so it is easy to hit by accident, and re-adding means finding
   * the folder again. Nothing is deleted from disk, but the list entry (and its cover art) is real
   * work to recreate, so the removed item is held long enough to put it back.
   */
  const removeBuild = useCallback((id: string) => {
    setBuilds((list) => {
      const target = list.find((b) => b.id === id);
      const index = list.findIndex((b) => b.id === id);
      const next = list.filter((b) => b.id !== id);
      // Don't leave `path` pointing at a build that's no longer in the library.
      const wasSelected = !!target && target.path === path;
      if (wasSelected) setPath(next[0]?.path ?? null);

      if (target) {
        notify({
          kind: "info",
          title: `Removed ${target.name}`,
          body: "Your files are untouched.",
          action: {
            label: "Undo",
            // Restores it where it was, not on the end — the library keeps the order you built.
            onClick: () => {
              setBuilds((cur) => {
                if (cur.some((b) => b.id === target.id)) return cur;
                const restored = [...cur];
                restored.splice(Math.min(index, restored.length), 0, target);
                return restored;
              });
              if (wasSelected) setPath(target.path);
            },
          },
        });
      }
      return next;
    });
  }, [path, notify]);

  /* ── settings ──────────────────────────────────────────────────────────────────────────────── */

  const toggleEOR = useCallback((next: boolean) => {
    setEOR(next);
    localStorage.setItem("EOR", String(next));
  }, []);

  const toggleP2p = useCallback((next: boolean) => {
    setP2pMode(next);
    localStorage.setItem("p2pMode", String(next));
  }, []);

  /* Poll the coordinator so the banner reflects now, not whenever Play was last pressed.
     30s is a compromise: fast enough that a player who alt-tabs back sees the truth, slow enough
     that it is not a meaningful load on a home-hosted box. Only runs in P2P mode — a single-PC
     player has no coordinator to be cut off from, and telling them the servers are down would be
     both false and alarming. */
  useEffect(() => {
    if (!p2pMode) { setHealth({ coordinator: "ok", detail: "" }); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const h = await coordinatorReachable();
      if (cancelled) return;
      setHealth(h);
      timer = setTimeout(tick, 30_000);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [p2pMode]);

  return {
    // state
    path, setPath, builds, isLaunching, EOR, p2pMode, status, role, injecting, playitAddr, mesh, health,
    // actions
    launch, injectServer, registerHost, launchClient, addBuild, removeBuild,
    setPlayitAddr, toggleEOR, toggleP2p,
  };
}
