// src/onboard.tsx
import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { readBinaryFile, exists } from "@tauri-apps/api/fs";
import { join } from "@tauri-apps/api/path";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Home,
  Grid,
  Settings,
  LogOut,
  Play,
  Plus,
  Trash2,
  User,
  Terminal,
} from "lucide-react";
import "./App.css";
import StatusBar from "./StatusBar";
import LogViewer from "./LogViewer";
import { startBackend, stopGame, getNews, AGENT, AGENT_PORT, agentReady, proxyIsForwarding } from "./novaApi";

/* -------------------- Helpers -------------------- */
function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null as any, bytes.subarray(i, i + chunk) as any);
  }
  return btoa(binary);
}
function getFolderName(p: string) {
  const parts = p.split(/\\|\//).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/* -------------------- Types -------------------- */
type TabKey = "home" | "library" | "news" | "settings" | "logs";
type BuildItem = { id: string; path: string; name: string; coverDataUrl?: string };
type NewsItem = { id: string; title: string; date: string; desc: string; img?: string };
/* -------------------- P2P config -------------------- */
// The global coordinator (Tailscale Funnel). The launcher runs a local proxy so the game
// (via Cobalt → 127.0.0.1:3551) reaches this. Change here to point at a different deployment.
const COORDINATOR = "https://clientfinder.tail0a8fd0.ts.net:8443";

/**
 * Register a gameserver with BOTH the coordinator and the LOCAL backend.
 *
 * Only used by the MANUAL playit.gg path now, where the player pastes a public address for a server
 * they are running themselves. The automatic path does not come through here: the host agent
 * registers and heartbeats its own server, because it is the only thing that knows for certain
 * whether that process is still alive.
 */
async function registerHostEverywhere(address: string, port: number, name: string) {
  await invoke("p2p_register_host", { coordinator: COORDINATOR, address, port, name });
  // The local backend reaches its own gameserver on loopback regardless of the mesh address.
  invoke("p2p_register_host", { coordinator: AGENT, address: "127.0.0.1", port, name }).catch(() => {});
}

/**
 * Turn the agent's raw record of the coordinator's answer into something a player can act on.
 * Worth doing: "why am I not hosting" is otherwise invisible, and the honest answers here are all
 * different situations — nobody wants a match, someone else already has one, or the coordinator
 * can't be reached at all.
 */
function hostVerdictText(verdict: string): string {
  const v = (verdict || "").toLowerCase();
  if (v.includes("unreachable")) return "Can't reach the Nova coordinator — check your connection.";
  if (v.includes("no-demand")) return "Connected. Press Play in game to find or host a match.";
  if (v.includes("live-server-exists")) return "Someone's already hosting — press Play to drop into their match.";
  if (v.includes("another-host-pending")) return "Another player is starting a match — hang on.";
  if (v.includes("better-host-available")) return "A better-suited player is being asked to host first…";
  if (v.includes("host-election-disabled")) return "Host election is off on the coordinator — nobody will auto-host.";
  return "Connected to Project Nova.";
}

const PLAYLIST = "Playlist_DefaultSolo";
const REGION = "NAE";
// HOSTING MODEL: the Reboot DLL runs as a DEDICATED server, launched HEADLESS (-nullrhi: no
// rendering, no game window) so it costs a fraction of a normal client — the only visible surface is
// Reboot's log console. The host plays in a SEPARATE client that joins over the network, which is
// the path Reboot's match flow actually supports.
//
// (A listen-server mode — host playing inside the server process — is implemented behind
// `Defines::bHostCanPlay` in the Reboot source. It does spawn a pawn, but the host never enters
// Reboot's match flow and ends up frozen with no inventory, so it stays off. That flag is the single
// source of truth; the launcher deliberately doesn't mirror it, because two flags that must agree is
// a bug waiting to happen.)

/* -------------------- Component -------------------- */
/** Module scope on purpose: a component declared INSIDE another component is a brand-new function
 *  identity on every render, so React unmounts and remounts its whole subtree — which resets state,
 *  restarts animations and steals focus from inputs mid-typing. */
function NavItem({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active?: boolean; onClick?: () => void; }) {
  return (
    <button onClick={onClick} className={`w-full text-left px-3 py-2 rounded-md flex items-center gap-3 ${active ? "bg-gradient-to-r from-[#0f1724] to-[#13222b] ring-1 ring-[#0ea5e9]/20 text-white" : "text-slate-300 hover:bg-[#071422]/60"}`}>
      <div className="w-7 h-7 grid place-items-center text-slate-200">{icon}</div>
      <div className="text-sm">{label}</div>
    </button>
  );
}

export default function Onboard() {
  const navigate = useNavigate();

  // preserved states / logic
  const [active, setActive] = useState<TabKey>("home");
  const [path, setPath] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [user, setUser] = useState<{ email: string; password?: string; accountId?: string; token?: string; displayName?: string } | null>(null);
  const [EOR, setEOR] = useState(false);
  const [builds, setBuilds] = useState<BuildItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // P2P host-mode state
  const [p2pStatus, setP2pStatus] = useState<string>("");
  const [p2pRole, setP2pRole] = useState<"host" | "join" | null>(null);
  const [playitAddr, setPlayitAddr] = useState<string>("");
  const [injecting, setInjecting] = useState(false);
  const [p2pMode, setP2pMode] = useState<boolean>(localStorage.getItem("p2pMode") !== "false");
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** The address we registered as host, so we can unregister exactly that one on the way out. */
  const hostAddrRef = useRef<string | null>(null);

  // Tailscale auto-mesh (the silent background service)
  const [meshStatus, setMeshStatus] = useState<{ connected: boolean; ip?: string | null; detail: string; needsRestart?: boolean } | null>(null);
  const announceRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Show an error with a TRACKED timer, so a stale timer can't clear a newer error early. */
  const showError = (msg: string) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 6000);
  };

  // Single place that guarantees every timer this component owns is cleaned up.
  useEffect(() => () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    if (announceRef.current) clearInterval(announceRef.current);
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
  }, []);

  // mock news / hero carousel images (swap as you like)
  const [news, setNews] = useState<NewsItem[]>([
    { id: "n1", title: "Patch v2.5 — Performance & polish", date: "Oct 12, 2025", desc: "Performance improvements + UI polish. Read full patch notes in the launcher.", img: "https://i.ibb.co/HLQqKrj4/Chapter-2-Remix-Header.webp" },
    { id: "n2", title: "Matchmaking improvements", date: "Oct 9, 2025", desc: "We've fixed several issues and improved matchmaking stability.", img: "https://i.ibb.co/yBBpHp1D/Chapter-2-Season-4-Key-Art-Fortnite.webp" },
    { id: "n3", title: "Scheduled Maintenance", date: "Oct 7, 2025", desc: "Servers will be down for 3 hours for backend updates.", img: "https://i.ibb.co/DDsGMMyh/hq720.jpg" },
  ]);

  /* -------------------- lifecycle / persistence -------------------- */
  useEffect(() => {
    const savedPath = localStorage.getItem("buildPath");
    if (savedPath) setPath(savedPath);

    const savedUser = localStorage.getItem("user");
    if (savedUser) {
      try { setUser(JSON.parse(savedUser)); } catch { /* ignore */ }
    }

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

    // Pull the live news feed from the backend (falls back to the defaults if offline).
    getNews().then((n) => { if (n && n.length) setNews(n as NewsItem[]); }).catch(() => {});
  }, []);

  useEffect(() => {
    localStorage.setItem("ProjectMP.builds", JSON.stringify(builds));
  }, [builds]);

  useEffect(() => {
    if (path) localStorage.setItem("buildPath", path); else localStorage.removeItem("buildPath");
  }, [path]);

  /* -------------------- launcher polling -------------------- */
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

  /* -------------------- Tailscale auto-mesh (silent background service) --------------------
   * On login we bring a Tailscale node up headlessly and announce this machine's capability
   * (CPU/RAM/latency) to the coordinator. That is what makes hosting automatic: the coordinator
   * can pick the best-suited machine, and every player already has a routable numeric 100.x
   * address, so there is no port forwarding, no tunnel, and no manual address to paste.
   * If the coordinator has no tailnet key configured, this degrades quietly and the old flow
   * still works. */
  useEffect(() => {
    if (!user) return;
    // Respect the P2P setting: someone testing on a single PC / LAN has opted out of the global
    // service, and must not have a network client installed on their machine for it.
    if (!p2pMode) return;
    const accountId = user.accountId || user.email;
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
        if (!cancelled) setMeshStatus({ connected: !!st?.connected, ip: st?.ip ?? null, detail: st?.detail || "", needsRestart: !!st?.needsRestart });
      } catch (e) {
        if (!cancelled) setMeshStatus({ connected: false, ip: null, detail: String(e) });
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
  }, [user?.accountId, user?.email, user?.token, p2pMode]);

  /* -------------------- host lifecycle --------------------
   * DELIBERATELY EMPTY. There used to be a second watcher here that policed the server by PID and
   * unregistered it when `serverAlive` went false.
   *
   * It read that PID from `get_server_pid()` — the process THIS LAUNCHER spawned. The launcher does
   * not spawn the server any more; the host agent does. So `serverAlive` was permanently false, and
   * every 5 seconds this deleted the agent's live registration from the coordinator while the match
   * was running perfectly well. The agent re-registered ~3s later, so the server appeared to blink in
   * and out of existence — which is exactly the "elected / already-serving" flapping in the logs, and
   * with two players would have told the second one no server existed and had them host a rival match.
   *
   * The agent owns the process, so the agent's /nova/api/host/status is the only honest answer to
   * "is this machine hosting". watchHostState already reads it, and already handles both the player
   * closing their game and the server going away. One watcher, one source of truth. */

  // Closing the launcher must stand this machine down entirely — otherwise the agent keeps answering
  // the coordinator's elections and hosting matches for a player who has gone. sendBeacon rather than
  // fetch because the page is being torn down and an ordinary request would be cancelled in flight.
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

  /* -------------------- anti-cheat attestation --------------------
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

  /* -------------------- actions -------------------- */

  /** Guards against two host attempts racing (the immediate path and the demand watcher). */
  const hostingRef = useRef(false);
  /** Which server PID we've already injected into, so a 3s poll can't fire injection repeatedly. */
  const injectedPidRef = useRef<number | null>(null);

  /**
   * Spin up a headless gameserver ON THIS MACHINE and publish it, without touching the game the
   * player is already in. Called only when the coordinator says nothing joinable exists.
   */
  // NOTE: startHostServer() lived here and spawned the headless Fortnite server from the launcher.
  // The backend owns that now (see /nova/api/host/config + hostRunner), so the server's lifetime is
  // tied to the in-game Play press rather than to the launcher staying open.

  /**
   * Mirror the backend's hosting state into the launcher UI, and keep the COORDINATOR in step.
   *
   * The backend owns the server process now (it spawns one when the in-game Play press creates
   * demand). Two things still belong here:
   *   - telling the player what is happening, and
   *   - registering/unregistering with the coordinator, which is how OTHER machines discover this
   *     host. The backend only knows about itself.
   *
   * Runs for the session and cleans up when the player's game exits.
   */
  /**
   * Turn the agent's freshly-spawned process INTO a game server.
   *
   * The backend can start Fortnite but it cannot inject a DLL, so without this the process it spawns
   * boots to the main menu as an ordinary headless client and sits there — logging in, querying its
   * profile, never listening on 7777. That is exactly what "the game server didn't start" looked
   * like: a server process very much alive, that was never a server.
   *
   * The 45s wait is not arbitrary — injecting before the menu is reached crashes the game. Targeted
   * by PID because the host is also running their own client, and picking the wrong one of two
   * identically-named processes would turn the player's own game into the server.
   */
  const becomeGameserver = async (pid?: number | null) => {
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
        setP2pStatus("Server starting up — you'll drop in once the lobby is open…");
        return;
      } catch (e) {
        if (attempt === 3) {
          setP2pStatus("Couldn't start the match server: " + String(e));
          injectedPidRef.current = null; // let a later attempt retry
          return;
        }
        setP2pStatus(`Match server not ready yet — retrying (${attempt}/3)…`);
        await new Promise((r) => setTimeout(r, 15000));
      }
    }
  };

  const watchHostState = async (meshIp: string | null) => {
    let sawClient = false;
    let announced = false;
    const address = meshIp || "127.0.0.1";

    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));

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
        setP2pRole(null);
        setP2pStatus("You left the game — server stopped.");
        return;
      }

      let host: any = null;
      try {
        host = await (await fetch(`${AGENT}/nova/api/host/status`)).json();
      } catch { continue; }

      // Registration is NOT done here. The agent publishes and heartbeats its own server, because it
      // is the only thing that knows whether that process is still alive — a launcher-side heartbeat
      // kept advertising servers that had already exited, and joiners were routed to them.
      if (host?.hosting && !announced) {
        announced = true;
        hostingRef.current = true;
        hostAddrRef.current = address;
        setP2pRole("host");
        setP2pStatus("The coordinator picked your PC — starting the match server…");
        void becomeGameserver(host.pid);
      } else if (!host?.hosting && announced) {
        announced = false;
        hostingRef.current = false;
        hostAddrRef.current = null;
        injectedPidRef.current = null; // the next elected server is a new process, inject into it too
        setP2pRole(null);
        setP2pStatus("Match over — server stopped.");
      } else if (!host?.hosting && host?.verdict) {
        // Not hosting: show WHY, straight from the coordinator, instead of a stale "press Play" line.
        setP2pStatus(hostVerdictText(host.verdict));
      }
    }
  };

  /**
   * This machine has stopped hosting — reflect that, and make sure nobody is still being routed here.
   *
   * Deliberately does NOT clear the host config: the agent's spec must survive a finished match so
   * the player can press Play again and be elected again. Clearing it here would make hosting a
   * once-per-launch trick. The agent owns the process and its registration; this is the safety net
   * for the case where the server died without the agent noticing yet.
   */
  const stopHosting = async (reason: string) => {
    hostingRef.current = false; // allow hosting again on the next Play
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; }
    const address = hostAddrRef.current;
    hostAddrRef.current = null;
    if (address) {
      // Unregister FIRST so no new player is routed to a server that's about to disappear.
      try { await invoke("p2p_unregister_host", { coordinator: COORDINATOR, address, port: 7777 }); } catch { /* the coordinator also expires us after 60s */ }
    }
    setP2pRole(null);
    setP2pStatus(reason);
  };

  const handleLaunch = async () => {
    setIsLaunching(true);
    setP2pStatus("");
    setP2pRole(null);
    const launchPath = path || builds[0]?.path;
    if (!launchPath) {
      showError("Please first select a game folder or build in the library.");
      setIsLaunching(false);
      return;
    }
    if (!user) {
      showError("No login details found.");
      setIsLaunching(false);
      return;
    }

    const accountId = user.accountId || user.email;
    const token = user.token || user.password;
    // P2P (global coordinator) is the default; toggle off in Settings for single-PC / LAN testing.
    const p2p = p2pMode;

    try {
      if (!p2p) {
        await invoke("firstlaunch", { path: launchPath, accountId, token, eor: EOR });
        return;
      }

      // 1) Local proxy so the game (Cobalt → 127.0.0.1:3551) reaches the global coordinator, and the
      //    host agent beside it on 3552. The agent is this machine's hands: the coordinator decides
      //    who hosts, but it runs on Linux and cannot start a Fortnite server, so the machine it
      //    elects needs something local that can.
      setP2pStatus("Connecting to Project Nova…");
      await invoke("start_proxy", { coordinator: COORDINATOR, proxyDir: null });

      // Verify the connection is REAL before launching anything. Everything downstream — shared
      // matchmaking, the host election, other players existing at all — depends on 3551 belonging to
      // the proxy, and the failure is otherwise invisible until someone wonders why they are alone.
      let link = await proxyIsForwarding(COORDINATOR);

      // A leftover standalone backend on 3551 is the common cause, and it is recoverable: stop it and
      // let the proxy have the port. Only ever reached once we KNOW the listener is a Nova backend
      // that isn't the coordinator, so this can't take out anything else.
      if (!link.ok && link.reason === "port-taken") {
        setP2pStatus("Freeing the Nova port from an old local backend…");
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
        showError("Can't connect to Project Nova: " + link.detail + fix);
        setP2pStatus("Not connected — " + link.detail);
        setIsLaunching(false);
        return;
      }

      let agentState = await agentReady();
      if (agentState === "stale") {
        // Left over from a previous launcher version. It answers health checks but can't do what this
        // build needs, so reusing it would fail in ways that look like the new code being broken.
        setP2pStatus("Replacing an out-of-date host service…");
        await invoke("free_port", { port: AGENT_PORT }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
        agentState = "down";
      }
      let agentUp = agentState === "ok";
      if (!agentUp) {
        setP2pStatus("Starting the local host service…");
        const started = await startBackend(COORDINATOR);
        // tsx + the database load takes a few seconds; the spec handover below is pointless until it
        // answers. 30s because a cold first run is slower than any later one.
        for (let i = 0; i < 30 && !agentUp; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          agentUp = (await agentReady()) === "ok";
        }
        if (!agentUp) {
          // Not fatal — you can still JOIN someone else's match without it. But you can never host,
          // so say so plainly and make sure nothing later overwrites that with a cheerier message.
          const why = started.startsWith("error:") ? started.slice(6).trim() : "it didn't start in time";
          showError(
            "Nova can't host from this PC: " + why +
            "\n\nYou can still join matches other players host. See nova-agent.log next to the launcher."
          );
        }
      }

      // 2) Try to join the mesh (no-op if login already did). If it can't come up — e.g. Tailscale's
      //    driver won't initialise on this Windows build — DON'T block: the host can still play
      //    locally, which is all that's needed to test host-play. Only cross-internet JOINING needs
      //    the mesh, so we just warn that others can't reach this machine.
      let meshIp: string | null = meshStatus?.ip ?? null;
      let meshDown = false;
      if (!meshIp) {
        setP2pStatus("Joining the player network…");
        try {
          const st: any = await invoke("mesh_bring_up", {
            coordinator: COORDINATOR, accountId, token: user.token || "",
            hostname: `nova-${String(accountId).slice(0, 8)}`,
          });
          meshIp = st?.ip ?? null;
          setMeshStatus({ connected: !!st?.connected, ip: st?.ip ?? null, detail: st?.detail || "", needsRestart: !!st?.needsRestart });
          if (!st?.connected) meshDown = true;
        } catch {
          meshDown = true;
        }
      }
      if (meshDown && !meshIp) {
        setP2pStatus("Player network is offline — hosting locally (others can't join over the internet until it's fixed).");
      }

      // 3) Host or join? The coordinator scores every announced machine, so it may briefly ask us to
      //    wait while a better-suited player steps up. Re-poll instead of giving up — that gap is
      //    what previously left a joiner stuck on the matchmaking screen forever.
      let decision: any = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        setP2pStatus(attempt === 0 ? "Finding a match…" : "Waiting for the best host to start…");
        decision = await invoke("p2p_should_i_host", {
          coordinator: COORDINATOR, accountId, playlist: PLAYLIST, region: REGION,
        });
        if (decision?.reason !== "better-host-available") break;
        await new Promise((r) => setTimeout(r, decision?.retryMs || 5000));
      }
      if (!meshIp && decision?.tsIp) meshIp = decision.tsIp;

      // Your game ALWAYS launches first and normally. Whether this machine also needs to run a
      // server is decided later, from live demand — see watchForHostDemand below.
      setP2pStatus("Launching your game…");
      await invoke("firstlaunch", { path: launchPath, accountId, token, eor: EOR, headless: false });

      // The launcher does NOT start or stop the gameserver any more — the backend owns it.
      //
      // We hand over the exact command line for a headless server on this machine (built in Rust so
      // there is one source of truth for Fortnite's arguments). The backend then starts a server the
      // moment the IN-GAME Play press creates real demand with nothing to join, and stops it again
      // when nobody is matchmaking. Previously a server was started here and lived for the
      // launcher's whole lifetime, whether or not anyone ever pressed Play.
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
            // The address OTHER players will be sent to. Loopback only reaches this machine, so
            // without a mesh IP the match is effectively single-PC — which is why the fallback is
            // reported below rather than passing silently.
            address: meshIp || "127.0.0.1",
            accountId,
            name: user?.displayName || "Nova host",
          }),
        });
        if (!res.ok) throw new Error(`agent replied ${res.status}`);
      } catch (e) {
        setP2pStatus("Note: couldn't hand hosting to this machine (" + String(e) + ") — you won't be able to host.");
      }

      // Nothing has been decided yet. `decision` is a SNAPSHOT of the world as it looked a moment ago,
      // and the real choice is made by the coordinator when Play is pressed in game — by which point
      // another player may have started hosting, or stopped. Saying "your PC will host" here was a
      // promise the launcher is in no position to make, and it read as though the launcher had
      // already decided rather than the coordinator deciding later.
      if (!agentUp) {
        setP2pRole(null);
        setP2pStatus("Can't host from this PC (host service didn't start) — you can still join a match.");
      } else if (decision?.host) {
        setP2pRole(null);
        setP2pStatus("Connected. No match open yet — press Play in game and yours will likely be the one that starts.");
      } else {
        setP2pRole(null);
        setP2pStatus("Connected. A match is open — press Play in game to drop into it.");
      }
      void watchHostState(meshIp);
    } catch (err) {
      showError("Launch error: " + String(err));
      setIsLaunching(false);
    }
  };

  /** Host: inject the Reboot server DLL into the running game (click once at the main menu). */
  const handleInjectServer = async () => {
    setInjecting(true);
    setP2pStatus("Injecting Reboot server into your game…");
    try {
      // Prefer the agent's server PID. Without it this falls back to "first process with that name",
      // which once the host is also playing is a coin flip between the server and their own game.
      let pid: number | null = null;
      try { pid = (await (await fetch(`${AGENT}/nova/api/host/status`)).json())?.pid ?? null; } catch { /* fall back */ }
      await invoke("inject_reboot", { dllPath: null, pid });
      setP2pStatus("Reboot injected — your game is now hosting on port 7777. Paste your playit address below and click Register.");
    } catch (e) {
      setP2pStatus("Injection failed: " + String(e));
    } finally {
      setInjecting(false);
    }
  };

  /** Host: register your public playit address so joiners are routed to you. */
  const handleRegisterHost = async () => {
    const addr = playitAddr.trim();
    const i = addr.lastIndexOf(":");
    if (i <= 0) {
      setP2pStatus("Enter your playit address as host:port (e.g. abc.playit.gg:40000).");
      return;
    }
    const address = addr.slice(0, i);
    const port = parseInt(addr.slice(i + 1), 10);
    if (!port) {
      setP2pStatus("That doesn't look like host:port — check the port number.");
      return;
    }
    try {
      await registerHostEverywhere(address, port, user?.displayName || "Nova host");
      // Keep it registered — the coordinator drops a dynamic server after 60s of silence.
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      heartbeatRef.current = setInterval(() => {
        registerHostEverywhere(address, port, user?.displayName || "Nova host").catch(() => {});
      }, 30000);
      setP2pStatus(`Registered ${address}:${port} — heartbeat on. Friends can now join your match!`);
    } catch (e) {
      setP2pStatus("Register failed: " + String(e));
    }
  };

  /** Host-also-plays: launch a 2nd Fortnite instance as your client to join your own server. */
  const handleLaunchClient = async () => {
    const launchPath = path || builds[0]?.path;
    if (!launchPath || !user) { setP2pStatus("No build/login for the client instance."); return; }
    setP2pStatus("Launching your client instance… (heavy — two Fortnite windows).");
    try {
      await invoke("launch_client_only", {
        path: launchPath,
        accountId: user.accountId || user.email,
        token: user.token || user.password,
        eor: EOR,
      });
      setP2pStatus("Client launched. In the NEW Fortnite window, press PLAY to drop into your match.");
    } catch (e) {
      setP2pStatus("Client launch failed: " + String(e));
    }
  };

  const handleLogout = () => {
    // Only clear the SESSION — keep the build library, selected path, and settings (EOR/p2pMode).
    localStorage.removeItem("user");
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null; } // stop host heartbeat
    setUser(null);
    navigate("/login");
  };

  const handleToggleEOR = (next: boolean) => {
    setEOR(next);
    localStorage.setItem("EOR", String(next));
  };

  const handleToggleP2p = (next: boolean) => {
    setP2pMode(next);
    localStorage.setItem("p2pMode", String(next));
  };

  /* -------------------- builds -------------------- */
  const addBuild = async () => {
    const selected = await open({ directory: true });
    if (!selected || typeof selected !== "string") return;
    try {
      const hasEngine = await exists(await join(selected, "Engine"));
      if (!hasEngine) {
        showError("Invalid build: The folder must contain an 'Engine' folder.");
        return;
      }
      if (builds.length >= 16) {
        showError("Maximum builds in library reached (16). Remove one first.");
        return;
      }

      const splashPath = await join(selected, "FortniteGame", "Content", "Splash", "Splash.bmp");
      const hasSplash = await exists(splashPath);

      let coverDataUrl: string | undefined;
      if (hasSplash) {
        const bytes = await readBinaryFile(splashPath);
        const b64 = bytesToBase64(bytes);
        coverDataUrl = "data:image/bmp;base64," + b64;
      }

      const item: BuildItem = {
        id: String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8),
        path: selected,
        name: getFolderName(selected),
        coverDataUrl,
      };
      const updatedBuilds = [item, ...builds];
      setBuilds(updatedBuilds);
      setPath(selected);
      localStorage.setItem("ProjectMP.builds", JSON.stringify(updatedBuilds));
    } catch (e) {
      showError("Could not add build: " + String(e));
    }
  };

  const removeBuild = (id: string) => {
    setBuilds((prev) => {
      const next = prev.filter((b) => b.id !== id);
      const removed = prev.find((b) => b.id === id);
      localStorage.setItem("ProjectMP.builds", JSON.stringify(next));
      if (removed && removed.path === path) {
        if (next[0]) setPath(next[0].path); else setPath(null);
      }
      return next;
    });
  };

  /* -------------------- UI pieces (Epic-like) --------------------
   * These are render FUNCTIONS, not components. Declared here they close over the state above
   * without prop-threading, and because their JSX is spliced into this component's own tree there
   * is no separate component identity to churn — no remount, no lost input focus. */

