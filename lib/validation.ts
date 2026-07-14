import type { RosterConfig, ScoringConfig } from "./types";
import type { BaselineMethod } from "./vbd";
import type { AnnotationStore } from "./annotations";

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

/** Drafted-player id list persisted by DraftBoard (`ffdp.drafted`). */
export function validDraftedIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

const BASELINE_METHODS: readonly BaselineMethod[] = ["VOLS", "VORP"];

/** VOR baseline method persisted by DraftBoard (`ffdp.method`). */
export function validBaselineMethod(value: unknown): value is BaselineMethod {
  return typeof value === "string" && (BASELINE_METHODS as readonly string[]).includes(value);
}

/** Per-player target/avoid/note annotations persisted by DraftBoard (`ffdp.annotations`). */
export function validAnnotationStore(value: unknown): value is AnnotationStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const a = entry as Record<string, unknown>;
    return typeof a.target === "boolean" && typeof a.avoid === "boolean" && typeof a.note === "string";
  });
}

export interface AdpSnapshot {
  ts: number;
  data: Record<string, number>;
  // Which adpKey (ppr/half/std/superflex, see adpKeyFor) the snapshot's `data`
  // was computed under. Consensus ADP differs by scoring/roster format, so a
  // snapshot seeded under one key is meaningless compared against another —
  // this lets DraftBoard detect a format switch and rebuild instead of
  // showing bogus trend arrows. Optional so snapshots persisted before this
  // field existed are handled gracefully (treated as a mismatch).
  adpKey?: string;
  // Which season (see SEASON in lib/sleeper.ts) the snapshot was captured
  // under. Same reasoning as adpKey: a snapshot left over from a prior season
  // can share the same adpKey (e.g. "ppr" both years) while its consensus
  // numbers are for entirely different players/values, so season must be
  // checked alongside adpKey. Optional for the same backward-compat reason.
  season?: string;
}

/** ADP trend snapshot persisted by DraftBoard (`ffdp.adp-snapshot`); may be absent (null). */
export function validAdpSnapshot(value: unknown): value is AdpSnapshot | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!finite(v.ts)) return false;
  if (!v.data || typeof v.data !== "object" || Array.isArray(v.data)) return false;
  if (!Object.values(v.data as Record<string, unknown>).every(finite)) return false;
  if (v.adpKey !== undefined && typeof v.adpKey !== "string") return false;
  if (v.season !== undefined && typeof v.season !== "string") return false;
  return true;
}
