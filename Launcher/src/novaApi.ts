// src/novaApi.ts
// Small helper layer for talking to the Project Nova backend from the launcher UI.
import axios from "axios";
import { invoke } from "@tauri-apps/api/tauri";

/** What the GAME talks to. In P2P mode nova-proxy owns this port and forwards to the coordinator, so
 *  account, matchmaking and XMPP calls made here reach the shared world. */
export const BACKEND = "http://127.0.0.1:3551";

/** The local host agent — the backend running alongside the proxy on its own port.
 *
 *  Host control has to be addressed separately from BACKEND. They used to be the same address, which
 *  meant the launcher's "here is how to run a gameserver on this machine" went through the proxy to
 *  the coordinator — a Linux box that cannot run Fortnite — while this machine was never told
 *  anything. Two ports, two destinations, no ambiguity. */
export const AGENT = "http://127.0.0.1:3552";
export const AGENT_PORT = 3552;

/**
 * Is the launcher in shared-coordinator mode? Default yes; Settings can turn it off for single-PC.
 *
 * Anything that starts a backend has to know this. In P2P mode 3551 belongs to nova-proxy and the
 * backend must run as a host agent on AGENT_PORT — starting a standalone one there instead takes the
 * port the game needs and leaves the agent missing.
 */
export function p2pMode(): boolean {
  return localStorage.getItem("p2pMode") !== "false";
}

/** The global coordinator. In P2P mode the local proxy forwards BACKEND → here, so every backend
 *  call in the launcher and the game goes through one address. Single source of truth: change the
 *  deployment here, not in each screen. */
export const COORDINATOR = "https://clientfinder.tail0a8fd0.ts.net:8443";

export type ServerStats = {
  online: boolean;
  players: number;
  matches: number;
};

export type AccountSummary = {
  displayName: string;
  vbucks: number;
  level: number;
};

/**
 * Health + live server stats in one call. /nova/api/sessions is unauthenticated
 * and returns { sessions: [{ playerCount, ... }], totalActive }. If it doesn't
 * respond, the backend is offline.
 */
export async function getServerStats(): Promise<ServerStats> {
  try {
    const { data } = await axios.get(`${BACKEND}/nova/api/sessions`, { timeout: 2500 });
    const sessions: any[] = Array.isArray(data?.sessions) ? data.sessions : [];
    const players = sessions.reduce((n, s) => n + (Number(s?.playerCount) || 0), 0);
    const matches = typeof data?.totalActive === "number" ? data.totalActive : sessions.length;
    return { online: true, players, matches };
  } catch {
    return { online: false, players: 0, matches: 0 };
  }
}

/** Pull the player's V-Bucks (common_core) and level (athena) from the MCP profile. */
export async function getAccountSummary(accountId: string, token: string, fallbackName = "Player"): Promise<AccountSummary> {
  const summary: AccountSummary = { displayName: fallbackName, vbucks: 0, level: 0 };
  const headers = { Authorization: `bearer ${token}`, "Content-Type": "application/json" };
  const url = (profileId: string) =>
    `${BACKEND}/fortnite/api/game/v2/profile/${accountId}/client/QueryProfile?profileId=${profileId}&rvn=-1`;

  try {
    const { data } = await axios.post(url("common_core"), {}, { headers, timeout: 3000 });
    const profile = data?.profileChanges?.[0]?.profile;
    const items: Record<string, any> = profile?.items || {};
    for (const item of Object.values(items)) {
      if (item?.templateId === "Currency:MtxPurchased") { summary.vbucks = Number(item.quantity) || 0; break; }
    }
  } catch { /* leave defaults */ }

  try {
    const { data } = await axios.post(url("athena"), {}, { headers, timeout: 3000 });
    const attrs = data?.profileChanges?.[0]?.profile?.stats?.attributes;
    if (attrs) summary.level = Number(attrs.level) || Number(attrs.accountLevel) || 0;
  } catch { /* leave defaults */ }

  return summary;
}

/**
 * Ask the Tauri (Rust) side to start the Node backend.
 *
 * `agentFor` = the coordinator URL when this machine should run as a HOST AGENT: the game is served
 * by the coordinator (through nova-proxy on 3551), and the backend runs on AGENT_PORT purely to
 * spawn a gameserver here when the coordinator elects this machine. Omit it for a standalone backend
 * that serves the game itself on 3551.
 */
