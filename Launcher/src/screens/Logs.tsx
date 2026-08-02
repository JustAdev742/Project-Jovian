// src/screens/Logs.tsx
// Live output from the backend and from the components running inside the game.
//
// This is a diagnostic screen, so it optimises for reading rather than looking good: monospace,
// filterable, copyable, and honest when there is nothing listening (an empty log panel reads as
// "nothing went wrong", when it usually means the thing that COLLECTS logs isn't running).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal, Copy, Pause, Play as PlayIcon, Check } from "lucide-react";
import { Button, Card, Badge, EmptyState } from "../ui/primitives";
import { getLogs, type LogEntry, type ComponentStatus } from "../novaApi";
import { useToast } from "../ui/toast";
import { formatClock } from "../format";
import SelfCheck from "./SelfCheck";

const LEVELS = ["all", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

const LEVEL_COLOR: Record<string, string> = {
  error: "text-danger",
  warn: "text-warn",
  info: "text-accent",
  debug: "text-text-3",
};

export default function Logs() {
  const { notify } = useToast();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statuses, setStatuses] = useState<ComponentStatus[]>([]);
  const [level, setLevel] = useState<Level>("all");
  const [query, setQuery] = useState("");
  const [live, setLive] = useState(true);
  const [copied, setCopied] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!live) return;
      const { logs: l, statuses: s } = await getLogs(400);
      if (cancelled) return;
      setLogs(l);
      setStatuses(s);
    };
    tick();
    const id = window.setInterval(tick, 2500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [live]);

  // Follow the tail, but only while the reader is already at the bottom. Yanking the view down
  // while someone is reading further up is the single most annoying thing a log viewer can do.
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return logs.filter((l) => {
      if (level !== "all" && (l.level || "info").toLowerCase() !== level) return false;
      if (q && !`${l.msg} ${l.source ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, level, query]);

  useEffect(() => {
    if (pinned.current && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [filtered.length]);

  const copyAll = async () => {
    const text = filtered.map((l) => `${l.ts} [${l.level}]${l.source ? ` (${l.source})` : ""} ${l.msg}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      notify({ kind: "error", title: "Couldn’t copy the log", body: "Clipboard access was refused." });
    }
  };

  return (
    <div className="px-8 py-7 h-full flex flex-col min-h-0 max-w-6xl">
      <header className="flex items-end justify-between gap-4 mb-5 shrink-0">
        <div>
          <h1 className="font-display text-2xl font-bold text-text">Logs</h1>
          <p className="text-sm text-text-2 mt-1">
            Start with the self-check below — it names the problem. The raw log underneath is the evidence.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setLive((v) => !v)}
            icon={live ? <Pause aria-hidden size={14} /> : <PlayIcon aria-hidden size={14} />}
          >
            {live ? "Pause" : "Resume"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={copyAll}
            icon={copied ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </header>

      <SelfCheck />

      {/* Component health, above the stream — the summary usually answers the question. */}
      {statuses.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3.5 shrink-0">
          {statuses.map((s) => (
            <Badge key={s.source} tone={s.healthy ? "ok" : "danger"}>
              <span className={`size-1.5 rounded-full ${s.healthy ? "bg-ok" : "bg-danger"}`} aria-hidden />
              {s.source}: {s.text}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex gap-2 mb-3 shrink-0">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter…"
          spellCheck={false}
          aria-label="Filter log messages"
          className="flex-1 h-9 rounded-[var(--radius-md)] bg-surface-2 border border-edge px-3 text-sm text-text placeholder:text-text-3 focus:border-accent"
        />
        <div className="flex rounded-[var(--radius-md)] border border-edge overflow-hidden" role="group" aria-label="Filter by level">
          {LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              aria-pressed={level === l}
              className={[
                "h-9 px-3 text-xs font-medium capitalize transition-colors duration-150 cursor-pointer",
                level === l ? "bg-accent/15 text-accent" : "text-text-2 hover:text-text hover:bg-surface-2",
              ].join(" ")}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <Card className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Terminal aria-hidden size={22} />}
            title={logs.length === 0 ? "Nothing is logging yet" : "No lines match that filter"}
            body={
              logs.length === 0
                ? "The host service starts when you press Play. Until then there’s nothing to report."
                : "Try a different level, or clear the filter."
            }
          />
        ) : (
          <div ref={scroller} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto font-mono text-xs leading-[1.65] p-3.5 selectable">
            {filtered.map((l, i) => (
              <div key={i} className="log-row flex gap-2.5 hover:bg-surface-2/60 px-1.5 -mx-1.5 rounded">
                <span className="text-text-3 shrink-0 tabular-nums">
                  {formatClock(l.ts)}
                </span>
                <span className={`shrink-0 w-11 uppercase text-2xs pt-[3px] font-semibold ${LEVEL_COLOR[(l.level || "").toLowerCase()] || "text-text-3"}`}>
                  {l.level || "log"}
                </span>
                {l.source && <span className="shrink-0 text-accent/60">{l.source}</span>}
                <span className="text-text/90 break-all whitespace-pre-wrap">{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
