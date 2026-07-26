// src/updater.ts
// In-app updates. Tauri's own updater dialog is switched off (tauri.conf.json → updater.dialog:false)
// so the launcher can present this itself: a version, release notes, a progress bar and a restart —
// rather than a bare OS modal that appears before anyone has read what changed.
//
// The point of this file is that updating never requires downloading an installer again.
import { checkUpdate, installUpdate, onUpdaterEvent, type UpdateManifest } from "@tauri-apps/api/updater";
import { relaunch } from "@tauri-apps/api/process";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/tauri";
import { AGENT_PORT } from "./novaApi";

/**
 * Stop everything the launcher spawned out of its own install folder, before an update overwrites it.
 *
 * Windows will not let a running executable be replaced. The launcher runs nova-proxy AND the host
 * agent from `resources/node/node.exe` inside the install directory, and those keep running after the
 * launcher window closes — so the installer reaches that file, finds it locked, and stops dead on
 * "Error opening file for writing". The update then half-applies: some files replaced, some not.
 *
 * Every call is best-effort. A machine where the proxy was never started should still update.
 */
async function releaseInstalledFiles(): Promise<void> {
  // The proxy, by the PID the launcher recorded when it started it.
  await invoke("stop_proxy").catch(() => {});
  // The host agent. It outlives the launcher on purpose (so a match survives closing the window),
  // which is exactly why it has to be stopped explicitly here.
  await invoke("free_port", { port: AGENT_PORT }).catch(() => {});
  // ...and whatever is on 3551, in case the proxy was started by an older build that didn't record
  // its PID.
  await invoke("free_port", { port: 3551 }).catch(() => {});
  // Windows releases the file handle asynchronously after the process exits. Installing immediately
  // can still hit the lock, and this is a one-off cost on a path the user already expects to wait on.
  await new Promise((r) => setTimeout(r, 1500));
}

export type UpdatePhase =
  | "idle"          // nothing has been asked yet
  | "checking"
  | "available"     // there IS one, waiting on the player
  | "downloading"
  | "ready"         // installed; needs a restart
  | "current"       // already the newest version
  | "error";

export type UpdateState = {
  phase: UpdatePhase;
  /** The version we'd move to, once known. */
  version?: string;
  /** Release notes from latest.json, shown before anyone commits to installing. */
  notes?: string;
  date?: string;
  /** 0-100 while downloading. Tauri v1 reports DOWNLOADED without byte counts on some platforms,
   *  so treat this as indicative: it always reaches 100, it just may not do so smoothly. */
  progress: number;
  error?: string;
};

export const IDLE: UpdateState = { phase: "idle", progress: 0 };

/** Version of the running launcher, for the settings/about screen. */
export async function currentVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return "dev";
  }
}

/**
 * Is there a newer release?
 *
 * Never throws: a failed check is a normal condition (no internet, GitHub down, running a dev build
 * with no updater endpoint) and must not take the launcher down with it. Startup calls this quietly.
 */
/**
 * Nothing here is allowed to hang forever.
 *
 * checkUpdate() does not always reject when it cannot get an answer — it can simply never settle.
 * A stalled connection (captive portal, DNS blackhole, a half-open socket after the machine wakes)
 * leaves the await pending for the life of the process. That is the difference between "no update
 * found" and "we never found out", and the second one used to look like the first: no error, no
 * retry, no button, and a Settings card sitting on "Checking…" indefinitely. Reinstalling appeared
 * to fix it only because it restarted the process.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms),
    ),
  ]);
}

const CHECK_TIMEOUT_MS = 20_000;

export async function check(): Promise<UpdateState> {
  try {
    const { shouldUpdate, manifest } = await withTimeout(checkUpdate(), CHECK_TIMEOUT_MS, "The update check");
    if (!shouldUpdate || !manifest) return { phase: "current", progress: 0 };
    const m = manifest as UpdateManifest;
    return {
      phase: "available",
      version: m.version,
      notes: m.body || undefined,
      date: m.date || undefined,
      progress: 0,
    };
  } catch (e) {
    return { phase: "error", progress: 0, error: friendly(e) };
  }
}

/**
 * Download and install, reporting progress as it goes.
 *
 * `onState` is called repeatedly; the caller re-renders from it. Resolves once the update is staged
 * and a restart is all that's left — it deliberately does NOT relaunch on its own, because doing so
 * mid-match would be worse than the update is good. See `restart()`.
 */
