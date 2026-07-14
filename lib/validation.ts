import type { RosterConfig, ScoringConfig } from "./types";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown, min: number, max: number): value is number => finite(value) && Number.isInteger(value) && value >= min && value <= max;

export function validScoring(value: unknown): value is ScoringConfig {
  if (!value || typeof value !== "object") return false;
  return ["passYd", "passTd", "passInt", "rushYd", "rushTd", "recYd", "recTd", "rec", "teRecBonus", "fumLost", "twoPt"]
    .every((key) => finite((value as Record<string, unknown>)[key]));
}

export function validRoster(value: unknown): value is RosterConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return integer(v.teams, 2, 32) && ["qb", "rb", "wr", "te", "flex", "superflex", "bench"].every((key) => integer(v[key], 0, 30));
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return integer(value, min, max) ? value : fallback;
}
