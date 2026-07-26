// src/format.ts
// Dates and times, formatted the way the player's own machine writes them.
//
// These used to be `iso.slice(0, 10)`, which hardcodes American-style ISO ordering for everyone.
// Nova's players are not all in one country, and "2026-07-26" is not how most of them write a date.
// Intl asks the OS instead of guessing.

/** e.g. "26 Jul 2026" / "Jul 26, 2026" — whichever the player's locale uses. */
export function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d);
}

/** Date plus the time of day, for "last signed in". */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** Just the clock, for log lines where the date is almost always today. */
export function formatClock(iso?: string | null): string {
  if (!iso) return "--:--:--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(d);
}
