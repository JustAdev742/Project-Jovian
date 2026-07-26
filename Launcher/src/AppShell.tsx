// src/AppShell.tsx
// The frame every signed-in screen lives in: a rail on the left, content in the middle, a status
// ribbon along the bottom.
//
// THE RIBBON IS THE IDEA. Nova has no company servers — press Play and the coordinator picks a
// player's PC to run the match, possibly yours. Nothing in an ordinary launcher expresses that, so
// it gets a permanent strip that changes temperature: neutral while you're a client, --live the
// moment your machine is carrying other people's game. Colour IS the state, not decoration over it.
//
// Nav labels name their contents ("Play", "Library", "Logs") rather than vague umbrellas —
// "Home" tells you nothing about what you'd find there, and the label, the route and the page
// heading all use the same word so you always know where you landed.
import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  Gamepad2, Library, ScrollText, Settings as SettingsIcon,
  UserRound, LogOut, Radio, Wifi, WifiOff, Download,
} from "lucide-react";
import { Mark } from "./ui/Mark";
import { springSnappy, tween } from "./motion";
import type { MeshRole } from "./useLauncher";
import type { Session } from "./auth";
import { clearSession } from "./auth";

const NAV = [
  { to: "/play", label: "Play", icon: Gamepad2 },
  { to: "/library", label: "Library", icon: Library },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/account", label: "Account", icon: UserRound },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function AppShell({
  user, role, status, meshIp, updateReady, onUpdateClick, children,
}: {
  user: Session | null;
  role: MeshRole;
  status: string;
  meshIp?: string | null;
  updateReady?: string | null;
  onUpdateClick?: () => void;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const live = role === "hosting";

  const signOut = () => {
    // Only the SESSION goes. The build library, selected path and settings describe this machine,
    // not this person, so they survive a sign-out.
    clearSession();
    navigate("/signin");
  };

  return (
    <div className={`ambient grain h-full w-full flex ${live ? "is-live" : ""}`}>
      {/* Bypass block (WCAG 2.4.1). Five nav items sit before the content on every screen, and a
          keyboard user otherwise tabs through all of them to reach anything. Off-screen until
          focused, then it lands in place as the first thing Tab reaches. */}
      {/* Positioned off-screen rather than using .sr-only + focus:not-sr-only. Our .sr-only lives
          outside Tailwind's layers, and unlayered CSS beats layered utilities regardless of order —
          so focus:not-sr-only silently lost and the link stayed invisible even when focused. Its
          own transform sidesteps the whole question. */}
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/* ── Rail ───────────────────────────────────────────────────────────────────────────────
          Translucent chrome with content scrolling under it; the hairline reads as the edge of the
          glass rather than a drawn border. */}
      <nav
        aria-label="Main"
        className="material-chrome relative z-20 w-[4.5rem] shrink-0 flex flex-col items-center gap-1 py-4 border-r border-hairline"
      >
        <div className={`size-9 grid place-items-center mb-4 transition-colors duration-[var(--dur-slow)] ${live ? "text-live" : "text-accent"}`}>
          <Mark size={22} live={live} />
        </div>

        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              [
                "group relative w-11 h-11 grid place-items-center rounded-[var(--radius-md)]",
                "transition-colors duration-[var(--dur-base)] cursor-pointer",
                isActive ? "text-accent" : "text-text-3 hover:text-text hover:bg-surface-2",
              ].join(" ")
            }
          >
            {({ isActive }) => (
              <>
                {/* The active pill sits BEHIND the icon and is shared between items via layoutId,
                    so it slides to the new route instead of blinking out and in. */}
                {isActive && (
                  <motion.span
                    layoutId="rail-active"
                    className="absolute inset-0 rounded-[var(--radius-md)] bg-accent/12 border border-accent/20"
                    transition={springSnappy}
                  />
                )}
                <Icon aria-hidden size={19} className="relative z-10" />
                {/* Icons are the only navigation, so each needs a real name for screen readers and
                    a tooltip for everyone else. */}
                <span className="sr-only">{label}</span>
                <span
                  role="tooltip"
                  className="material-float pointer-events-none absolute left-[3.5rem] z-30 whitespace-nowrap rounded-[var(--radius-sm)] px-2 py-1 text-xs text-text opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-[opacity,transform] duration-[var(--dur-base)]"
                >
                  {label}
                </span>
              </>
            )}
          </NavLink>
        ))}

        <div className="mt-auto flex flex-col items-center gap-1">
          {updateReady && (
            <motion.button
              onClick={onUpdateClick}
              whileTap={{ scale: 0.94 }}
              transition={springSnappy}
              className="relative w-11 h-11 grid place-items-center rounded-[var(--radius-md)] text-accent hover:bg-accent/10 cursor-pointer transition-colors"
              aria-label={`Update available: version ${updateReady}`}
            >
              <Download aria-hidden size={19} />
              <span className="absolute top-2 right-2 size-2 rounded-full bg-accent ring-2 ring-surface-1" />
            </motion.button>
          )}
          <motion.button
            onClick={signOut}
            whileTap={{ scale: 0.94 }}
            transition={springSnappy}
            className="w-11 h-11 grid place-items-center rounded-[var(--radius-md)] text-text-3 hover:text-danger hover:bg-danger/10 transition-colors duration-[var(--dur-base)] cursor-pointer"
            aria-label="Sign out"
          >
            <LogOut aria-hidden size={18} />
          </motion.button>
        </div>
      </nav>

      {/* ── Content ────────────────────────────────────────────────────────────────────────── */}
      <div className="relative z-10 flex-1 min-w-0 flex flex-col">
        {/* tabIndex={-1} so the skip link and the route-change handler can move focus here. Without
            a focusable target, "Skip to content" moves the scroll position but leaves the keyboard
            exactly where it was, which is worse than not having it. */}
        <main id="main" tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto scroll-fade-b outline-none">
          {children}
        </main>
        <StatusRibbon role={role} status={status} meshIp={meshIp} user={user} />
      </div>
    </div>
  );
}

