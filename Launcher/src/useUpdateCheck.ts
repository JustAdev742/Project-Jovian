// src/useUpdateCheck.ts
// Keeping the launcher's idea of "is there an update" honest.
//
// This replaces a single check fired 2.5 seconds after the window opened, whose failure was
// discarded. That timing is the worst possible moment to ask: the launcher has just started, which
// often means the machine has just woken or just connected, and the network is frequently not usable
// yet. When that check failed the state stayed IDLE forever — no button, no badge, and a Settings
// card claiming "Nova checks for updates when it starts", which was true and useless. The only way
// out was to notice and press the button, or reinstall the app.
//
// Three rules here:
//   • A failed check is RETRIED with backoff, instead of being swallowed.
//   • A failure is RECORDED, so the UI can say "couldn't check" rather than implying it never tried.
//   • The launcher stays open for hours, so it keeps checking — a release published at midday should
//     be noticed by an app that opened at nine.
import { useCallback, useEffect, useRef, useState } from "react";
import * as updater from "./updater";
import { IDLE, type UpdateState } from "./updater";

/** First attempt. Late enough not to compete with first paint, early enough to feel immediate. */
const FIRST_DELAY_MS = 2_500;
/** Backoff for failed attempts: ~8s, 30s, 2m, 5m, then every 15 minutes. */
const RETRY_MS = [8_000, 30_000, 120_000, 300_000, 900_000];
/** Re-check cadence once a check has SUCCEEDED. */
const REFRESH_MS = 6 * 60 * 60 * 1000;

export type UpdateCheck = {
  state: UpdateState;
  setState: (s: UpdateState) => void;
  /** Manual "check now", for the button in Settings. */
  checkNow: () => Promise<void>;
};

export function useUpdateCheck(onAvailable?: (version: string) => void): UpdateCheck {
  const [state, setState] = useState<UpdateState>(IDLE);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  const cancelled = useRef(false);
  /** So the "an update exists" notification fires once per version, not on every re-check. */
  const announced = useRef<string | null>(null);

  // Everything the scheduled work needs is read through a ref.
  //
  // The obvious version of this — putting `state.phase` in run's dependency array — produces a new
  // `run` on every state change while the pending timer still holds the OLD one. The retry then
  // reads a stale phase and can undo a good answer. Refs keep one live view of the world and let
  // the scheduling functions stay stable.
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  const onAvailableRef = useRef(onAvailable);
  useEffect(() => { onAvailableRef.current = onAvailable; }, [onAvailable]);

  const runRef = useRef<(manual: boolean) => Promise<void>>(async () => {});

  const schedule = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void runRef.current(false); }, ms);
  }, []);

  const run = useCallback(async (manual: boolean) => {
    if (cancelled.current) return;
    if (manual) setState({ phase: "checking", progress: 0 });

    const res = await updater.check();
    if (cancelled.current) return;

    if (res.phase === "error") {
      failures.current += 1;
      // Show the error for a manual check, or when nothing is known yet. Do NOT overwrite a known
      // "1.3.2 is available" with "couldn't check" just because a later background poll failed —
      // that would throw away the useful answer we already had.
      if (manual || stateRef.current.phase === "idle") setState(res);
      schedule(RETRY_MS[Math.min(failures.current - 1, RETRY_MS.length - 1)]);
      return;
    }

    failures.current = 0;
    setState(res);

    if (res.phase === "available" && res.version && announced.current !== res.version) {
      announced.current = res.version;
      onAvailableRef.current?.(res.version);
    }
    // Nothing left to poll for once it is downloaded and waiting on a restart.
    if (res.phase !== "ready") schedule(REFRESH_MS);
  }, [schedule]);

  useEffect(() => { runRef.current = run; }, [run]);

  useEffect(() => {
    cancelled.current = false;
    schedule(FIRST_DELAY_MS);

    // Coming back online is the best possible moment to retry — it is usually the exact thing that
    // was wrong when the first check failed.
    const onOnline = () => { failures.current = 0; schedule(1_000); };
    window.addEventListener("online", onOnline);

    return () => {
      cancelled.current = true;
      window.removeEventListener("online", onOnline);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [schedule]);

  const checkNow = useCallback(async () => { await runRef.current(true); }, []);

  return { state, setState, checkNow };
}