export async function install(onState: (s: UpdateState) => void, version?: string): Promise<UpdateState> {
  let unlisten: (() => void) | undefined;
  let downloaded = 0;
  let total = 0;
  const emit = (s: Partial<UpdateState>) =>
    onState({ phase: "downloading", version, progress: Math.min(99, Math.round(total ? (downloaded / total) * 100 : 0)), ...s } as UpdateState);

  try {
    // Tauri v1's updater emits status strings; on some builds it also emits byte counts via the
    // download-progress event. Listen to both and use whichever we actually get.
    // v1 statuses are PENDING (started) → DONE (installed), or ERROR / UPTODATE.
    unlisten = await onUpdaterEvent(({ status, error }) => {
      if (error) emit({ phase: "error", error: friendly(error) });
      else if (status === "PENDING") emit({ progress: 5 });
      else if (status === "DONE") emit({ progress: 100 });
    });

    // Byte-level progress where the platform provides it, so the bar moves for real instead of
    // jumping 0 → 100 and looking frozen in between on a slow connection.
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<{ chunkLength?: number; contentLength?: number }>(
        "tauri://update-download-progress",
        (ev) => {
          downloaded += Number(ev.payload?.chunkLength) || 0;
          if (!total) total = Number(ev.payload?.contentLength) || 0;
          emit({});
        },
      );
      const prev = unlisten;
      unlisten = () => { try { off(); } catch {} try { prev?.(); } catch {} };
    } catch { /* older API surface — status events alone will do */ }

    emit({ progress: 1 });
    // MUST happen before installUpdate(). See releaseInstalledFiles above — without it the NSIS
    // installer hits a locked node.exe and halts mid-write.
    onState({ phase: "downloading", version, progress: 2 } as UpdateState);
    await releaseInstalledFiles();
    // Bounded for the same reason as the check, but far more generously: this is a ~33 MB download
    // that then runs an installer, and someone on a slow line is not stuck, they are waiting. Ten
    // minutes is long enough that no real install trips it, and short enough that a dead connection
    // eventually says so instead of leaving the progress bar up until the app is closed.
    await withTimeout(installUpdate(), 10 * 60_000, "The update download");
    const done: UpdateState = { phase: "ready", version, progress: 100 };
    onState(done);
    return done;
  } catch (e) {
    const failed: UpdateState = { phase: "error", progress: 0, version, error: friendly(e) };
    onState(failed);
    return failed;
  } finally {
    try { unlisten?.(); } catch {}
  }
}

/** Restart into the new version. Only ever called because someone pressed the button. */
export async function restart(): Promise<void> {
  try {
    await relaunch();
  } catch {
    // If relaunch is unavailable the update is still staged and applies next launch, so this is
    // not worth an error dialog.
  }
}

/**
 * Turn an updater failure into something a player can act on.
 *
 * The raw errors here are things like "Could not fetch a valid release JSON" — accurate, and useless
 * to someone who just wants to know whether it's them or us.
 */
function friendly(e: unknown): string {
  const raw = typeof e === "string" ? e : (e as Error)?.message || String(e);
  if (/timed out/i.test(raw)) return "The update server didn’t respond. Nova will try again shortly.";
  if (/signature|pubkey|verify/i.test(raw)) return "That update failed its signature check, so it wasn’t installed.";
  // The classic Windows one: something is still running out of the install folder.
  if (/opening file for writing|being used by another process|sharing violation|os error 32/i.test(raw)) {
    return "A Nova process is still running, so the files couldn’t be replaced. Close Nova completely (and any Fortnite window) and try again.";
  }
  if (/fetch|network|dns|timed? ?out|ENOTFOUND|ECONNREFUSED/i.test(raw)) return "Couldn’t reach the update server — check your internet connection.";
  if (/404|not found|valid release/i.test(raw)) return "No update information was published yet.";
  if (/permission|denied|access/i.test(raw)) return "Windows blocked the update. Try running the launcher as administrator.";
  return raw;
}