/* ── The ribbon ─────────────────────────────────────────────────────────────────────────────── */

function StatusRibbon({
  role, status, meshIp, user,
}: {
  role: MeshRole; status: string; meshIp?: string | null; user: Session | null;
}) {
  const live = role === "hosting";
  const connected = role !== "offline";

  return (
    <footer
      className={[
        "material-chrome relative z-20 shrink-0 h-11 flex items-center gap-3 px-4 border-t",
        "transition-colors duration-[var(--dur-slow)]",
        live ? "border-live/30" : "border-hairline",
      ].join(" ")}
    >
      <div className="flex items-center gap-2 shrink-0">
        <span className="relative grid place-items-center size-4">
          {live ? <Radio aria-hidden size={14} className="text-live" />
            : connected ? <Wifi aria-hidden size={14} className="text-accent" />
            : <WifiOff aria-hidden size={14} className="text-text-3" />}
          {live && (
            // A slow pulse, only while hosting. It means "this machine is carrying a match right
            // now" and stops the instant that stops being true.
            <motion.span
              className="absolute inset-0 rounded-full bg-live/25"
              animate={{ scale: [1, 1.9, 1], opacity: [0.55, 0, 0.55] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut" }}
            />
          )}
        </span>
        <span className={`text-xs font-semibold ${live ? "text-live" : connected ? "text-accent" : "text-text-3"}`}>
          {live ? "Hosting" : connected ? "Connected" : "Offline"}
        </span>
      </div>

      <span className="w-px h-4 bg-hairline shrink-0" aria-hidden />

      {/* What the launcher is doing, in words. aria-live so it's announced as it changes — politely,
          because this updates throughout a launch and must not interrupt anything. */}
      <p aria-live="polite" className="text-xs text-text-2 truncate min-w-0 flex-1" title={status || undefined}>
        <motion.span
          key={status}
          initial={{ opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={tween}
          className="inline-block"
        >
          {status || (connected ? "Ready when you are." : "Press Play to connect.")}
        </motion.span>
      </p>

      <div className="shrink-0 flex items-center gap-3 text-2xs text-text-3 font-mono selectable">
        {meshIp && <span title="This machine’s address on the player network">{meshIp}</span>}
        {user && <span className="text-text-2">{user.username}</span>}
      </div>
    </footer>
  );
}
