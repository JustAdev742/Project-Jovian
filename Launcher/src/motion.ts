// src/motion.ts
// One definition of how this launcher moves.
//
// Previously every component invented its own duration and curve — 0.4s here, 0.5s there, 500ms on
// a hover — which is why the interface felt inconsistent even where each individual animation was
// fine. Everything now comes from here.
//
// The house default is a CRITICALLY DAMPED spring: it reaches the target and stops, with no
// overshoot. Bounce is not a garnish — it's a signal that momentum was involved, so it is reserved
// for motion the user physically initiated. A menu that overshoots on open looks broken; a card you
// flicked that overshoots looks right.
//
// Springs also solve interruptibility for free. They animate from wherever the element currently is,
// so grabbing something mid-flight retargets smoothly instead of jumping back to a start value.
import type { Transition, Variants } from "motion/react";

/* ── Springs ────────────────────────────────────────────────────────────────────────────────────
   Expressed with Motion's `bounce` + `duration` API, which maps onto Apple's designer-facing pair:
   bounce ≈ (1 − damping ratio), duration ≈ response. */

/** The default. Critically damped — arrives and settles, never overshoots. */
export const spring: Transition = { type: "spring", bounce: 0, duration: 0.38 };

/** For small, frequent things: toggles, the nav indicator. Quicker, still no overshoot. */
export const springSnappy: Transition = { type: "spring", bounce: 0, duration: 0.26 };

/** Only where the user's own momentum preceded the motion. */
export const springBouncy: Transition = { type: "spring", bounce: 0.22, duration: 0.42 };

/* ── Tweens ─────────────────────────────────────────────────────────────────────────────────────
   For motion with a fixed distance and no chance of interruption — page content arriving, a fade.
   All under the 300ms UI ceiling. */

const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const;

export const tween = { duration: 0.24, ease: EASE_OUT_EXPO } satisfies Transition;
export const tweenFast = { duration: 0.15, ease: EASE_OUT_EXPO } satisfies Transition;

/** Exits are faster than entrances. A leaving element has stopped being interesting — holding it on
 *  screen for as long as it took to arrive makes the whole interface feel slower than it is. */
export const tweenExit = { duration: 0.13, ease: EASE_OUT_EXPO } satisfies Transition;

/* ── Route transitions ──────────────────────────────────────────────────────────────────────────
   Deliberately small. This fires on every navigation — several times a minute — and at that
   frequency anything theatrical becomes an obstacle between the player and what they came for.
   A short lift and fade is enough to say "this is different content" without costing time. */
export const routeVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.26, ease: EASE_OUT_EXPO } },
  exit: { opacity: 0, y: -6, transition: tweenExit },
};

/* ── Lists ──────────────────────────────────────────────────────────────────────────────────────
   30–80ms between siblings reads as one wave. Below that it's simultaneous; above it, the last item
   arrives late enough to feel broken. Capped so a full library doesn't take a second to appear. */
export const STAGGER = 0.045;
export const STAGGER_MAX = 0.27;

export function staggerDelay(index: number): number {
  return Math.min(index * STAGGER, STAGGER_MAX);
}

export const listItemVariants: Variants = {
  initial: { opacity: 0, y: 10, scale: 0.98 },
  animate: (i: number = 0) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { ...spring, delay: staggerDelay(i) },
  }),
  exit: { opacity: 0, scale: 0.97, transition: tweenExit },
};

/* ── Overlays ───────────────────────────────────────────────────────────────────────────────────
   Glass arrives as a material: blur and scale resolve together, so it reads as a real surface
   coming into focus rather than a rectangle fading in.

   Modals stay centred — the origin rule (scale from the trigger) applies to popovers, dropdowns and
   tooltips, which belong to the control that opened them. A modal belongs to the screen. */
export const scrimVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: tween },
  exit: { opacity: 0, transition: tweenExit },
};

export const dialogVariants: Variants = {
  initial: { opacity: 0, scale: 0.96, filter: "blur(8px)" },
  animate: { opacity: 1, scale: 1, filter: "blur(0px)", transition: spring },
  // Exits along the path it entered — down and back, never off in a new direction.
  exit: { opacity: 0, scale: 0.97, filter: "blur(4px)", transition: tweenExit },
};

/* ── Press ──────────────────────────────────────────────────────────────────────────────────────
   Feedback belongs on pointer-DOWN, not on click. Waiting for release to acknowledge a press is the
   single most common way an interface feels dead.

   Asymmetric on purpose: the press is near-instant because the user caused it, the release settles
   on a spring because it's the interface responding. */
export const pressable = {
  whileTap: { scale: 0.975 },
  transition: springSnappy,
} as const;

/** Never scale text-bearing surfaces that fill the window — it blurs during the transform. */
export const pressableSubtle = {
  whileTap: { scale: 0.99 },
  transition: springSnappy,
} as const;
