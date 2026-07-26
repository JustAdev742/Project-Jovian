// src/ui/primitives.tsx
// The launcher's control vocabulary. Everything visual is built from these, so a change to focus
// rings, disabled states or press feedback happens once rather than in fourteen places.
//
// Structure follows the Field / Label / Input composition, with one addition: every field owns its
// error and announces it. An error rendered as a red border is invisible to a screen reader, and an
// error banner at the top of a form doesn't say which box to fix.
import React, { forwardRef, useId } from "react";
import { motion } from "framer-motion";
import { Loader2, Check, AlertCircle, Eye, EyeOff } from "lucide-react";

/* ── Button ─────────────────────────────────────────────────────────────────────────────────── */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "beacon";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  // The cold accent is the default for every affirmative action.
  primary: "bg-frost text-ink hover:bg-frost-dim active:bg-frost-deep font-semibold",
  secondary: "bg-surface-2 text-text border border-line-strong hover:bg-surface-3",
  ghost: "text-muted hover:text-text hover:bg-surface-2",
  danger: "bg-transparent text-bad border border-bad/40 hover:bg-bad/10",
  // Reserved for hosting. See theme.css — warmth means other people depend on this machine.
  beacon: "bg-beacon text-ink hover:bg-beacon-deep font-semibold",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  // 44px, so a pointer target never falls below the accessible minimum.
  md: "h-11 px-4 text-sm gap-2",
  lg: "h-14 px-7 text-base gap-2.5",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, icon, className = "", children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // A button that's busy is still focusable and still announces itself — it just can't be
      // pressed twice. aria-busy is what tells a screen reader the difference.
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={[
        "inline-flex items-center justify-center rounded-[var(--radius-control)]",
        "transition-colors duration-200 cursor-pointer select-none",
        "disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none",
        "active:scale-[0.98] motion-reduce:active:scale-100",
        VARIANTS[variant],
        SIZES[size],
        className,
      ].join(" ")}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

/* ── Field ──────────────────────────────────────────────────────────────────────────────────── */

export type FieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  /** Shown under the field and announced. Also turns the border red. */
  error?: string;
  /** Quiet guidance, replaced by `error` when there is one so they never stack. */
  hint?: string;
  /** Ticks the field when a live check has confirmed it — e.g. "that username is free". */
  valid?: boolean;
  /** Adds a show/hide toggle. */
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
      {/* A visible label, always. Placeholder-as-label disappears exactly when someone needs it. */}
      <label htmlFor={id} className="block text-[13px] font-medium text-muted mb-1.5">
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
            "w-full h-11 rounded-[var(--radius-control)] bg-surface-2 px-3.5 text-sm text-text",
            "border transition-colors duration-200",
            "placeholder:text-faint",
            error ? "border-bad" : "border-line-strong hover:border-frost/50 focus:border-frost",
            reveal || valid ? "pr-11" : "",
            className,
          ].join(" ")}
          {...rest}
        />

        {reveal && (
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            // Icon-only, so it needs a name of its own.
            aria-label={shown ? "Hide password" : "Show password"}
            className="absolute right-1 top-1/2 -translate-y-1/2 size-9 grid place-items-center rounded-md text-muted hover:text-text cursor-pointer"
          >
            {shown ? <EyeOff aria-hidden size={16} /> : <Eye aria-hidden size={16} />}
          </button>
        )}

        {valid && !reveal && !error && (
          <Check aria-hidden size={16} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-good" />
        )}
      </div>

      {(error || hint) && (
        <p
          id={msgId}
          // role="alert" so the reason is spoken the moment it appears, not silently painted red.
          role={error ? "alert" : undefined}
          className={`mt-1.5 text-[12.5px] flex items-start gap-1.5 ${error ? "text-bad" : "text-faint"}`}
        >
          {error && <AlertCircle aria-hidden size={13} className="mt-[3px] shrink-0" />}
          <span>{error || hint}</span>
        </p>
      )}
    </div>
  );
});

/* ── Card ───────────────────────────────────────────────────────────────────────────────────── */

export function Card({
  className = "",
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-[var(--radius-card)] bg-surface border border-line ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line">
      <div className="min-w-0">
        {/* Clear size AND weight separation from body copy, per the typography rule. */}
        <h2 className="font-display text-[15px] font-semibold text-text">{title}</h2>
        {subtitle && <p className="text-[13px] text-muted mt-0.5">{subtitle}</p>}
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
  tone?: "neutral" | "good" | "bad" | "warn" | "frost" | "beacon";
  children: React.ReactNode;
}) {
  const tones = {
    neutral: "bg-surface-3 text-muted border-line-strong",
    good: "bg-good/12 text-good border-good/30",
    bad: "bg-bad/12 text-bad border-bad/30",
    warn: "bg-warn/12 text-warn border-warn/30",
    frost: "bg-frost/12 text-frost border-frost/30",
    beacon: "bg-beacon/12 text-beacon border-beacon/30",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full border text-[11.5px] font-medium ${tones}`}>
      {children}
    </span>
  );
}

/* ── Progress ───────────────────────────────────────────────────────────────────────────────── */

export function Progress({ value, tone = "frost", label }: { value: number; tone?: "frost" | "beacon"; label?: string }) {
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
      <motion.div
        className={`h-full rounded-full ${tone === "beacon" ? "bg-beacon" : "bg-frost"}`}
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
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
    <div className="flex items-start justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <label htmlFor={id} className={`text-sm font-medium ${disabled ? "text-faint" : "text-text"} cursor-pointer`}>
          {label}
        </label>
        {description && <p className="text-[13px] text-muted mt-0.5 leading-snug">{description}</p>}
      </div>
      {/* A real checkbox underneath: keyboard, form semantics and screen-reader state for free. */}
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          "relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200 cursor-pointer",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          checked ? "bg-frost" : "bg-surface-3 border border-line-strong",
        ].join(" ")}
      >
        <motion.span
          className={`absolute top-1/2 -translate-y-1/2 size-4.5 rounded-full ${checked ? "bg-ink" : "bg-muted"}`}
          initial={false}
          animate={{ left: checked ? 24 : 4 }}
          transition={{ type: "spring", stiffness: 500, damping: 32 }}
        />
      </button>
    </div>
  );
}

/* ── Empty state ────────────────────────────────────────────────────────────────────────────── */

/** An empty screen is an invitation to act, so this always takes an action rather than just a mood. */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      <div className="size-12 rounded-xl bg-surface-2 border border-line grid place-items-center text-muted mb-4">
        {icon}
      </div>
      {/* h2, not h3: this is the only heading in the section it fills, and it sits directly under
          the page's h1 — an h3 there skips a level and reads as a missing section to a screen
          reader navigating by headings. */}
      <h2 className="font-display text-[15px] font-semibold text-text">{title}</h2>
      <p className="text-[13px] text-muted mt-1.5 max-w-sm leading-relaxed">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ── Stat ───────────────────────────────────────────────────────────────────────────────────── */

export function Stat({ icon, label, value, tone = "frost" }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: "frost" | "beacon" | "good" | "muted" }) {
  const c = { frost: "text-frost", beacon: "text-beacon", good: "text-good", muted: "text-muted" }[tone];
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className={`${c} shrink-0`}>{icon}</span>
      <div className="min-w-0 leading-tight">
        <div className="text-[10.5px] uppercase tracking-[0.08em] text-faint font-medium">{label}</div>
        {/* Tabular figures so a changing player count doesn't shuffle the layout every poll. */}
        <div className="text-sm font-semibold text-text tabular-nums truncate">{value}</div>
      </div>
    </div>
  );
}
