// src/ui/toast.tsx
// Notifications.
//
// This replaces a single `error` string that showed one message at a time and cleared itself on a
// timer — so a second failure silently overwrote the first, and anything that arrived while the
// player was on another screen was never seen at all.
//
// Rules encoded here:
//   • Errors do not auto-dismiss. A message that vanishes before it's read may as well not exist.
//   • Success and info do, because they need acknowledging, not acting on.
//   • Identical messages collapse rather than stacking — a 3-second poll that fails will fail
//     twenty times, and twenty identical toasts is a wall, not information.
import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "warn" | "info";

export type Toast = {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  /** Optional single action, e.g. "Install update" on an update-available notice. */
  action?: { label: string; onClick: () => void };
};

type Ctx = {
  notify: (t: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
};

const ToastCtx = createContext<Ctx | null>(null);

/** Errors persist; everything else clears itself. */
const TTL: Record<ToastKind, number> = {
  success: 4000,
  info: 5000,
  warn: 8000,
  error: 0, // sticky
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const seq = useRef(0);

  const dismiss = useCallback((id: string) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const notify = useCallback((t: Omit<Toast, "id">) => {
    let id = "";
    setToasts((list) => {
      // Collapse a repeat of the message already on screen instead of stacking duplicates.
      const twin = list.find((x) => x.title === t.title && x.body === t.body && x.kind === t.kind);
      if (twin) {
        id = twin.id;
        return list;
      }
      id = `t${++seq.current}`;
      // Cap the stack. Beyond a handful they cover the app they're describing.
      return [...list, { ...t, id }].slice(-4);
    });

    if (id && TTL[t.kind] > 0 && !timers.current.has(id)) {
      const handle = setTimeout(() => dismiss(id), TTL[t.kind]);
      timers.current.set(id, handle);
    }
    return id;
  }, [dismiss]);

  // Clear every pending timer on unmount so nothing fires into a dead tree.
  React.useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

export function useToast(): Ctx {
  const ctx = useContext(ToastCtx);
  // A no-op fallback rather than a throw: a missing provider should never take down the launcher
  // over a notification.
  return ctx ?? { notify: () => "", dismiss: () => {} };
}

const ICONS: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 aria-hidden size={17} className="text-good" />,
  error: <XCircle aria-hidden size={17} className="text-bad" />,
  warn: <AlertTriangle aria-hidden size={17} className="text-warn" />,
  info: <Info aria-hidden size={17} className="text-frost" />,
};

const EDGE: Record<ToastKind, string> = {
  success: "border-l-good",
  error: "border-l-bad",
  warn: "border-l-warn",
  info: "border-l-frost",
};

function ToastViewport({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  return (
    // aria-live so new notifications are announced without stealing focus from whatever the player
    // is doing. Errors are assertive; the rest can wait for a pause.
    <div
      className="fixed bottom-14 right-4 z-50 flex flex-col gap-2 w-[min(23rem,calc(100vw-2rem))] pointer-events-none"
      role="region"
      aria-label="Notifications"
    >
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            role={t.kind === "error" ? "alert" : "status"}
            aria-live={t.kind === "error" ? "assertive" : "polite"}
            initial={{ opacity: 0, x: 24, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            // Exit faster than enter — a leaving element shouldn't hold attention.
            exit={{ opacity: 0, x: 24, scale: 0.97, transition: { duration: 0.15 } }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className={`pointer-events-auto rounded-[var(--radius-control)] bg-surface-2 border border-line border-l-2 ${EDGE[t.kind]} shadow-xl shadow-black/40 px-3.5 py-3`}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 shrink-0">{ICONS[t.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-text leading-snug">{t.title}</p>
                {t.body && <p className="text-[12.5px] text-muted mt-1 leading-relaxed selectable">{t.body}</p>}
                {t.action && (
                  <button
                    onClick={() => {
                      t.action!.onClick();
                      dismiss(t.id);
                    }}
                    className="mt-2 text-[12.5px] font-semibold text-frost hover:text-frost-dim cursor-pointer"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="shrink-0 size-6 grid place-items-center rounded-md text-faint hover:text-text hover:bg-surface-3 cursor-pointer"
              >
                <X aria-hidden size={14} />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
