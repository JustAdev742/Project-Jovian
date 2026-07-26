// src/router.tsx
// Routes, session gate, and the state shared across screens.
//
// The launcher API and the session live here rather than inside a screen: the launch sequence keeps
// running while the player moves between Home, Logs and Settings, and re-creating it on navigation
// would abandon a match in progress.
import { useCallback, useEffect, useRef, useState } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { routeVariants } from "./motion";
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
import { useUpdateCheck } from "./useUpdateCheck";

export default function Main() {
  return (
    // HashRouter, not BrowserRouter: the production build is loaded from a file:// URL inside the
    // Tauri window, where path-based routing has no server to resolve a deep link against and any
    // route but "/" would 404 on reload.
    <HashRouter>
      {/* reducedMotion="user" is NOT redundant with the @media rule in theme.css.
          That rule zeroes CSS animation and transition durations, but Motion animates in JavaScript
          — it writes transforms frame by frame, so no CSS override can reach it. Without this,
          every motion element keeps flying for someone who asked the OS for less motion. Motion
          still lets opacity through, so things continue to appear and disappear; they just stop
          moving. State-bearing motion (the Switch thumb, the Progress bar) is deliberately CSS
          rather than JS, so it still ARRIVES under reduced motion — it just arrives instantly. */}
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
  const firstRender = useRef(true);

  // Keep the session in step with what's stored — sign-in and sign-out both write it, and this is
  // the one place that reads it back.
  useEffect(() => { setUser(loadSession()); }, [location.pathname]);

  /* Announce the new screen, and put the keyboard on it.
     In a single-page app the window never reloads, so nothing tells a screen reader the screen
     changed — someone pressing a nav item hears silence and has to go hunting to find out where
     they landed. Two fixes: name the window after the screen (which also labels the taskbar entry,
     since this is a desktop app), and move focus to <main> so the next Tab starts in the content
     rather than back at the top of the rail. */
  useEffect(() => {
    const name = {
      "/play": "Play", "/library": "Library", "/logs": "Logs",
      "/account": "Account", "/settings": "Settings", "/signin": "Sign in",
    }[location.pathname];
    document.title = name ? `${name} · Project Nova` : "Project Nova";

    // Skip the very first render — stealing focus the moment the app opens is hostile.
    if (firstRender.current) { firstRender.current = false; return; }
    const main = document.getElementById("main");
    // preventScroll: the route wrapper is already animating; letting focus scroll as well produces
    // two competing movements.
    main?.focus({ preventScroll: true });
  }, [location.pathname]);

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

  /* Update checking lives in useUpdateCheck: it retries a failed check with backoff, records the
     failure so the UI can say so, re-checks periodically, and retries the moment the machine comes
     back online. The previous version fired once 2.5s after launch and threw the failure away,
     which is why the update button sometimes never appeared. */
  const onUpdateAvailable = useCallback((version: string) => {
    notify({
      kind: "info",
      title: `Nova ${version} is available`,
      body: "Install it from Settings whenever you're ready.",
      action: { label: "Go to Settings", onClick: () => navigate("/settings") },
    });
  }, [notify, navigate]);

  const { state: update, setState: setUpdate, checkNow } = useUpdateCheck(onUpdateAvailable);

  const signedIn = !!user;

  return (
    <Routes>
      <Route path="/signin" element={signedIn ? <Navigate to="/play" replace /> : <SignIn />} />
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
              {/* mode="wait" so the outgoing screen clears before the incoming one arrives.
                  Overlapping them cross-fades two full pages on top of each other, which reads as
                  a flicker rather than a transition. The `key` is the pathname — without it
                  AnimatePresence sees one stable child and never animates. */}
              <AnimatePresence mode="wait" initial={false}>
                {/* `key` only — do NOT also pass `location`. These <Routes> sit inside a parent
                    <Route path="*">, and handing them an explicit absolute location makes every
                    child path fail to match, so everything falls through to the catch-all and the
                    app silently pins itself to /play. The key alone is what AnimatePresence needs. */}
                <Routes key={location.pathname}>
                  <Route path="/play" element={<Page><Home api={api} user={user} /></Page>} />
                  <Route path="/library" element={<Page><Library api={api} /></Page>} />
                  <Route path="/logs" element={<Page><Logs /></Page>} />
                  <Route path="/account" element={<Page><Account user={user} /></Page>} />
                  <Route path="/settings" element={<Page><Settings api={api} update={update} setUpdate={setUpdate} onCheckNow={checkNow} /></Page>} />
                  <Route path="*" element={<Navigate to="/play" replace />} />
                </Routes>
              </AnimatePresence>
            </AppShell>
          )
        }
      />
    </Routes>
  );
}

/**
 * Route transition wrapper.
 *
 * `h-full` matters: Logs sizes its scroller against the height of this element, and a wrapper that
 * only hugs its content would collapse that screen to nothing.
 */
function Page({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      variants={routeVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="h-full"
    >
      {children}
    </motion.div>
  );
}
