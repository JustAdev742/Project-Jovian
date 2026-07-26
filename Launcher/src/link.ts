// src/link.ts
// Brings up the launcher's link to the backend BEFORE anything tries to use it.
//
// Why this exists: everything in the launcher (and the game, via Cobalt) talks to
// http://127.0.0.1:3551. In P2P mode nothing is listening there until the local proxy is started,
// and the proxy is what forwards that port to the global coordinator. Logging in is the very first
// thing that needs the backend, so the proxy has to be running before the login screen is usable —
// otherwise sign-in fails with a misleading "wrong email or password" on a perfectly good account.
import axios from "axios";
import { invoke } from "@tauri-apps/api/tauri";
import { BACKEND, COORDINATOR } from "./novaApi";

export type LinkState = {
  ok: boolean;
  /** Short, user-facing explanation. Safe to show in the UI. */
  detail: string;
  mode: "p2p" | "local";
};

export function isP2pMode(): boolean {
  return localStorage.getItem("p2pMode") !== "false";
}

/** Is something answering on 127.0.0.1:3551 right now? */
export async function backendReachable(timeoutMs = 2500): Promise<boolean> {
  try {
    const { status } = await axios.get(`${BACKEND}/nova/api/info`, { timeout: timeoutMs });
    return status >= 200 && status < 500; // any HTTP answer means the port is served
  } catch {
    return false;
  }
}

let inFlight: Promise<LinkState> | null = null;

/**
 * Ensure the launcher can reach the backend, starting the proxy if needed.
 * Concurrent callers share one attempt — the login screen and the app shell both call this, and
 * starting two proxies would leave one of them fighting for the port.
 */
export async function ensureBackendLink(): Promise<LinkState> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<LinkState> => {
    const p2p = isP2pMode();

    // Already reachable — nothing to do (proxy already up, or a local backend is running).
    if (await backendReachable()) {
      return { ok: true, detail: "connected", mode: p2p ? "p2p" : "local" };
    }

    if (!p2p) {
      return {
        ok: false,
        mode: "local",
        detail: "P2P mode is off and no local backend is running on 127.0.0.1:3551. Start it from Settings, or turn P2P mode on to use the global server.",
      };
    }

    try {
      await invoke("start_proxy", { coordinator: COORDINATOR, proxyDir: null });
    } catch (e) {
      return {
        ok: false,
        mode: "p2p",
        detail: `Couldn't start the connection to the game server: ${String(e)}`,
      };
    }

    // The proxy needs a moment to bind. Poll rather than guessing a fixed delay.
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await backendReachable(1500)) {
        return { ok: true, detail: "connected", mode: "p2p" };
      }
    }
    return {
      ok: false,
      mode: "p2p",
      detail: "Started the connection but the game server didn't answer. Check your internet, then try again.",
    };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
