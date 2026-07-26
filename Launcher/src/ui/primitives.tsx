// src/ui/primitives.tsx
// The control vocabulary. Every visible surface is built from these, so focus rings, press feedback
// and disabled states are defined once instead of drifting across fourteen files.
//
// Two rules hold throughout:
//   • Only `transform` and `opacity` are ever animated. Anything else runs layout on the main thread
//     mid-interaction, which is exactly when there is no budget for it.
//   • Every field owns and announces its own error. A red border is invisible to a screen reader,
//     and a summary at the top of a form doesn't say which box to fix.
import React, { forwardRef, useEffect, useId, useRef } from "react";
import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react";
import { Loader2, Check, AlertCircle, Eye, EyeOff, X } from "lucide-react";
import { spring, springSnappy, tween, pressable, scrimVariants, dialogVariants } from "../motion";

/* ── Button ─────────────────────────────────────────────────────────────────────────────────── */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "live";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-bg font-semibold shadow-[0_1px_2px_rgb(0_0_0/0.3)] hover:bg-accent-hi active:bg-accent-lo",
  secondary:
    "bg-surface-2 text-text border border-edge/70 hover:bg-surface-3 hover:border-edge",
  ghost: "text-text-2 hover:text-text hover:bg-surface-2",
  danger: "text-danger border border-danger/40 hover:bg-danger/10 hover:border-danger/60",
  // Reserved for hosting — see theme.css.
  live: "bg-live text-bg font-semibold shadow-[0_1px_2px_rgb(0_0_0/0.3)] hover:bg-live/90 active:bg-live-lo",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5",
  md: "h-11 px-4 text-sm gap-2",   // 44px — the accessible pointer minimum
  lg: "h-13 px-7 text-md gap-2.5",
};

// HTMLMotionProps rather than ComponentProps<typeof motion.button>: the latter widens `children` to
// include MotionValue, which no caller ever passes and which makes every usage a type error.
export type ButtonProps = Omit<HTMLMotionProps<"button">, "children"> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  children?: React.ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, icon, className = "", children, disabled, ...rest },
  ref,
) {
  return (
    <motion.button
      ref={ref}
      // whileTap fires on pointer-DOWN. Acknowledging a press only on release is the difference
      // between a button that feels connected and one that feels like it's thinking about it.
      whileTap={disabled || loading ? undefined : pressable.whileTap}
      transition={springSnappy}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={[
        "relative inline-flex items-center justify-center rounded-[var(--radius-md)]",
        "transition-colors duration-[var(--dur-base)] cursor-pointer select-none",
        "disabled:opacity-45 disabled:cursor-not-allowed disabled:pointer-events-none",
        VARIANTS[variant],
        SIZES[size],
        className,
      ].join(" ")}
      {...rest}
    >
      {/* The label holds its place while loading — swapping text for a spinner resizes the button
          and shifts everything next to it. */}
      <AnimatePresence initial={false} mode="wait">
        {loading ? (
          <motion.span
            key="load"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={tween}
            className="inline-flex"
          >
            <Loader2 aria-hidden className="size-4 animate-spin" />
          </motion.span>
        ) : icon ? (
          <motion.span key="icon" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={tween} className="inline-flex">
            {icon}
          </motion.span>
        ) : null}
      </AnimatePresence>
      {children}
    </motion.button>
  );
});

/* ── Field ──────────────────────────────────────────────────────────────────────────────────── */

