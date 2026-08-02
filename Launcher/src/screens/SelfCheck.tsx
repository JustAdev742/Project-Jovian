// src/screens/SelfCheck.tsx
// Turn "it didn't work" into a code you can quote.
//
// This sits above the raw log because the log is only useful to someone who already knows what to
// look for. The failures that actually happen here are invisible from the outside — the game logs
// its own death and exits cleanly, so the launcher looks perfectly healthy while nothing works.
//
// Design notes:
//   • Problems first, and the "all clear" collapsed. Someone opening this is looking for the one
//     thing that is wrong, not reading a checklist.
//   • Every finding carries a stable code (NOVA-301 etc). That code is the deliverable — it survives
//     being retyped from a phone photo, which a log file does not.
//   • Colour is never the only signal: each row has a text label and an icon as well, so it still
//     reads correctly for someone who cannot distinguish the palette.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { Stethoscope, Copy, Check, AlertTriangle, AlertCircle, CircleCheck, CircleHelp } from "lucide-react";
import { Button, Card, CardHeader } from "../ui/primitives";
import { useToast } from "../ui/toast";

type Level = "ok" | "warn" | "error" | "unknown";

type Finding = {
  code: string;
  level: Level;
  title: string;
  detail: string;
  fix: string;
};

type Report = { findings: Finding[]; machine: string; summary: string };

/* Tokens only — these are the same semantic colours the rest of the launcher uses, whose contrast
   was measured when the palette was built (see theme.css). Naming a raw hex here would quietly opt
   this screen out of the high-contrast overrides. */
const TONE: Record<Level, { text: string; ring: string; label: string; Icon: typeof AlertCircle }> = {
  error:   { text: "text-danger", ring: "border-danger/25 bg-danger/10", label: "Problem",   Icon: AlertCircle },
  warn:    { text: "text-warn",   ring: "border-warn/25 bg-warn/10",     label: "Worth knowing", Icon: AlertTriangle },
  unknown: { text: "text-text-3", ring: "border-hairline",               label: "Can’t tell", Icon: CircleHelp },
  ok:      { text: "text-ok",     ring: "border-hairline",               label: "Fine",      Icon: CircleCheck },
};

export default function SelfCheck() {
  const { notify } = useToast();
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      const buildPath = localStorage.getItem("buildPath") ?? "";
      setReport(await invoke<Report>("run_diagnostics", { buildPath }));
    } catch (e) {
      notify({ kind: "error", title: "Self-check failed to run", body: String(e) });
    } finally {
      setRunning(false);
    }
  }, [notify]);

  // Run once on open. Someone who navigated here already believes something is wrong; making them
  // press a button first just adds a step to that.
  useEffect(() => { void run(); }, [run]);

  const copy = useCallback(async () => {
    if (!report) return;
    await navigator.clipboard.writeText(report.summary);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, [report]);

  const problems = report?.findings.filter((f) => f.level === "error" || f.level === "warn") ?? [];
  const clear = report?.findings.filter((f) => f.level === "ok" || f.level === "unknown") ?? [];

  return (
    <Card className="mb-4">
      <CardHeader
        title="Self-check"
        subtitle={report ? report.machine : "Checking this PC…"}
        action={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={run} disabled={running}>
              {running ? "Checking…" : "Re-check"}
            </Button>
            <Button onClick={copy} disabled={!report}>
              {copied ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />}
              {copied ? "Copied" : "Copy report"}
            </Button>
          </div>
        }
      />

      {/* Results replace each other in place, so announce politely rather than interrupting. */}
      <div className="px-5 py-4" role="status" aria-live="polite">
        {!report && (
          <p className="text-sm text-text-2">Looking at this PC and the last time you played…</p>
        )}

        {report && problems.length === 0 && (
          <div className="flex items-start gap-2.5">
            <Stethoscope aria-hidden size={16} className="mt-[2px] shrink-0 text-ok" />
            <p className="text-sm text-text-2">
              Nothing wrong that Nova can see from here. If it still isn’t working, copy this report
              and send it — “no problems found” is itself useful information.
            </p>
          </div>
        )}

        {problems.length > 0 && (
          <ul className="space-y-3">
            {problems.map((f) => {
              const t = TONE[f.level];
              return (
                <li key={f.code} className={`rounded-[var(--radius-md)] border px-4 py-3 ${t.ring}`}>
                  <div className="flex items-start gap-2.5">
                    <t.Icon aria-hidden size={15} className={`mt-[3px] shrink-0 ${t.text}`} />
                    <div className="min-w-0">
                      <p className="text-sm">
                        <span className={`font-semibold ${t.text}`}>{f.title}</span>
                        {/* The label carries the severity in words, so the colour is never load-bearing. */}
                        <span className="text-text-3"> · {t.label} · </span>
                        <span className="font-mono text-xs text-text-3">{f.code}</span>
                      </p>
                      {/* break-words, not truncate: NOVA-101 reports a full filesystem path with no
                          spaces in it, and a path you cannot read is not worth reporting. */}
                      {f.detail && <p className="mt-1 text-sm leading-relaxed text-text-2 break-words">{f.detail}</p>}
                      {f.fix && <p className="mt-1.5 text-sm leading-relaxed text-text break-words">{f.fix}</p>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {clear.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-expanded={showAll}
              className="text-xs text-text-3 hover:text-text-2 transition-colors duration-[var(--dur-base)] cursor-pointer"
            >
              {showAll ? "Hide" : "Show"} the {clear.length} check{clear.length === 1 ? "" : "s"} that passed
            </button>
            {showAll && (
              <ul className="mt-2 space-y-1.5">
                {clear.map((f) => {
                  const t = TONE[f.level];
                  return (
                    <li key={f.code} className="flex items-start gap-2 text-xs text-text-3">
                      <t.Icon aria-hidden size={13} className={`mt-[2px] shrink-0 ${t.text}`} />
                      <span className="min-w-0 break-words">
                        <span className="font-mono">{f.code}</span> · {f.title}
                        {f.detail && <span className="opacity-80"> — {f.detail}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
