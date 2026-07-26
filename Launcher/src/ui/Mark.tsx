// src/ui/Mark.tsx
// The product mark.
//
// This replaces a snowflake, which tied the launcher's identity to one winter season of one game.
// A nova is a star that suddenly brightens — which is what the product is called, and also happens
// to describe exactly what this launcher does: an ordinary machine that flares up and starts serving
// a match for everyone else. It carries no game, no season, and no content-update expiry date.
//
// `live` brightens the core and extends the rays, so the mark itself reports the hosting state
// rather than needing a badge next to it.
export function Mark({ size = 20, live = false }: { size?: number; live?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      // The colour comes from the parent's `color`, so one mark serves the rail, the sign-in screen
      // and the window icon without variants.
      style={{ color: "currentColor" }}
    >
      {/* Four-point star: two crossed lenses. Reads as a burst at 16px and stays crisp at 64px,
          which a many-armed snowflake does not. */}
      <path
        d="M12 1.5c.35 3.9 1.4 6.35 3.1 8.05C16.8 11.25 19.2 12.3 22.5 12c-3.3.35-5.7 1.4-7.4 3.1-1.7 1.7-2.75 4.1-3.1 7.4-.35-3.3-1.4-5.7-3.1-7.4C7.2 13.4 4.8 12.35 1.5 12c3.3-.3 5.7-1.35 7.4-3.05C10.6 7.25 11.65 4.85 12 1.5Z"
        fill="currentColor"
        opacity={live ? 1 : 0.92}
      />
      {/* Diagonal rays, shorter. Present always, brighter when this machine is serving. */}
      <path
        d="M4.4 4.4c1.5 1.15 2.6 1.7 3.5 1.9-.2-.9-.75-2-1.9-3.5 1.5 1.15 2.6 1.7 3.5 1.9M19.6 19.6c-1.5-1.15-2.6-1.7-3.5-1.9.2.9.75 2 1.9 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity={live ? 0.75 : 0.35}
      />
    </svg>
  );
}
