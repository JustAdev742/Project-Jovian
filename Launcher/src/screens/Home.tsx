// src/screens/Home.tsx
// The screen the launcher opens on. One job: get into a match.
//
// Everything that competes with Play is either a live fact (who is online, what this PC is doing) or
// a blocker (no build selected). Nothing decorative sits between the player and the button.
//
// The build and season are read from the backend rather than typed in here, so a content update
// doesn't leave the launcher describing a game it is no longer running.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "motion/react";
import { Play, Users, Swords, Coins, Trophy, FolderOpen, Radio } from "lucide-react";
import { Button, Card, Stat, Badge, ProgressIndeterminate } from "../ui/primitives";
import {
  getServerStats, getAccountSummary, getBuildInfo,
  type ServerStats, type AccountSummary, type BuildInfo,
} from "../novaApi";
import { spring, listItemVariants } from "../motion";
import type { LauncherApi } from "../useLauncher";
import type { Session } from "../auth";
import { getFolderName } from "../useLauncher";

export default function Home({ api, user }: { api: LauncherApi; user: Session | null }) {
  const [stats, setStats] = useState<ServerStats>({ online: false, players: 0, matches: 0 });
  const [acct, setAcct] = useState<AccountSummary | null>(null);
  const [info, setInfo] = useState<BuildInfo | null>(null);

  const live = api.role === "hosting";
  const selected = api.path || api.builds[0]?.path || null;

  // Polls live stats. Deliberately does NOT auto-start a backend: in P2P mode port 3551 belongs to
  // nova-proxy, and a standalone backend started here would take it before the proxy could — leaving
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

  useEffect(() => { getBuildInfo().then(setInfo); }, [stats.online]);

  const cards = [
    { icon: <Users aria-hidden size={17} />, label: "Players", value: stats.online ? stats.players : "—", tone: "accent" as const },
    { icon: <Swords aria-hidden size={17} />, label: "Matches", value: stats.online ? stats.matches : "—", tone: "accent" as const },
    { icon: <Coins aria-hidden size={17} />, label: "V-Bucks", value: acct ? acct.vbucks.toLocaleString() : "—", tone: "live" as const },
    { icon: <Trophy aria-hidden size={17} />, label: "Level", value: acct ? acct.level : "—", tone: "ok" as const },
  ];

  return (
    <div className="px-8 py-8 pb-12 max-w-5xl">
      <header className="mb-7">
        <h1 className="font-display text-3xl text-text">
          {user ? `Welcome back, ${user.displayName}` : "Welcome to Nova"}
        </h1>
        <p className="text-sm text-text-2 mt-1.5">
          {stats.online ? "Connected to the shared world." : "Press Play to connect and find a match."}
        </p>
      </header>

      {/* ── Play ───────────────────────────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <Badge tone={stats.online ? "ok" : "neutral"}>
                <span className={`size-1.5 rounded-full ${stats.online ? "bg-ok" : "bg-text-3"}`} aria-hidden />
                {stats.online ? "Online" : "Not connected"}
              </Badge>
              {/* Straight from the backend — no hardcoded season anywhere in the chrome. */}
              {info && <Badge tone="neutral">Season {info.season} · Build {info.build}</Badge>}
              {live && <Badge tone="live"><Radio aria-hidden size={11} />Hosting</Badge>}
            </div>

            <h2 className="font-display text-xl text-text truncate">
              {selected ? getFolderName(selected) : "No build selected"}
            </h2>
            <p className="text-sm text-text-2 mt-1.5 leading-relaxed max-w-md">
              {selected
                ? "Nova launches your game, then decides with the coordinator whether this PC also runs the match server."
                : "Add a Fortnite folder to get started."}
            </p>
          </div>

          {selected ? (
            <Button
              size="lg"
              variant={live ? "live" : "primary"}
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

        {/* While launching, the ribbon carries the detail — this only says something is moving. */}
        {api.isLaunching && <ProgressIndeterminate tone={live ? "live" : "accent"} label="Launching" />}
      </Card>

      {/* ── Live figures ───────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
        {cards.map((c, i) => (
          <motion.div key={c.label} custom={i} variants={listItemVariants} initial="initial" animate="animate">
            <Card className="px-4 py-4">
              <Stat icon={c.icon} label={c.label} value={c.value} tone={c.tone} />
            </Card>
          </motion.div>
        ))}
      </div>

      {/* ── Hosting ────────────────────────────────────────────────────────────────────────────
          Only while this machine actually is the host. A permanent panel explaining hosting to
          someone who isn't hosting is clutter on the screen they see most. */}
      {live && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mt-4">
          <Card className="border-live/25">
            <div className="p-5 flex items-start gap-3.5">
              <span className="mt-0.5 text-live shrink-0"><Radio aria-hidden size={18} /></span>
              <div className="min-w-0">
                <h2 className="font-display text-md text-live">This PC is running the match</h2>
                <p className="text-sm text-text-2 mt-1.5 leading-relaxed">
                  The coordinator picked your machine, so other players are connecting through it. Keep the
                  launcher open — closing it ends the match for everyone in it.
                </p>
              </div>
            </div>
          </Card>
        </motion.div>
      )}

      {/* Manual hosting — for anyone the player network can't reach automatically. Tucked below,
          because the automatic path is what almost everyone uses. */}
      {!live && api.mesh && !api.mesh.connected && (
        <Card className="mt-4">
          <div className="p-5">
            <h2 className="font-display text-md text-text">Host it yourself</h2>
            <p className="text-sm text-text-2 mt-1.5 mb-4 leading-relaxed">
              The player network isn’t up on this PC{api.mesh.detail ? ` (${api.mesh.detail})` : ""}, so others can’t
              reach you automatically. Run playit.gg and publish the address instead.
            </p>
            <div className="flex gap-2 flex-wrap">
              <input
                value={api.playitAddr}
                onChange={(e) => api.setPlayitAddr(e.target.value)}
                placeholder="abc.playit.gg:40000"
                aria-label="Your public playit address"
                spellCheck={false}
                className="flex-1 min-w-[12rem] h-10 rounded-[var(--radius-md)] bg-surface-2 border border-edge/70 hover:border-edge focus:border-accent px-3 text-sm font-mono text-text placeholder:text-text-3 transition-colors"
              />
              <Button size="sm" variant="secondary" onClick={api.registerHost}>Publish</Button>
              <Button size="sm" variant="ghost" loading={api.injecting} onClick={api.injectServer}>
                {api.injecting ? "Injecting…" : "Inject server"}
              </Button>
              <Button size="sm" variant="ghost" onClick={api.launchClient}>Launch 2nd client</Button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