export async function startBackend(agentFor?: string): Promise<string> {
  try {
    await invoke("start_backend", agentFor
      ? { port: AGENT_PORT, coordinator: agentFor }
      : {});
    return "starting";
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

/**
 * Is the local host agent up, answering, and running code this launcher can actually work with?
 *
 * The agent outlives the launcher — it keeps running after the window closes — so after an update
 * you get a NEW launcher talking to an OLD agent, which answers every health check perfectly while
 * missing the very fields the new flow depends on. `ready` is the marker: an agent that doesn't
 * report it can't gate a booting server, so it is stale and must be replaced, not reused.
 */
/** Lowest agent contract this launcher can work with — see AGENT_PROTOCOL in hostRunner.ts. */
export const REQUIRED_AGENT_PROTOCOL = 2;

export async function agentReady(): Promise<"ok" | "stale" | "down"> {
  try {
    const { data } = await axios.get(`${AGENT}/nova/api/host/status`, { timeout: 1500 });
    return Number(data?.agentProtocol ?? 0) >= REQUIRED_AGENT_PROTOCOL ? "ok" : "stale";
  } catch {
    return "down";
  }
}

/**
 * Confirm that 3551 really is the proxy, and that it really is reaching the coordinator.
 *
 * "Did the proxy process start" is not the same question. If a standalone backend already holds
 * 3551 the proxy dies on EADDRINUSE, that backend keeps answering, and everything LOOKS fine — the
 * game connects, the launcher gets sensible replies — while the player is quietly alone on their own
 * machine with no shared matchmaking and no hosting. Both ends serve /nova/api/info, so the only
 * reliable test is whether the answer on 3551 is the SAME server as the coordinator.
 */
export type LinkCheck = {
  ok: boolean;
  /** `port-taken` is recoverable — a stale local backend can simply be stopped. */
  reason: "ok" | "no-coordinator" | "no-listener" | "port-taken";
  detail: string;
};

export async function proxyIsForwarding(coordinator: string): Promise<LinkCheck> {
  let upstream: any;
  try {
    ({ data: upstream } = await axios.get(`${coordinator}/nova/api/info`, { timeout: 8000 }));
  } catch {
    return { ok: false, reason: "no-coordinator", detail: "can't reach the Nova coordinator — check your internet connection" };
  }
  let local: any;
  try {
    ({ data: local } = await axios.get(`${BACKEND}/nova/api/info`, { timeout: 4000 }));
  } catch {
    return { ok: false, reason: "no-listener", detail: "nothing is answering on 127.0.0.1:3551 — the proxy didn’t start (is Node installed?)" };
  }
  if (local?.startedAt && local.startedAt === upstream?.startedAt) {
    return { ok: true, reason: "ok", detail: "connected to the shared Nova coordinator" };
  }
  return {
    ok: false,
    reason: "port-taken",
    detail: "another Nova backend is holding 127.0.0.1:3551, so the game would only see your own machine",
  };
}

/** Force-close the running game. */
export async function stopGame(): Promise<void> {
  try { await invoke("stop_game", {}); } catch { /* ignore */ }
}

/** `source` marks which component emitted the line: "backend", "cobalt", "reboot", ... */
export type LogEntry = { ts: string; level: string; msg: string; source?: string };

/** One-line health summary per component, shown above the log stream. */
export type ComponentStatus = { source: string; text: string; healthy: boolean; ts: string };

/** Live logs for the launcher's log viewer — the backend's own output plus anything the
 *  out-of-process components (Cobalt inside the game) have posted to the ingest endpoint. */
export async function getLogs(limit = 250): Promise<{ logs: LogEntry[]; statuses: ComponentStatus[] }> {
  // BACKEND first (the proxy keeps /nova/api/logs local, so this is still THIS machine's logs), then
  // the agent directly — which is what answers before the proxy has been started, i.e. every moment
  // between opening the launcher and pressing Play.
  for (const base of [BACKEND, AGENT]) {
    try {
      const { data } = await axios.get(`${base}/nova/api/logs?limit=${limit}`, { timeout: 2500 });
      return {
        logs: Array.isArray(data?.logs) ? data.logs : [],
        statuses: Array.isArray(data?.statuses) ? data.statuses : [],
      };
    } catch { /* try the next one */ }
  }
  // Nothing answered. An empty log panel reads as "nothing happened", when what it actually means is
  // that the service which COLLECTS the logs isn't running — which is also why hosting won't work.
  // Say that here rather than showing a blank screen with no explanation.
  return {
    logs: [{
      ts: new Date().toISOString(),
      level: "warn",
      source: "launcher",
      msg: "No log source is running. The local Nova host service (127.0.0.1:3552) isn't answering, " +
           "so this PC can’t host — press Play to start it, or check nova-agent.log next to the launcher.",
    }],
    statuses: [{
      source: "host service",
      text: "not running (127.0.0.1:3552)",
      healthy: false,
      ts: new Date().toISOString(),
    }],
  };
}

/** Backend-served news feed (returns null when offline so the UI can fall back to defaults). */
export async function getNews(): Promise<any[] | null> {
  try {
    const { data } = await axios.get(`${BACKEND}/nova/api/news`, { timeout: 3000 });
    return Array.isArray(data?.news) ? data.news : null;
  } catch {
    return null;
  }
}
