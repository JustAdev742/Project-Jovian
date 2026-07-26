// src/AppShell.tsx
// The frame every signed-in screen lives in: an icon rail on the left, content in the middle, and
// the status ribbon pinned along the bottom.
//
// THE RIBBON IS THE POINT OF THIS DESIGN. Nova has no company servers — when someone presses Play,
// the coordinator picks a player's PC to run the match, and it might be yours. That fact has no
// equivalent in a normal launcher and it deserves more than a green dot, so it gets a permanent
// strip that changes temperature: ice while you're a client, amber the moment your machine is
// carrying other people's match. Colour is the state, not decoration on top of it.
import React from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Snowflake, Home, Library, Terminal, Settings as SettingsIcon,
  UserRound, LogOut, Radio, Wifi, WifiOff, Download,
} from "lucide-react";
import type { MeshRole } from "./useLauncher";
import type { Session } from "./auth";
import { clearSession } from "./auth";

const NAV = [
  { to: "/home", label: "Home", icon: Home },
  { to: "/library", label: "Library", icon: Library },
  { to: "/logs", label: "Logs", icon: Terminal },
  { to: "/account", label: "Account", icon: UserRound },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function AppShell({
  user,
  role,
  status,
  meshIp,
  updateReady,
  onUpdateClick,
  children,
}: {
  user: Session | null;
  role: MeshRole;
  status: string;
  meshIp?: string | null;
  /** Set when an update is downloaded and waiting, so the rail can advertise it. */
  updateReady?: string | null;
  onUpdateClick?: () => void;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const hosting = role === "hosting";

  const signOut = () => {
    // Only the SESSION goes. The build library, selected path and settings survive a sign-out —
    // they describe this machine, not this person.
    clearSession();
    navigate("/signin");
  };

  return (
    <div className={`nova-ambient h-full w-full flex ${hosting ? "is-hosting" : ""}`}>
      {/* ── Rail ───────────────────────────────────────────────────────────────────────────── */}
      <nav
        aria-label="Main"
        className="relative z-10 w-[68px] shrink-0 flex flex-col items-center gap-1 py-4 border-r border-line bg-surface/60 backdrop-blur-xl"
      >
        <div className="size-9 rounded-lg bg-frost/10 border border-frost/25 grid place-items-center text-frost mb-4">
          <Snowflake aria-hidden size={18} />
        </div>

        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              [
                "group relative w-11 h-11 grid place-items-center rounded-[var(--radius-control)]",
                "transition-colors duration-200 cursor-pointer",
                isActive ? "text-frost bg-frost/10" : "text-muted hover:text-text hover:bg-surface-2",
              ].join(" ")
            }
          >
            {({ isActive }) => (
              <>
                <Icon aria-hidden size={19} />
                {/* The icons are the only navigation, so each needs a real name for screen readers
                    and a tooltip for everyone else. */}
                <span className="sr-only">{label}</span>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-[54px] z-30 whitespace-nowrap rounded-md bg-surface-3 border border-line px-2 py-1 text-[12px] text-text opacity-0 group-hover:opacity-100 transition-opacity duration-150"
                >
                  {label}
                </span>
                {isActive && (
                  <motion.span
                    layoutId="rail-active"
                    className="absolute left-0 h-6 w-[2.5px] rounded-r-full bg-frost"
                    transition={{ type: "spring", stiffness: 480, damping: 36 }}
                  />
                )}
              </>
            )}
          </NavLink>
        ))}

        <div className="mt-auto flex flex-col items-center gap-1">
          {updateReady && (
            <button
              onClick={onUpdateClick}
              className="relative w-11 h-11 grid place-items-center rounded-[var(--radius-control)] text-frost hover:bg-frost/10 cursor-pointer"
              aria-label={`Update to version ${updateReady}`}
            >
              <Download aria-hidden size={19} />
              <span className="absolute top-2 right-2 size-2 rounded-full bg-frost ring-2 ring-surface" />
            </button>
          )}
          <button
            onClick={signOut}
            className="w-11 h-11 grid place-items-center rounded-[var(--radius-control)] text-muted hover:text-bad hover:bg-bad/10 transition-colors duration-200 cursor-pointer"
            aria-label="Sign out"
          >
            <LogOut aria-hidden size={18} />
          </button>
        </div>
      </nav>

      {/* ── Content ────────────────────────────────────────────────────────────────────────── */}
      <div className="relative z-10 flex-1 min-w-0 flex flex-col">
        <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>
        <StatusRibbon role={role} status={status} meshIp={meshIp} user={user} />
      </div>
    </div>
  );
}

/* ── The ribbon ─────────────────────────────────────────────────────────────────────────────── */

function StatusRibbon({
  role,
  status,
  meshIp,
  user,
}: {
  role: MeshRole;
  status: string;
  meshIp?: string | null;
  user: Session | null;
}) {
  const hosting = role === "hosting";
  const connected = role !== "offline";

  return (
    <footer
      className={[
        "shrink-0 h-11 flex items-center gap-3 px-4 border-t backdrop-blur-xl transition-colors duration-500",
        hosting ? "border-beacon/30 bg-beacon/[0.07]" : "border-line bg-surface/60",
      ].join(" ")}
    >
      {/* Role. The one element in the app allowed to be warm. */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="relative grid place-items-center size-4">
          {hosting ? <Radio aria-hidden size={14} className="text-beacon" />
            : connected ? <Wifi aria-hidden size={14} className="text-frost" />
            : <WifiOff aria-hidden size={14} className="text-faint" />}
          {hosting && (
            // A slow pulse, only while hosting. Motion here means "this machine is carrying a
            // match right now" — it stops the moment that stops being true.
            <motion.span
              className="absolute inset-0 rounded-full bg-beacon/25"
              animate={{ scale: [1, 1.9, 1], opacity: [0.6, 0, 0.6] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut" }}
            />
          )}
        </span>
        <span
          className={`text-[12.5px] font-semibold tracking-tight ${hosting ? "text-beacon" : connected ? "text-frost" : "text-faint"}`}
        >
          {hosting ? "Hosting" : connected ? "Connected" : "Offline"}
        </span>
      </div>

      <span className="w-px h-4 bg-line shrink-0" aria-hidden />

      {/* Whatever the launcher is doing, in words. aria-live so it's announced as it changes,
          politely — this updates during a launch and must not interrupt anything. */}
      <p
        aria-live="polite"
        className="text-[12.5px] text-muted truncate min-w-0 flex-1"
        title={status || undefined}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={status}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="inline-block"
          >
            {status || (connected ? "Ready when you are." : "Press Play to connect.")}
          </motion.span>
        </AnimatePresence>
      </p>

      {/* Machine identity, in mono because it's data. */}
      <div className="shrink-0 flex items-center gap-3 text-[11.5px] text-faint font-mono selectable">
        {meshIp && <span title="This machine’s address on the player network">{meshIp}</span>}
        {user && <span className="text-muted">{user.username}</span>}
      </div>
    </footer>
  );
}
