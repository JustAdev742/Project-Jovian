// src/screens/Settings.tsx
// Gameplay, network and updates.
//
// Each switch says what it changes in the player's terms and what the consequence is. "P2P mode" is
// meaningless on its own; "play with everyone else, or keep this PC to itself" is the actual choice.
import { useEffect, useState } from "react";
import { Download, RefreshCw, CheckCircle2, AlertCircle, RotateCw, Info } from "lucide-react";
import { Button, Card, CardHeader, Switch, Progress, Badge } from "../ui/primitives";
import { useToast } from "../ui/toast";
import type { LauncherApi } from "../useLauncher";
import { COORDINATOR } from "../novaApi";
import { formatDate } from "../format";
import * as updater from "../updater";
import type { UpdateState } from "../updater";

export default function Settings({
  api,
  update,
  setUpdate,
}: {
  api: LauncherApi;
  update: UpdateState;
  setUpdate: (s: UpdateState) => void;
}) {
  const { notify } = useToast();
  const [version, setVersion] = useState("…");

  useEffect(() => { updater.currentVersion().then(setVersion); }, []);

  const check = async () => {
    setUpdate({ phase: "checking", progress: 0 });
    const next = await updater.check();
    setUpdate(next);
    if (next.phase === "current") notify({ kind: "success", title: "Nova is up to date", body: `You’re on ${version}.` });
    if (next.phase === "error") notify({ kind: "error", title: "Couldn’t check for updates", body: next.error });
  };

  const install = async () => {
    const done = await updater.install(setUpdate, update.version);
    if (done.phase === "ready") {
      notify({
        kind: "success",
        title: `Nova ${done.version} is ready`,
        body: "Restart to finish updating.",
        action: { label: "Restart now", onClick: () => void updater.restart() },
      });
    } else if (done.phase === "error") {
      notify({ kind: "error", title: "Update failed", body: done.error });
    }
  };

  return (
    <div className="px-8 py-7 max-w-2xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-bold text-text">Settings</h1>
        <p className="text-sm text-text-2 mt-1">How Nova plays, connects and updates.</p>
      </header>

      <div className="space-y-3.5">
        {/* ── Updates ────────────────────────────────────────────────────────────────────────
            First, because it’s the one thing here that changes on its own. */}
        <Card>
          <CardHeader
            title="Updates"
            subtitle={`You're running Nova ${version}`}
            action={
              update.phase === "current" ? <Badge tone="ok"><CheckCircle2 aria-hidden size={11} />Up to date</Badge> :
              update.phase === "available" ? <Badge tone="accent"><Download aria-hidden size={11} />{update.version} available</Badge> :
              update.phase === "ready" ? <Badge tone="ok"><CheckCircle2 aria-hidden size={11} />Ready to restart</Badge> :
              update.phase === "error" ? <Badge tone="danger"><AlertCircle aria-hidden size={11} />Check failed</Badge> : null
            }
          />
          <div className="p-5">
            {update.phase === "downloading" ? (
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <p className="text-sm text-text">Downloading Nova {update.version}…</p>
                  <span className="text-xs text-text-2 font-mono tabular-nums">{Math.round(update.progress)}%</span>
                </div>
                <Progress value={update.progress} label={`Downloading Nova ${update.version}`} />
              </div>
            ) : update.phase === "ready" ? (
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <p className="text-sm text-text-2">
                  Nova {update.version} is installed. It takes effect when the launcher restarts.
                </p>
                <Button icon={<RotateCw aria-hidden size={15} />} onClick={() => void updater.restart()}>
                  Restart now
                </Button>
              </div>
            ) : update.phase === "available" ? (
              <div>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">Nova {update.version} is available</p>
                    {update.date && <p className="text-xs text-text-3 mt-0.5">Released {formatDate(update.date)}</p>}
                  </div>
                  <Button icon={<Download aria-hidden size={15} />} onClick={install}>Install update</Button>
                </div>
                {update.notes && (
                  <div className="mt-3.5 pt-3.5 border-t border-hairline">
                    <p className="text-xs text-text-2 whitespace-pre-wrap leading-relaxed selectable max-h-40 overflow-y-auto">
                      {update.notes}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <p className="text-sm text-text-2">
                  {update.phase === "error"
                    ? update.error
                    : "Nova checks for updates when it starts. You can also check now."}
                </p>
                <Button
                  variant="secondary"
                  loading={update.phase === "checking"}
                  onClick={check}
                  icon={<RefreshCw aria-hidden size={15} />}
                >
                  {update.phase === "checking" ? "Checking…" : "Check for updates"}
                </Button>
              </div>
            )}
          </div>
        </Card>

        {/* ── Network ────────────────────────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Network" subtitle="Who you can play with" />
          <div className="px-5 divide-y divide-hairline">
            <Switch
              checked={api.p2pMode}
              onChange={api.toggleP2p}
              label="Play with everyone"
              description="Join the shared Nova world, where any player’s PC can host a match. Turn this off to play alone on this machine — useful for testing, but nobody else can reach you."
            />
            <div className="py-3.5">
              <p className="text-sm font-medium text-text">Coordinator</p>
              <p className="text-xs text-text-3 font-mono mt-1 break-all selectable">{COORDINATOR}</p>
              {api.mesh && (
                <p className="text-xs text-text-2 mt-2 flex items-start gap-1.5">
                  <Info aria-hidden size={13} className="mt-[3px] shrink-0" />
                  <span>
                    Player network: {api.mesh.connected ? `connected${api.mesh.ip ? ` as ${api.mesh.ip}` : ""}` : "not connected"}
                    {!api.mesh.connected && api.mesh.detail ? ` — ${api.mesh.detail}` : ""}
                  </span>
                </p>
              )}
            </div>
          </div>
        </Card>

        {/* ── Gameplay ───────────────────────────────────────────────────────────────────────── */}
        <Card>
          <CardHeader title="Gameplay" />
          <div className="px-5">
            <Switch
              checked={api.EOR}
              onChange={api.toggleEOR}
              label="Edit on release"
              description="Confirm a build edit the moment you let go of the edit key, instead of pressing again."
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
