// Core domain types for the draft planner.

export type SkillPosition = "QB" | "RB" | "WR" | "TE";
export const POSITIONS: SkillPosition[] = ["QB", "RB", "WR", "TE"];

export type Position = SkillPosition | "K" | "DEF";
export const ALL_POSITIONS: Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** Raw projected season stat totals from Sleeper. All optional. */
export interface RawStats {
  pass_yd?: number;
  pass_td?: number;
  pass_int?: number;
  pass_2pt?: number;
  rush_yd?: number;
  rush_td?: number;
  rush_2pt?: number;
  rec?: number;
  rec_yd?: number;
  rec_td?: number;
  rec_2pt?: number;
  fum_lost?: number;
  gp?: number;
  pts_std?: number; // K/DEF: precomputed season total (no per-stat breakdown)
}

/** ADP across the formats Sleeper exposes (lower = drafted earlier). */
export interface Adp {
  ppr: number;
  half: number;
  std: number;
  superflex: number; // Sleeper's adp_2qb
  espn: number;     // ESPN PPR ADP (999 = not available)
}

/** A normalized, draftable player. Derived values (points/VBD/tier) are
 * computed client-side from the scoring + roster config, not stored here. */
export interface Player {
  id: string;
  name: string;
  position: Position;
  team: string | null;
  yearsExp: number | null;
  injuryStatus: string | null;
  bye: number | null;
  stats: RawStats;
  adp: Adp;
}

/** Per-stat point values. Fully configurable. */
export interface ScoringConfig {
  passYd: number; // points per passing yard (e.g. 0.04 = 1pt / 25yd)
  passTd: number;
  passInt: number;
  rushYd: number; // per rushing yard (e.g. 0.1 = 1pt / 10yd)
  rushTd: number;
  recYd: number; // per receiving yard
  recTd: number;
  rec: number; // points per reception (PPR=1, half=0.5, std=0)
  teRecBonus: number; // extra points per reception for TEs (TE premium)
  fumLost: number;
  twoPt: number;
}

/** Starting lineup + league size. Drives VBD replacement levels. */
export interface RosterConfig {
  teams: number;
  qb: number;
  rb: number;
  wr: number;
  te: number;
  flex: number; // RB/WR/TE
  superflex: number; // QB/RB/WR/TE
  bench: number;
}

/** A player with all config-derived values attached. */
export interface RankedPlayer extends Player {
  points: number; // projected fantasy points under current scoring
  vbd: number; // value over replacement at the player's position
  tier: number; // positional tier (1 = best)
  posRank: number; // rank within position by points (1 = best)
  overallRank: number; // overall rank by VBD (1 = best)
}