// left nav (compact Epic style)
const renderLeftNav = () => (
  <div className="w-72 bg-[#0b1724]/70 border-r border-[#1e2a38] flex flex-col backdrop-blur-sm">
    <div className="px-4 py-3 flex items-center gap-3 border-b border-[#14202b]">
      {/* Custom logo image */}
      <div className="w-10 h-10 rounded-md overflow-hidden">
        <img
          src="https://i.ibb.co/1GVGmGPh/logo.png" // replace with your logo path or import
          alt="Logo"
          className="w-full h-full object-cover"
        />
      </div>

      <div className="flex-1">
        <div className="text-sm text-white font-semibold">Project</div>
        <div className="text-xs text-slate-300">Launcher</div>
      </div>
      <div className="text-slate-400 text-xs"></div>
    </div>

    <nav className="p-3 space-y-1 flex-1">
      <NavItem icon={<Home size={18} />} label="Home" active={active === "home"} onClick={() => setActive("home")} />
      <NavItem icon={<Grid size={18} />} label="Library" active={active === "library"} onClick={() => setActive("library")} />
      <NavItem icon={<Terminal size={18} />} label="Logs" active={active === "logs"} onClick={() => setActive("logs")} />
      <div className="mt-4 border-t border-[#14202b] pt-3">
        <NavItem icon={<Settings size={18} />} label="Settings" active={active === "settings"} onClick={() => setActive("settings")} />
      </div>
    </nav>

    <div className="p-3 border-t border-[#14202b]">
      <div className="bg-[#071018]/70 p-3 rounded-md flex items-center gap-3 backdrop-blur-sm">
        <div className="w-9 h-9 rounded-full bg-[#16303e] grid place-items-center text-sm text-white">
          {user?.email ? user.email[0].toUpperCase() : "–"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white truncate">{user?.email ?? "Not signed in"}</div>
          <div className="text-xs text-slate-400">EOR: {EOR ? "On" : "Off"}</div>
        </div>
        <button onClick={handleLogout} className="ml-2 px-2 py-1 rounded-md bg-[#2b4754] text-xs text-white hover:bg-[#334d5b]">
          <LogOut size={14} />
        </button>
      </div>
    </div>
  </div>
);

/* Top bar (Epic-like) */
const renderTopBar = () => (
  <div className="flex items-center justify-between px-6 py-3 bg-[#071422]/75 border-b border-[#0f1b26] backdrop-blur-sm">
    <div className="flex items-center gap-4">
      <div className="h-8 w-8 rounded-full bg-[#0f2940] grid place-items-center text-slate-200"><User size={16} /></div>
      <div className="text-slate-200 text-sm font-medium">{user?.displayName ?? user?.email?.split("@")[0] ?? "Project Nova"}</div>
    </div>

    {/* Live backend/server status + account stats */}
    <StatusBar user={user} />
  </div>
);

  /* Hero carousel / featured area (Epic-like big banner) */
  const renderHeroBanner = () => {
    const current = builds.find((b) => b.path === path) ?? builds[0];
    const hero = current?.coverDataUrl ?? news[0]?.img ?? "https://images.unsplash.com/photo-1542751371-adc38448a04e?q=80&w=1400&auto=format&fit=crop&ixlib=rb-4.0.3&s=eea54b4e7a7f2a91a2b2a2b4d2f4a2b1";
    return (
      <div className="mb-6">
        <div className="relative rounded-xl overflow-hidden border border-[#122432] bg-[#000000]/10 backdrop-blur-sm">
          <img src={hero} alt="hero" className="w-full h-64 object-cover brightness-75" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[#04121a]/80" />
          <div className="absolute left-8 bottom-8 right-8 flex items-center gap-6">
            <div className="w-40 h-24 bg-[#071a24]/60 rounded-md overflow-hidden border border-[#11303b]">
              <img src={hero} alt="thumb" className="w-full h-full object-cover" />
            </div>

            <div className="flex-1">
              <div className="text-2xl font-bold text-white drop-shadow">{current?.name ?? "Featured"}</div>
              <div className="text-sm text-slate-300 mt-1">{current ? `Installed: ${current.path}` : "No build selected — add one in Library"}</div>
              <div className="mt-4 flex items-center gap-3">
                <motion.button onClick={handleLaunch} whileTap={{ scale: 0.98 }} disabled={isLaunching || !current || !user} className="px-6 py-3 rounded-md bg-[#0ea5e9] text-black font-semibold shadow-lg disabled:opacity-60 flex items-center gap-2">
                  <Play size={16} /> {isLaunching ? "Launching..." : "PLAY"}
                </motion.button>

                <button onClick={() => setActive("library")} className="px-4 py-2 rounded-md bg-[#102834]/70 text-slate-200">Library</button>
                <button onClick={() => setActive("news")} className="px-4 py-2 rounded-md bg-[#102834]/70 text-slate-200">Patch Notes</button>
              </div>

              {(p2pStatus || p2pRole) && (
                <div className="mt-3 rounded-md bg-[#071a24]/85 border border-[#11303b] p-3 text-sm max-w-2xl">
                  {p2pRole && (
                    <div className="mb-1">
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${p2pRole === "host" ? "bg-amber-500/20 text-amber-300" : "bg-emerald-500/20 text-emerald-300"}`}>
                        {p2pRole === "host" ? "HOST" : "JOIN"}
                      </span>
                    </div>
                  )}
                  {p2pStatus && <div className="text-slate-200">{p2pStatus}</div>}
                  {p2pRole === "host" && (
                    <div className="mt-2 flex flex-col gap-2">
                      <div className="text-[11px] text-slate-400">
                        Your PC is hosting because no open match was available. The server runs
                        hidden in the background (no game window) — just press Play in your game to
                        drop in. Hosting stops when you close your game.
                      </div>
                      <button onClick={() => stopHosting("Hosting stopped.")} className="px-3 py-1.5 rounded-md bg-red-500/80 hover:bg-red-500 text-white text-xs font-semibold w-max">
                        Stop hosting
                      </button>
                      <details className="text-[11px] text-slate-500">
                        <summary className="cursor-pointer hover:text-slate-300">Something went wrong? Manual controls</summary>
                        <div className="mt-2 flex flex-col gap-2">
                          <button onClick={handleInjectServer} disabled={injecting} className="px-3 py-1.5 rounded-md bg-amber-500 hover:bg-amber-400 text-black text-xs font-semibold disabled:opacity-60 w-max">
                            {injecting ? "Starting…" : "Start server manually (at the main menu)"}
                          </button>
                          <button onClick={handleLaunchClient} className="px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-semibold w-max">
                            Play in my own match (if your game didn't open)
                          </button>
                          <div className="flex items-center gap-2">
                            <input value={playitAddr} onChange={(e) => setPlayitAddr(e.target.value)} placeholder="host:port — only if not using the mesh" className="px-2 py-1 rounded bg-[#0b2130] text-white text-xs border border-[#11303b] flex-1 outline-none" />
                            <button onClick={handleRegisterHost} className="px-3 py-1.5 rounded-md bg-[#0ea5e9] hover:bg-sky-400 text-black text-xs font-semibold">Register</button>
                          </div>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="w-56">
              <div className="bg-[#071824]/60 p-3 rounded-md border border-[#112a34]">
                <div className="text-xs text-slate-400">Status</div>
                <div className="text-sm text-white mt-1">{user?.email ? user.email.split("@")[0] : "Not logged in"}</div>
                <div className="text-xs text-slate-400 mt-1">EOR: {EOR ? "Enabled" : "Disabled"}</div>
                <div className="text-xs text-slate-400 mt-1">
                  Network:{" "}
                  {meshStatus?.connected
                    ? <span className="text-emerald-400" title={meshStatus.ip || ""}>mesh ready</span>
                    : meshStatus?.needsRestart
                      ? <span className="text-amber-400">restart needed</span>
                      : <span className="text-slate-500">{meshStatus ? "direct" : "checking…"}</span>}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3 flex gap-3 overflow-x-auto">
          {news.map((n) => (
            <motion.div key={n.id} whileHover={{ y: -6 }} className="min-w-[260px] rounded-md overflow-hidden border border-[#122432] bg-[#06161d]/70 backdrop-blur-sm">
              <img src={n.img} alt={n.title} className="h-28 w-full object-cover" />
              <div className="p-3">
                <div className="text-xs text-slate-400">{n.date}</div>
                <div className="text-sm text-white font-semibold mt-1">{n.title}</div>
                <div className="text-xs text-slate-300 mt-1 line-clamp-2">{n.desc}</div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    );
  };

  /* Library styled like Epic store grid */
  const renderLibraryPanel = () => (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-xl font-semibold">Library</div>
          <div className="text-xs text-slate-400">Your builds & installs</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={addBuild} className="px-3 py-2 rounded-md bg-[#0f3342]/80 text-slate-200 flex items-center gap-2"><Plus size={14} /> Add Build</button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {builds.length === 0 ? (
          <div className="col-span-full p-6 bg-[#04121a]/60 rounded-md text-slate-400">No builds yet. Click 'Add Build' to import an installation folder containing an Engine folder.</div>
        ) : builds.map((b) => {
          const selected = b.path === path;
          return (
            <motion.div key={b.id} whileHover={{ scale: 1.02 }} className={`rounded-md overflow-hidden border ${selected ? "ring-2 ring-[#0ea5e9]/30" : "border-[#122432]"} bg-[#05131a]/60 backdrop-blur-sm`}>
              <div className="h-40 bg-[#071823]/60 flex items-center justify-center overflow-hidden">
                {b.coverDataUrl ? <img src={b.coverDataUrl} alt={b.name} className="w-full h-full object-cover" /> : <div className="text-xs text-slate-400">No cover</div>}
              </div>
              <div className="p-3">
                <div className="text-sm font-medium text-white truncate">{b.name}</div>
                <div className="text-xs text-slate-400 mt-1 truncate">{getFolderName(b.path)}</div>
                <div className="mt-3 flex items-center gap-2">
                  <button onClick={() => setPath(b.path)} className="px-3 py-1 rounded-md bg-[#0b2a36]/80 text-xs">Select</button>
                  <button onClick={() => { setPath(b.path); handleLaunch(); }} className="px-3 py-1 rounded-md bg-[#0ea5e9] text-xs text-black flex items-center gap-2"><Play size={12} /> Play</button>
                  <button onClick={() => removeBuild(b.id)} className="ml-auto px-2 py-1 rounded-md hover:bg-[#0b2a36] text-slate-300"><Trash2 size={14} /></button>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );

  /* News / patch notes full list */
  const renderNewsPanel = () => (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div><div className="text-xl font-semibold">News</div><div className="text-xs text-slate-400">Patch notes & announcements</div></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {news.map((n) => (
          <div key={n.id} className="rounded-md overflow-hidden border border-[#122432] bg-[#04121a]/60 backdrop-blur-sm">
            <div className="h-44 overflow-hidden"><img src={n.img} alt={n.title} className="w-full h-full object-cover" /></div>
            <div className="p-4">
              <div className="text-xs text-slate-400">{n.date}</div>
              <div className="text-lg text-white font-semibold mt-1">{n.title}</div>
              <div className="text-sm text-slate-300 mt-2">{n.desc}</div>
              <div className="mt-3"><button className="px-3 py-2 rounded-md bg-[#0b2a36] text-slate-200">Read more</button></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

const renderSettingsPanel = () => (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
    {/* General settings */}
    <div className="p-4 rounded-md border border-[#122432] bg-[#04121a]/60 backdrop-blur-sm">
      <div className="text-sm font-semibold">General</div>
      <div className="text-xs text-slate-400 mt-2">Launch options</div>
      <div className="mt-3 flex items-center gap-3">
        <label className="text-sm">EOR (Edit-on-Release)</label>
        <button
          onClick={() => handleToggleEOR(!EOR)}
          className={`ml-auto inline-flex h-7 w-14 items-center rounded-full p-1 ${EOR ? "bg-[#0ea5e9]" : "bg-[#0b2a36]"}`}
        >
          <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${EOR ? "translate-x-7" : "translate-x-0"}`}></span>
        </button>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <label className="text-sm">P2P mode (global)</label>
        <button
          onClick={() => handleToggleP2p(!p2pMode)}
          className={`ml-auto inline-flex h-7 w-14 items-center rounded-full p-1 ${p2pMode ? "bg-[#0ea5e9]" : "bg-[#0b2a36]"}`}
        >
          <span className={`inline-block h-5 w-5 rounded-full bg-white transition-transform ${p2pMode ? "translate-x-7" : "translate-x-0"}`}></span>
        </button>
      </div>
      <div className="text-[11px] text-slate-500 mt-1">On: proxy to the global coordinator + host-election. Off: single-PC / LAN (local backend on 3551).</div>
      <div className="mt-4 text-xs text-slate-400">Selected build</div>
      <div className="text-sm text-white mt-1 truncate">{path ?? "None selected"}</div>
    </div>

    {/* Server & Game controls */}
    <div className="p-4 rounded-md border border-[#122432] bg-[#04121a]/60 backdrop-blur-sm">
      <div className="text-sm font-semibold">Server &amp; Game</div>
      <div className="text-xs text-slate-400 mt-2">Backend + running client</div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => startBackend(p2pMode ? COORDINATOR : undefined)} className="px-3 py-1.5 rounded-md bg-emerald-600/80 hover:bg-emerald-500 text-white text-xs font-medium">Start / Restart Backend</button>
        <button onClick={() => stopGame()} className="px-3 py-1.5 rounded-md bg-red-600/80 hover:bg-red-500 text-white text-xs font-medium">Stop Game</button>
      </div>
      <div className="mt-3 text-[11px] text-slate-500">
        {p2pMode
          ? "Game → 127.0.0.1:3551 (proxy → coordinator) · host agent on 3552"
          : "Backend: 127.0.0.1:3551"} · Fortnite 7.40 (Ch.1 S7)
      </div>
    </div>

    {/* Account / Logout */}
    <div className="p-4 rounded-md border border-[#122432] bg-[#04121a]/60 backdrop-blur-sm">
      <div className="text-sm font-semibold">Account</div>
      <div className="text-xs text-slate-400 mt-2">Signed in as</div>
      <div className="text-sm text-white mt-1">{user?.displayName ?? user?.email ?? "–"}</div>
      <div className="text-[11px] text-slate-500 mt-1 truncate">ID: {user?.accountId ?? "–"}</div>
      <div className="mt-3">
        <button onClick={handleLogout} className="px-3 py-1 rounded-md bg-[#0ea5e9] text-black text-xs">Logout</button>
      </div>
    </div>

    {/* About */}
    <div className="p-4 rounded-md border border-[#122432] bg-[#04121a]/60 backdrop-blur-sm">
      <div className="text-sm font-semibold">About</div>
      <div className="text-xs text-slate-400 mt-2">Project Nova Launcher</div>
      <div className="text-sm text-white mt-1">v1.0.20</div>
      <div className="text-[11px] text-slate-500 mt-2">Builds in library: {builds.length}</div>
    </div>
  </div>
);

  /* -------------------- Render main layout -------------------- */
  return (
    <div
      className="w-screen h-screen flex text-slate-100 relative overflow-hidden"
      style={{
        backgroundImage: "url('https://i.ibb.co/hx42Ndqt/fn.jpg')",
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* Blurred background overlay - visible but not overpowering */}
      <div className="absolute inset-0 backdrop-blur-2xl bg-black/50 z-0" />

      {/* Main content */}
      <div className="relative z-10 flex w-full h-full">
        {renderLeftNav()}
        <div className="flex-1 flex flex-col">
          {renderTopBar()}

          <AnimatePresence>
            {error && (
              <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="absolute right-6 top-6 z-50">
                <div className="bg-red-600/90 text-white px-4 py-2 rounded-md shadow">{error}</div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex-1 overflow-auto p-6">
            {active === "home" && (
              <>
                {renderHeroBanner()}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  <div className="lg:col-span-2">
                    <div className="rounded-md border border-[#122432] p-4 bg-[#04121a]/60 backdrop-blur-sm">
                      <div className="flex items-center justify-between mb-3">
                        <div><div className="text-lg font-semibold">Featured & Highlights</div><div className="text-xs text-slate-400">Top picks from your library</div></div>
                        <div className="flex items-center gap-2">
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {builds.slice(0, 4).length === 0 ? (
                          <div className="p-6 text-slate-400">Nothing featured — add builds to your library to feature them here.</div>
                        ) : builds.slice(0, 4).map(b => (
                          <div key={b.id} className="rounded-md overflow-hidden border border-[#122432] bg-[#06171f]/60 backdrop-blur-sm flex">
                            <div className="w-40 h-28 overflow-hidden">{b.coverDataUrl ? <img src={b.coverDataUrl} alt={b.name} className="w-full h-full object-cover" /> : <div className="w-full h-full grid place-items-center text-slate-400">No cover</div>}</div>
                            <div className="p-3 flex-1">
                              <div className="font-semibold text-white">{b.name}</div>
                              <div className="text-xs text-slate-400 mt-1">{getFolderName(b.path)}</div>
                              <div className="mt-3 flex items-center gap-2">
                                <button onClick={() => { setPath(b.path); handleLaunch(); }} className="px-3 py-1 rounded-md bg-[#0ea5e9] text-black text-xs">Play</button>
                                <button onClick={() => removeBuild(b.id)} className="px-3 py-1 rounded-md bg-[#0b2a36] text-xs">Remove</button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="rounded-md border border-[#122432] p-4 bg-[#04121a]/60 backdrop-blur-sm">
                      <div className="text-sm font-semibold">Quick Actions</div>
                      <div className="mt-3 space-y-2">
                        <button onClick={() => setActive("library")} className="w-full px-3 py-2 rounded-md bg-[#0b2a36]">Open Library</button>
                        <button onClick={() => setActive("news")} className="w-full px-3 py-2 rounded-md bg-[#0b2a36]">View Patch Notes</button>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {active === "library" && renderLibraryPanel()}
            {active === "news" && renderNewsPanel()}
            {active === "logs" && <LogViewer />}
            {active === "settings" && renderSettingsPanel()}
          </div>
        </div>
      </div>
    </div>
  );
}