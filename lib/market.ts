import type { Player, RosterConfig, ScoringConfig } from "./types";
import { adpKeyFor } from "./presets";

export interface MarketReference {
  sleeper: number | null;
  espn: number | null;
  consensus: number | null;
  label: string;
  format: ReturnType<typeof adpKeyFor>;
}

const available = (value: number) => Number.isFinite(value) && value > 0 && value < 999;

/** Sleeper's format-specific ADP is authoritative. ESPN PPR supplements PPR only. */
export function marketReference(
  player: Pick<Player, "adp">,
  scoring: ScoringConfig,
  roster: RosterConfig,
): MarketReference {
  const format = adpKeyFor(scoring, roster);
  const sleeper = available(player.adp[format]) ? player.adp[format] : null;
  const espn = format === "ppr" && available(player.adp.espn) ? player.adp.espn : null;
  const sources = [sleeper, espn].filter((value): value is number => value !== null);
  return {
    sleeper,
    espn,
    consensus: sources.length ? sources.reduce((sum, value) => sum + value, 0) / sources.length : null,
    label: format === "ppr" && espn !== null ? "Sleeper PPR + ESPN PPR" : `Sleeper ${format === "std" ? "Standard" : format === "half" ? "Half-PPR" : format === "superflex" ? "Superflex" : "PPR"}`,
    format,
  };
}

