// src/updater.ts
// In-app updates. Tauri's own updater dialog is switched off (tauri.conf.json → updater.dialog:false)
// so the launcher can present this itself: a version, release notes, a progress bar and a restart —
// rather than a bare OS modal that appears before anyone has read what changed.
//
// The point of this file is that updating never requires downloading an installer again.
import { checkUpdate, installUpdate, onUpdaterEvent, type UpdateManifest } from "@tauri-apps/api/updater";
import { relaunch } from "@tauri-apps/api/process";
import { getVersion } from "@tauri-apps/api/app";

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
export async function check(): Promise<UpdateState> {
  try {
    const { shouldUpdate, manifest } = await checkUpdate();
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
    await installUpdate();
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
  if (/signature|pubkey|verify/i.test(raw)) return "That update failed its signature check, so it wasn’t installed.";
  if (/fetch|network|dns|timed? ?out|ENOTFOUND|ECONNREFUSED/i.test(raw)) return "Couldn’t reach the update server — check your internet connection.";
  if (/404|not found|valid release/i.test(raw)) return "No update information was published yet.";
  if (/permission|denied|access/i.test(raw)) return "Windows blocked the update. Try running the launcher as administrator.";
  return raw;
}