export type FieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
  valid?: boolean;
  reveal?: boolean;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, valid, reveal, className = "", type = "text", ...rest },
  ref,
) {
  const id = useId();
  const msgId = `${id}-msg`;
  const [shown, setShown] = React.useState(false);
  const effectiveType = reveal ? (shown ? "text" : "password") : type;

  return (
    <div className="w-full">
      {/* Always a visible label. A placeholder disappears exactly when it's needed. */}
      <label htmlFor={id} className="block text-sm font-medium text-text-2 mb-1.5">
        {label}
      </label>

      <div className="relative">
        <input
          id={id}
          ref={ref}
          type={effectiveType}
          aria-invalid={!!error || undefined}
          aria-describedby={error || hint ? msgId : undefined}
          className={[
            "w-full h-11 rounded-[var(--radius-md)] bg-surface-2 px-3.5 text-sm text-text",
            "border transition-colors duration-[var(--dur-base)] placeholder:text-text-3",
            error
              ? "border-danger"
              : "border-edge/70 hover:border-edge focus:border-accent focus:bg-surface-3",
            reveal || valid ? "pr-11" : "",
            className,
          ].join(" ")}
          {...rest}
        />

        {reveal && (
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? "Hide password" : "Show password"}
            className="absolute right-1 top-1/2 -translate-y-1/2 size-9 grid place-items-center rounded-[var(--radius-sm)] text-text-3 hover:text-text cursor-pointer transition-colors"
          >
            {shown ? <EyeOff aria-hidden size={16} /> : <Eye aria-hidden size={16} />}
          </button>
        )}

        <AnimatePresence>
          {valid && !reveal && !error && (
            <motion.span
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={spring}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ok"
            >
              <Check aria-hidden size={16} />
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence initial={false}>
        {(error || hint) && (
          <motion.p
            key={error || hint}
            id={msgId}
            // role="alert" so the reason is spoken the moment it appears, not silently painted red.
            role={error ? "alert" : undefined}
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={tween}
            className={`mt-1.5 text-xs flex items-start gap-1.5 ${error ? "text-danger" : "text-text-3"}`}
          >
            {error && <AlertCircle aria-hidden size={13} className="mt-[0.15em] shrink-0" />}
            <span>{error || hint}</span>
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
});

/* ── Card ───────────────────────────────────────────────────────────────────────────────────── */

export function Card({ className = "", children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`material-raised rounded-[var(--radius-lg)] border border-hairline ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-hairline">
      <div className="min-w-0">
        <h2 className="font-display text-md text-text">{title}</h2>
        {subtitle && <p className="text-sm text-text-2 mt-0.5">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/* ── Badge ──────────────────────────────────────────────────────────────────────────────────── */

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "danger" | "warn" | "accent" | "live";
  children: React.ReactNode;
}) {
  const tones = {
    neutral: "bg-surface-3 text-text-2 border-hairline",
    ok: "bg-ok/12 text-ok border-ok/25",
    danger: "bg-danger/12 text-danger border-danger/25",
    warn: "bg-warn/12 text-warn border-warn/25",
    accent: "bg-accent/12 text-accent border-accent/25",
    live: "bg-live/12 text-live border-live/25",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border text-2xs font-medium ${tones}`}>
      {children}
    </span>
  );
}

/* ── Progress ───────────────────────────────────────────────────────────────────────────────── */

export function Progress({ value, tone = "accent", label }: { value: number; tone?: "accent" | "live"; label?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label || "Progress"}
      className="h-1.5 w-full rounded-full bg-surface-3 overflow-hidden"
    >
      {/* scaleX, NOT width. This bar moves DURING a download, when the main thread is already busy —
          animating width would run layout on every frame at the worst possible moment. origin-left
          pins the growth to the left edge, and a CSS transition keeps the whole thing off the main
          thread and inside the reduced-motion rule. */}
      <div
        className={`h-full w-full rounded-full origin-left will-change-transform transition-transform duration-[var(--dur-slow)] ease-[var(--ease-out-expo)] ${tone === "live" ? "bg-live" : "bg-accent"}`}
        style={{ transform: `scaleX(${pct / 100})` }}
      />
    </div>
  );
}

/** Indeterminate: we know it's working, not how far along. */
export function ProgressIndeterminate({ tone = "accent", label = "Working" }: { tone?: "accent" | "live"; label?: string }) {
  return (
    <div role="progressbar" aria-label={label} className="h-1.5 w-full rounded-full bg-surface-3 overflow-hidden">
      <motion.div
        className={`h-full w-1/3 rounded-full ${tone === "live" ? "bg-live" : "bg-accent"}`}
        animate={{ x: ["-110%", "330%"] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}

/* ── Switch ─────────────────────────────────────────────────────────────────────────────────── */

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 py-4">
      <div className="min-w-0">
        <label htmlFor={id} className={`text-sm font-medium ${disabled ? "text-text-3" : "text-text"} cursor-pointer`}>
          {label}
        </label>
        {description && <p className="text-sm text-text-2 mt-1 leading-relaxed">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          // flex + px-1 centres the thumb vertically through LAYOUT, so nothing but Motion ever
          // writes to `transform`. Centring it with `-translate-y-1/2` (or a style transform) puts
          // two owners on the same property: they overwrite each other, and the result is a thumb
          // that loses its centring and then stops moving at all.
          "relative shrink-0 w-11 h-6 rounded-full cursor-pointer flex items-center px-1",
          "transition-colors duration-[var(--dur-base)]",
          "disabled:opacity-45 disabled:cursor-not-allowed",
          checked ? "bg-accent" : "bg-surface-3 border border-edge/60",
        ].join(" ")}
      >
        {/* translateX, never `left` — `left` is a layout property and this is the most-flipped
            control in the app.

            CSS transition rather than Motion. This is predetermined two-state motion, which is
            what CSS transitions are for; they are GPU-composited, interruptible, and — unlike a
            JS animation — the global prefers-reduced-motion rule in theme.css reaches them, so the
            thumb still MOVES for someone who asked for less motion, it just arrives instantly.
            (Motion's animate-prop updates were also not applying here, in dev or production.) */}
        <span
          className={[
            "size-[1.125rem] rounded-full will-change-transform",
            "transition-transform duration-[var(--dur-base)] ease-[var(--ease-out-expo)]",
            checked ? "bg-bg" : "bg-text-2",
          ].join(" ")}
          // Inline `transform`, not Tailwind's `translate-x-*`. In Tailwind v4 those utilities write
          // to the separate `translate` CSS property, which `transition-transform` does not watch —
          // so the thumb would jump instead of sliding. Being explicit keeps one property, one
          // transition, and no surprises.
          style={{ transform: `translateX(${checked ? "1.25rem" : "0rem"})` }}
        />
      </button>
    </div>
  );
}

/* ── Dialog ─────────────────────────────────────────────────────────────────────────────────────
   For the rare thing that genuinely must be answered before continuing. Destructive actions here
   prefer an undo over a confirmation — a dialog people dismiss by reflex protects nobody — so this
   is used sparingly. */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement;
    // Focus the panel so the next Tab lands inside it, and a screen reader reads the title.
    requestAnimationFrame(() => panel.current?.focus());

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      // Trap focus. Without this, Tab walks out of the dialog into the page behind it, which is
      // both confusing and lets someone operate UI the dialog is meant to be blocking.
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Put focus back where it was, so closing doesn't dump the user at the top of the page.
      restoreTo.current?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center p-6">
          {/* Scrim dims the background to focus the task. Clicking it closes — Escape does too. */}
          <motion.div
            variants={scrimVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={onClose}
            className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
          />
          <motion.div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            variants={dialogVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="material-float relative w-full max-w-md rounded-[var(--radius-lg)] border border-hairline p-6 outline-none"
          >
            <button
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-4 size-8 grid place-items-center rounded-[var(--radius-sm)] text-text-3 hover:text-text hover:bg-surface-3 cursor-pointer transition-colors"
            >
              <X aria-hidden size={16} />
            </button>
            <h2 id={titleId} className="font-display text-lg text-text pr-8">{title}</h2>
            {description && <p id={descId} className="text-sm text-text-2 mt-2 leading-relaxed">{description}</p>}
            {children && <div className="mt-4">{children}</div>}
            {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/* ── Empty state ────────────────────────────────────────────────────────────────────────────── */

/** An empty screen is an invitation to act, so this always offers the action. */
export function EmptyState({
  icon, title, body, action,
}: {
  icon: React.ReactNode; title: string; body: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="size-12 rounded-[var(--radius-md)] bg-surface-2 border border-hairline grid place-items-center text-text-3 mb-4">
        {icon}
      </div>
      {/* h2, not h3 — this is the only heading in its section and sits directly under the page h1. */}
      <h2 className="font-display text-md text-text">{title}</h2>
      <p className="text-sm text-text-2 mt-2 max-w-sm leading-relaxed">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ── Stat ───────────────────────────────────────────────────────────────────────────────────── */

export function Stat({
  icon, label, value, tone = "accent",
}: {
  icon: React.ReactNode; label: string; value: React.ReactNode; tone?: "accent" | "live" | "ok" | "muted";
}) {
  const c = { accent: "text-accent", live: "text-live", ok: "text-ok", muted: "text-text-3" }[tone];
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className={`${c} shrink-0`}>{icon}</span>
      <div className="min-w-0 leading-tight">
        <div className="text-2xs uppercase text-text-3 font-medium">{label}</div>
        {/* Tabular figures so a changing player count doesn't reflow the row on every poll. */}
        <div className="text-sm font-semibold text-text tabular-nums truncate">{value}</div>
      </div>
    </div>
  );
}

/* ── Skeleton ───────────────────────────────────────────────────────────────────────────────────
   Reserves the space real content will occupy, so arriving data doesn't shove the layout. */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`rounded-[var(--radius-sm)] bg-surface-2 overflow-hidden ${className}`} aria-hidden>
      <motion.div
        className="h-full w-1/2 bg-gradient-to-r from-transparent via-surface-3 to-transparent"
        animate={{ x: ["-100%", "300%"] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
      />
    </div>
  );
}
