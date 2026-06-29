import type { RosterConfig, ScoringConfig } from "./types";

/** Base scoring shared by all presets (yards, TDs, INTs, fumbles, 2pt). */
const BASE: Omit<ScoringConfig, "rec" | "teRecBonus"> = {
  passYd: 0.04, // 1 pt / 25 yd
  passTd: 4,
  passInt: -2,
  rushYd: 0.1, // 1 pt / 10 yd
  rushTd: 6,
  recYd: 0.1,
  recTd: 6,
  fumLost: -2,
  twoPt: 2,
};

export const SCORING_PRESETS: Record<string, ScoringConfig> = {
  PPR: { ...BASE, rec: 1, teRecBonus: 0 },
  "Half-PPR": { ...BASE, rec: 0.5, teRecBonus: 0 },
  Standard: { ...BASE, rec: 0, teRecBonus: 0 },
  "TE Premium": { ...BASE, rec: 1, teRecBonus: 0.5 },
};

export const ROSTER_PRESETS: Record<string, RosterConfig> = {
  "12-team standard": {
    teams: 12,
    qb: 1,
    rb: 2,
    wr: 2,
    te: 1,
    flex: 1,
    superflex: 0,
    bench: 6,
  },
  "12-team Superflex": {
    teams: 12,
    qb: 1,
    rb: 2,
    wr: 2,
    te: 1,
    flex: 1,
    superflex: 1,
    bench: 6,
  },
  "10-team standard": {
    teams: 10,
    qb: 1,
    rb: 2,
    wr: 2,
    te: 1,
    flex: 1,
    superflex: 0,
    bench: 6,
  },
};

export const DEFAULT_SCORING = SCORING_PRESETS["PPR"];
export const DEFAULT_ROSTER = ROSTER_PRESETS["12-team standard"];

/** Which ADP column best matches a scoring/roster config, for display. */
export function adpKeyFor(
  scoring: ScoringConfig,
  roster: RosterConfig
): "ppr" | "half" | "std" | "superflex" {
  if (roster.superflex > 0) return "superflex";
  if (scoring.rec >= 0.75) return "ppr";
  if (scoring.rec > 0) return "half";
  return "std";
}
