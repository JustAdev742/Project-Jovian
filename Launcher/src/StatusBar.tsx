// src/StatusBar.tsx
// Live status strip: backend health, player/match counts, account V-Bucks + level,
// and a one-click "Start Backend" when it's offline. Polls the Nova backend.
import React, { useEffect, useState, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { Users, Swords, Coins, Trophy, Server, Loader2, Play } from "lucide-react";
import { getServerStats, getAccountSummary, startBackend, p2pMode, COORDINATOR, type ServerStats, type AccountSummary } from "./novaApi";

type Props = {
  user: { accountId?: string; email?: string; token?: string; password?: string; displayName?: string } | null;
};

export default function StatusBar({ user }: Props) {
  const [stats, setStats] = useState<ServerStats>({ online: false, players: 0, matches: 0 });
  const [acct, setAcct] = useState<AccountSummary | null>(null);
  const [starting, setStarting] = useState(false);

  const accountId = user?.accountId;
  const token = user?.token;
  const autoStarted = useRef(false);
  const startPollRef = useRef<number | null>(null);
  useEffect(() => () => { if (startPollRef.current) window.clearInterval(startPollRef.current); }, []);

  const refresh = useCallback(async () => {
    const s = await getServerStats();
    setStats(s);
    if (s.online && accountId && token) {
      setAcct(await getAccountSummary(accountId, token, user?.displayName || user?.email?.split("@")[0] || "Player"));
    } else if (!s.online && !autoStarted.current && !p2pMode()) {
      // Auto-start a standalone backend only in NON-P2P mode.
      //
      // In P2P mode 3551 belongs to nova-proxy, and starting a standalone backend here squats that
      // port before the proxy can have it — so the game never reaches the coordinator, and because a
      // standalone backend is not the host agent (which lives on 3552), the launcher then waits
      // forever on "Starting the local host service…". One stray call, two failures.
      autoStarted.current = true;
      startBackend();
    }
  }, [accountId, token, user?.displayName, user?.email]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => { if (!cancelled) await refresh(); };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [refresh]);

  const onStart = async () => {
    setStarting(true);
    // Same reasoning as above: in P2P mode this must start the HOST AGENT, not a standalone backend
    // that would fight the proxy for 3551.
    await startBackend(p2pMode() ? COORDINATOR : undefined);
    // give the backend a few seconds to bind, then refresh a few times. Tracked in a ref so it's
    // also cleared on unmount (was leaking + calling setState on an unmounted component).
    let tries = 0;
    if (startPollRef.current) window.clearInterval(startPollRef.current);
    startPollRef.current = window.setInterval(async () => {
      await refresh();
      if (++tries >= 8) {
        if (startPollRef.current) window.clearInterval(startPollRef.current);
        startPollRef.current = null;
        setStarting(false);
      }
    }, 2000);
  };

  const Pill = ({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: React.ReactNode; accent?: string }) => (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#071824]/70 border border-[#122a34]">
      <span className={accent || "text-[#0ea5e9]"}>{icon}</span>
      <div className="leading-tight">
        <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
        <div className="text-sm font-semibold text-white">{value}</div>
      </div>
    </div>
  );

  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Backend status */}
      <motion.div
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border"
        style={{
          borderColor: stats.online ? "rgba(16,185,129,0.35)" : "rgba(239,68,68,0.35)",
          background: stats.online ? "rgba(6,40,30,0.6)" : "rgba(40,10,10,0.6)",
        }}
        animate={{ opacity: [0.85, 1, 0.85] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <Server size={16} className={stats.online ? "text-emerald-400" : "text-red-400"} />
        <span className="text-sm font-semibold text-white">{stats.online ? "Backend Online" : "Backend Offline"}</span>
        <span className={`w-2 h-2 rounded-full ${stats.online ? "bg-emerald-400" : "bg-red-400"} animate-pulse`} />
      </motion.div>

      {stats.online ? (
        <>
          <Pill icon={<Users size={16} />} label="Players" value={stats.players} />
          <Pill icon={<Swords size={16} />} label="Matches" value={stats.matches} accent="text-fuchsia-400" />
          {acct && <Pill icon={<Coins size={16} />} label="V-Bucks" value={acct.vbucks.toLocaleString()} accent="text-amber-400" />}
          {acct && <Pill icon={<Trophy size={16} />} label="Level" value={acct.level} accent="text-emerald-400" />}
        </>
      ) : (
        <button
          onClick={onStart}
          disabled={starting}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#0ea5e9] text-black text-sm font-semibold hover:bg-[#38bdf8] disabled:opacity-60 transition"
        >
          {starting ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
          {starting ? "Starting backend…" : "Start Backend"}
        </button>
      )}
    </div>
  );
}
