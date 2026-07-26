// src/router.tsx
// Routes, session gate, and the state shared across screens.
//
// The launcher API and the session live here rather than inside a screen: the launch sequence keeps
// running while the player moves between Home, Logs and Settings, and re-creating it on navigation
// would abandon a match in progress.
import { useCallback, useEffect, useState } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { ToastProvider, useToast } from "./ui/toast";
import AppShell from "./AppShell";
import SignIn from "./screens/SignIn";
import Home from "./screens/Home";
import Library from "./screens/Library";
import Logs from "./screens/Logs";
import Settings from "./screens/Settings";
import Account from "./screens/Account";
import { useLauncher } from "./useLauncher";
import { loadSession, type Session } from "./auth";
import * as updater from "./updater";
import { IDLE, type UpdateState } from "./updater";

export default function Main() {
  return (
    // HashRouter, not BrowserRouter: the production build is loaded from a file:// URL inside the
    // Tauri window, where path-based routing has no server to resolve a deep link against and any
    // route but "/" would 404 on reload.
    <HashRouter>
      {/* reducedMotion="user" is NOT redundant with the @media rule in theme.css.
          That rule zeroes CSS animation and transition durations, but Framer Motion animates in
          JavaScript — it writes transforms frame by frame, so no CSS override can reach it. Without
          this every motion.div in the app keeps moving for someone who asked the OS for less
          motion. Framer still lets transform-free properties like opacity through, so things
          continue to appear and disappear; they just stop flying. */}
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </MotionConfig>
    </HashRouter>
  );
}

function Shell() {
  const { notify } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [user, setUser] = useState<Session | null>(() => loadSession());
  const [update, setUpdate] = useState<UpdateState>(IDLE);

  // Keep the session in step with what's stored — sign-in and sign-out both write it, and this is
  // the one place that reads it back.
  useEffect(() => { setUser(loadSession()); }, [location.pathname]);

  const notifyFn = useCallback(
    (t: {
      kind: "success" | "error" | "warn" | "info";
      title: string;
      body?: string;
      action?: { label: string; onClick: () => void };
    }) => { notify(t); },
    [notify],
  );

  const api = useLauncher(user, notifyFn);

  /* Check for an update on startup, quietly.
     Quietly matters: a failed check is normal (offline, GitHub down, a dev build with no endpoint)
     and must not greet someone with an error the moment the launcher opens. Only an update that
     genuinely EXISTS is worth interrupting for, and even then it's a notification with an action —
     never a modal blocking the app someone just opened to play a game. */
  useEffect(() => {
    let cancelled = false;
    const id = window.setTimeout(async () => {
      const res = await updater.check();
      if (cancelled) return;
      if (res.phase !== "available") {
        if (res.phase === "current") setUpdate(res);
        return;
      }
      setUpdate(res);
      notify({
        kind: "info",
        title: `Nova ${res.version} is available`,
        body: "Install it from Settings whenever you’re ready.",
        action: { label: "Go to Settings", onClick: () => navigate("/settings") },
      });
    }, 2500); // after the window has settled, so it never competes with first paint
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [notify, navigate]);

  const signedIn = !!user;

  return (
    <Routes>
      <Route path="/signin" element={signedIn ? <Navigate to="/home" replace /> : <SignIn />} />
      <Route
        path="*"
        element={
          !signedIn ? (
            <Navigate to="/signin" replace />
          ) : (
            <AppShell
              user={user}
              role={api.role}
              status={api.status}
              meshIp={api.mesh?.ip}
              updateReady={update.phase === "available" || update.phase === "ready" ? update.version ?? null : null}
              onUpdateClick={() => navigate("/settings")}
            >
              <Routes>
                <Route path="/home" element={<Home api={api} user={user} />} />
                <Route path="/library" element={<Library api={api} />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/account" element={<Account user={user} />} />
                <Route path="/settings" element={<Settings api={api} update={update} setUpdate={setUpdate} />} />
                <Route path="*" element={<Navigate to="/home" replace />} />
              </Routes>
            </AppShell>
          )
        }
      />
    </Routes>
  );
}
