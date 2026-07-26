// src/screens/Home.tsx
// The screen the launcher opens on. One job: get into a match.
//
// Everything competing with Play is either a live fact (who's online, what this PC is doing) or a
// blocker (no build selected). Nothing decorative sits between the player and the button.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Play, Users, Swords, Coins, Trophy, FolderOpen, Radio, Loader2 } from "lucide-react";
import { Button, Card, Stat, Badge } from "../ui/primitives";
import { getServerStats, getAccountSummary, type ServerStats, type AccountSummary } from "../novaApi";
import type { LauncherApi } from "../useLauncher";
import type { Session } from "../auth";
import { getFolderName } from "../useLauncher";

export default function Home({ api, user }: { api: LauncherApi; user: Session | null }) {
  const [stats, setStats] = useState<ServerStats>({ online: false, players: 0, matches: 0 });
  const [acct, setAcct] = useState<AccountSummary | null>(null);

  const hosting = api.role === "hosting";
  const selected = api.path || api.builds[0]?.path || null;

  // Poll live stats. Deliberately does NOT auto-start a backend: in P2P mode port 3551 belongs to
  // nova-proxy, and a standalone backend started here would take it before the proxy could, leaving
  // the game talking to this machine instead of the shared coordinator.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const s = await getServerStats();
      if (cancelled) return;
      setStats(s);
      if (s.online && user?.accountId && user?.token) {
        const a = await getAccountSummary(user.accountId, user.token, user.displayName || "Player");
        if (!cancelled) setAcct(a);
      }
    };
    tick();
    const id = window.setInterval(tick, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [user?.accountId, user?.token, user?.displayName]);

  return (
    <div className="px-8 py-7 max-w-5xl">
      {/* ── Header ─────────────────────────────────────────────────────────────────────────── */}
      <header className="mb-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-frost/80">
          Season 7 · Chapter 1
        </p>
        <h1 className="font-display text-[32px] leading-tight font-bold text-text mt-1">
          {user ? `Welcome back, ${user.displayName}` : "Welcome to Nova"}
        </h1>
      </header>

      {/* ── Play ───────────────────────────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-2.5">
              <Badge tone={stats.online ? "good" : "neutral"}>
                <span className={`size-1.5 rounded-full ${stats.online ? "bg-good" : "bg-faint"}`} aria-hidden />
                {stats.online ? "Nova online" : "Not connected"}
              </Badge>
              {hosting && (
                <Badge tone="beacon">
                  <Radio aria-hidden size={11} />
                  Your PC is hosting
                </Badge>
              )}
            </div>

            <h2 className="font-display text-lg font-semibold text-text">
              {selected ? getFolderName(selected) : "No build selected"}
            </h2>
            <p className="text-[13px] text-muted mt-1 leading-relaxed max-w-md">
              {selected
                ? "Nova launches your game, then decides with the coordinator whether this PC also runs the match server."
                : "Add your Fortnite 7.40 folder to get started."}
            </p>
          </div>

          {selected ? (
            <Button
              size="lg"
              variant={hosting ? "beacon" : "primary"}
              loading={api.isLaunching}
              onClick={api.launch}
              className="w-full sm:w-auto sm:min-w-[11rem]"
            >
              {api.isLaunching ? "Launching…" : "Play"}
              {!api.isLaunching && <Play aria-hidden size={18} fill="currentColor" />}
            </Button>
          ) : (
            <Link to="/library" className="w-full sm:w-auto">
              <Button size="lg" variant="secondary" icon={<FolderOpen aria-hidden size={17} />} className="w-full">
                Add a build
              </Button>
            </Link>
          )}
        </div>

        {/* While launching, the ribbon carries the detail — this bar just shows something is moving. */}
        {api.isLaunching && (
          <div className="h-0.5 w-full bg-surface-3 overflow-hidden" role="presentation">
            <motion.div
              className={`h-full w-1/3 ${hosting ? "bg-beacon" : "bg-frost"}`}
              animate={{ x: ["-100%", "300%"] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>
        )}
      </Card>

      {/* ── Live ───────────────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
        <Card className="px-4 py-3.5">
          <Stat icon={<Users aria-hidden size={17} />} label="Players" value={stats.online ? stats.players : "—"} />
        </Card>
        <Card className="px-4 py-3.5">
          <Stat icon={<Swords aria-hidden size={17} />} label="Matches" value={stats.online ? stats.matches : "—"} tone="frost" />
        </Card>
        <Card className="px-4 py-3.5">
          <Stat icon={<Coins aria-hidden size={17} />} label="V-Bucks" value={acct ? acct.vbucks.toLocaleString() : "—"} tone="beacon" />
        </Card>
        <Card className="px-4 py-3.5">
          <Stat icon={<Trophy aria-hidden size={17} />} label="Level" value={acct ? acct.level : "—"} tone="good" />
        </Card>
      </div>

      {/* ── Hosting ────────────────────────────────────────────────────────────────────────────
          Only appears while this machine is actually the host. A permanent panel explaining hosting
          to someone who isn't hosting is clutter on the screen they use most. */}
      {hosting && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="mt-4"
        >
          <Card className="border-beacon/25 bg-beacon/[0.05]">
            <div className="p-5 flex items-start gap-3.5">
              <span className="mt-0.5 text-beacon shrink-0"><Radio aria-hidden size={18} /></span>
              <div className="min-w-0">
                <h3 className="font-display text-[15px] font-semibold text-beacon">This PC is running the match</h3>
                <p className="text-[13px] text-muted mt-1 leading-relaxed">
                  The coordinator picked your machine, so other players are connecting through it. Keep the
                  launcher open — closing it ends the match for everyone in it.
                </p>
              </div>
            </div>
          </Card>
        </motion.div>
      )}

      {/* Manual hosting — the playit.gg path, for anyone not on the player network. Tucked below
          because the automatic path is what almost everyone uses. */}
      {!hosting && api.mesh && !api.mesh.connected && (
        <Card className="mt-4">
          <div className="p-5">
            <h3 className="font-display text-[14px] font-semibold text-text">Host it yourself</h3>
            <p className="text-[13px] text-muted mt-1 mb-3.5 leading-relaxed">
              The player network isn’t up on this PC{api.mesh.detail ? ` (${api.mesh.detail})` : ""}, so others can't
              reach you automatically. Run playit.gg and publish the address instead.
            </p>
            <div className="flex gap-2 flex-wrap">
              <input
                value={api.playitAddr}
                onChange={(e) => api.setPlayitAddr(e.target.value)}
                placeholder="abc.playit.gg:40000"
                aria-label="Your public playit address"
                className="flex-1 min-w-[12rem] h-10 rounded-[var(--radius-control)] bg-surface-2 border border-line-strong px-3 text-[13px] font-mono text-text placeholder:text-faint focus:border-frost"
              />
              <Button size="sm" variant="secondary" onClick={api.registerHost}>Publish</Button>
              <Button size="sm" variant="ghost" loading={api.injecting} onClick={api.injectServer}>
                {api.injecting ? "Injecting…" : "Inject server"}
              </Button>
              <Button size="sm" variant="ghost" onClick={api.launchClient} icon={<Loader2 aria-hidden size={14} className="hidden" />}>
                Launch 2nd client
              </Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
