import type { Position } from "./types";

// Shared Tailwind class maps for rendering a player's position, moved here
// from components/DraftBoard.tsx (POS_BADGE, POS_DOT) and components/MockDraft.tsx
// (UNKNOWN_BADGE) so every screen renders positions with the same styling.
// Not yet wired into components — they still have their own local copies and
// will switch to importing these in a later phase.

/** Badge (background/text/border) classes per known position. */
export const POS_BADGE: Record<Position, string> = {
  QB:  "bg-rose-500/15 text-rose-300 border-rose-500/30",
  RB:  "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  WR:  "bg-sky-500/15 text-sky-300 border-sky-500/30",
  TE:  "bg-amber-500/15 text-amber-300 border-amber-500/30",
  K:   "bg-violet-500/15 text-violet-300 border-violet-500/30",
  DEF: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};

/** Fallback badge classes for a position that isn't a known `Position`
 *  (e.g. an unrecognized roster slot type). */
export const UNKNOWN_BADGE = "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";

/** Solid dot color per position, e.g. for compact legends/markers. */
export const POS_DOT: Record<Position, string> = {
  QB:  "#fb7185",
  RB:  "#34d399",
  WR:  "#38bdf8",
  TE:  "#fbbf24",
  K:   "#a78bfa",
  DEF: "#fb923c",
};
