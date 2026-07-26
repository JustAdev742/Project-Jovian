// src/LogViewer.tsx — live log stream for every Nova component (polls /nova/api/logs).
//
// This is the ONLY place logs surface. Components that run in another process — Cobalt, inside the
// Fortnite client — used to open their own console windows; they now post their lines to the
// backend, which returns them here tagged with a source.
import { useEffect, useRef, useState } from "react";
import { Terminal, Pause, Play, ArrowDownToLine } from "lucide-react";
import { getLogs, type LogEntry, type ComponentStatus } from "./novaApi";

const LEVEL_COLOR: Record<string, string> = {
  error: "text-red-400",
  warn: "text-amber-300",
  info: "text-sky-300",
  debug: "text-slate-500",
  log: "text-slate-300",
};

// Distinct colour per component so a glance tells you who said what.
const SOURCE_STYLE: Record<string, string> = {
  backend: "bg-[#0b2a36] text-sky-300",
  cobalt: "bg-[#1e1b4b] text-indigo-300",
  reboot: "bg-[#2a1a0b] text-amber-300",
  launcher: "bg-[#0b2a1e] text-emerald-300",
};

export default function LogViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [statuses, setStatuses] = useState<ComponentStatus[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (paused || cancelled) return;
      const { logs: l, statuses: s } = await getLogs(300);
      if (cancelled) return;
      setLogs(l);
      setStatuses(s);
    };
    tick();
    const id = window.setInterval(tick, 1500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [paused]);

  const shown = sourceFilter ? logs.filter((l) => (l.source || "backend") === sourceFilter) : logs;
  const sources = Array.from(new Set(logs.map((l) => l.source || "backend"))).sort();

  useEffect(() => {
    if (autoScroll && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [logs, autoScroll]);

  return (
    <div className="rounded-lg border border-[#122432] bg-[#02090e]/80 backdrop-blur-sm overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#122432] bg-[#050f16]/70">
        <div className="flex items-center gap-2 text-slate-200">
          <Terminal size={16} className="text-[#0ea5e9]" />
          <span className="text-sm font-semibold">Logs</span>
          <span className="text-[11px] text-slate-500">({shown.length} lines · live)</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Filter by component. "All" clears it. */}
          {sources.length > 1 && (
            <div className="flex items-center gap-1 mr-1">
              <button
                onClick={() => setSourceFilter(null)}
                className={`px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide ${
                  sourceFilter === null ? "bg-[#0ea5e9] text-black" : "bg-[#0b2a36] text-slate-300"
                }`}
              >
                All
              </button>
              {sources.map((s) => (
                <button
                  key={s}
                  onClick={() => setSourceFilter(sourceFilter === s ? null : s)}
                  className={`px-2 py-1 rounded-md text-[10px] font-semibold uppercase tracking-wide ${
                    sourceFilter === s ? "bg-[#0ea5e9] text-black" : SOURCE_STYLE[s] || "bg-[#0b2a36] text-slate-300"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => setAutoScroll((s) => !s)}
            title="Auto-scroll"
            className={`p-1.5 rounded-md text-xs ${autoScroll ? "bg-[#0ea5e9] text-black" : "bg-[#0b2a36] text-slate-300"}`}
          >
            <ArrowDownToLine size={14} />
          </button>
          <button
            onClick={() => setPaused((p) => !p)}
            title={paused ? "Resume" : "Pause"}
            className="p-1.5 rounded-md bg-[#0b2a36] text-slate-300 text-xs hover:bg-[#12384a]"
          >
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
        </div>
      </div>

      {/* Component health. Cobalt runs inside the game and has no window of its own, so this line
          is the only place its state is visible. */}
      {statuses.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 py-2 border-b border-[#122432] bg-[#040d13]/60">
          {statuses.map((s) => (
            <div key={s.source} className="flex items-center gap-1.5 text-[11px]">
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${s.healthy ? "bg-emerald-400" : "bg-red-400"}`}
                aria-hidden="true"
              />
              <span className="font-semibold uppercase tracking-wide text-slate-400">{s.source}</span>
              <span className={s.healthy ? "text-slate-400" : "text-red-300"}>{s.text}</span>
            </div>
          ))}
        </div>
      )}

      <div ref={boxRef} className="h-[60vh] overflow-auto p-3 font-mono text-[12px] leading-relaxed">
        {shown.length === 0 ? (
          <div className="text-slate-500 p-4">
            No logs yet. Make sure the backend is running (Start Backend in the top bar), then interact with the game.
          </div>
        ) : (
          shown.map((l, i) => {
            const src = l.source || "backend";
            return (
              <div key={i} className="whitespace-pre-wrap break-words hover:bg-white/[0.03] px-1 rounded">
                <span className="text-slate-600">{l.ts.slice(11, 19)} </span>
                <span className={`px-1 rounded text-[10px] font-bold uppercase ${SOURCE_STYLE[src] || "bg-[#0b2a36] text-slate-300"}`}>
                  {src}
                </span>
                <span className={`${LEVEL_COLOR[l.level] || "text-slate-300"} uppercase text-[10px] font-bold`}> {l.level}</span>
                <span className="text-slate-300"> {l.msg}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
