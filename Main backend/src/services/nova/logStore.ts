// In-memory ring buffer that captures the backend's console output so the launcher
// can show a live log viewer via GET /nova/api/logs. Call installLogCapture() once,
// early, before other logs run.
/**
 * `source` says which component a line came from — 'backend' for this process, 'cobalt' for the
 * redirect shim running inside the game, and so on. Components that live in another process ship
 * their lines here over HTTP rather than opening console windows of their own, so the launcher's
 * Logs tab is the single place to look.
 */
export type LogEntry = { ts: string; level: string; msg: string; source: string };

/** Latest one-line status per component, for the launcher to display. */
export type ComponentStatus = { source: string; text: string; healthy: boolean; ts: string };

const buffer: LogEntry[] = [];
const MAX = 800;
let installed = false;

const statuses = new Map<string, ComponentStatus>();

/** Anything not in this set is rejected — the ingest endpoint is unauthenticated and local-only. */
const KNOWN_SOURCES = new Set(['cobalt', 'reboot', 'launcher']);
const MAX_MSG = 2000;

function stringify(a: any): string {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  (['log', 'info', 'warn', 'error'] as const).forEach((level) => {
    const orig = (console as any)[level].bind(console);
    (console as any)[level] = (...args: any[]) => {
      try {
        buffer.push({ ts: new Date().toISOString(), level, msg: args.map(stringify).join(' '), source: 'backend' });
        if (buffer.length > MAX) buffer.shift();
      } catch { /* never let logging break the app */ }
      orig(...args);
    };
  });
}

export function getLogs(limit = 200): LogEntry[] {
  return buffer.slice(-Math.max(1, Math.min(limit, MAX)));
}

export function clearLogs(): void {
  buffer.length = 0;
}

/**
 * Accept a batch of log lines from another Nova component (see POST /nova/api/logs/ingest).
 *
 * Everything is bounded and sanitised: an unknown source is rejected, the batch size is capped, and
 * each message is truncated. This endpoint takes no auth because it is reachable only from the local
 * machine and the game process cannot hold a user token — so it must not be a way to flood memory.
 * Returns the number of entries actually accepted.
 */
export function ingestLogs(
  source: string,
  entries: Array<{ level?: string; msg?: string }>,
  status?: { text?: string; healthy?: boolean },
): number {
  const src = String(source || '').toLowerCase();
  if (!KNOWN_SOURCES.has(src)) return 0;

  if (status && typeof status.text === 'string') {
    statuses.set(src, {
      source: src,
      text: status.text.slice(0, 300),
      healthy: status.healthy !== false,
      ts: new Date().toISOString(),
    });
  }

  if (!Array.isArray(entries)) return 0;

  let accepted = 0;
  for (const e of entries.slice(0, 200)) {
    const msg = typeof e?.msg === 'string' ? e.msg.slice(0, MAX_MSG) : '';
    if (!msg) continue;
    const level = typeof e?.level === 'string' ? e.level.slice(0, 16) : 'info';
    buffer.push({ ts: new Date().toISOString(), level, msg, source: src });
    if (buffer.length > MAX) buffer.shift();
    accepted++;
  }
  return accepted;
}

/** Latest status line per component, for the launcher's status UI. */
export function getComponentStatuses(): ComponentStatus[] {
  return [...statuses.values()];
}
