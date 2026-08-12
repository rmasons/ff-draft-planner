import { describe, expect, it } from "vitest";
import {
  chooseCpuPick,
  chooseCpuPickOrBestAvailable,
  mergeKeepersNonDestructive,
  pollBackoffDelay,
  rosterSlots,
  seededRandom,
} from "../lib/draft";
import { DEFAULT_ROSTER } from "../lib/presets";
import type { Player, Position, RankedPlayer } from "../lib/types";

// Same shape/helper style as tests/domain.test.ts, duplicated here so this
// file has no dependency on it (per file-ownership rules for this task).
const player = (id: string, position: Position, points = 100, adp = 20): Player => ({
  id, name: id, position, team: "TST", yearsExp: 2, injuryStatus: null, injuryBody: null,
  injuryNotes: null, bye: null, stats: position === "K" || position === "DEF" ? { pts_std: points } : { rush_yd: points * 10 },
  adp: { ppr: adp, half: adp + 1, std: adp + 2, superflex: adp + 3, espn: adp + 4 },
  actualStats2025: null, actualPts2025: null,
});

const ranked = (id: string, position: Position, overallRank: number, adp = overallRank): RankedPlayer => ({
  ...player(id, position, 300 - overallRank, adp),
  points: 300 - overallRank, vbd: 30 - overallRank, tier: 1, posRank: overallRank, overallRank,
});

describe("BUG 1 — CPU draft hangs when configured rounds exceed roster slots", () => {
  // A tiny roster: 1 QB slot + 1 bench slot = 2 total slots.
  const config = { ...DEFAULT_ROSTER, teams: 2, qb: 1, rb: 0, wr: 0, te: 0, flex: 0, superflex: 0, bench: 1 };
  const slots = rosterSlots(config, false); // 2 slots total

  it("reproduces the hang: chooseCpuPick returns null once the roster is full", () => {
    // Team already has 2 players filling both slots (an imported league with
    // more rounds than the local roster config has slots for looks exactly
    // like this: every candidate loses to assignRoster's players > slots check).
    const current = [{ id: "have-1", position: "QB" as const }, { id: "have-2", position: "RB" as const }];
    const candidates = [ranked("c1", "WR", 1), ranked("c2", "RB", 2)];
    expect(chooseCpuPick(candidates, current, slots, (p) => p.adp.ppr, seededRandom(1))).toBeNull();
  });

  it("chooseCpuPickOrBestAvailable falls back to best-available so the draft keeps progressing", () => {
    const current = [{ id: "have-1", position: "QB" as const }, { id: "have-2", position: "RB" as const }];
    const candidates = [ranked("c1", "WR", 5), ranked("c2", "RB", 1), ranked("c3", "TE", 3)];
    const pick = chooseCpuPickOrBestAvailable(candidates, current, slots, (p) => p.adp.ppr, seededRandom(1));
    expect(pick).not.toBeNull();
    // Falls back to the best-ranked (lowest ADP) candidate, ignoring roster legality.
    expect(pick?.id).toBe("c2");
  });

  it("still prefers a roster-legal pick when one exists (fallback only kicks in once full)", () => {
    const current: { id: string; position: Position }[] = []; // roster wide open
    const candidates = [ranked("c1", "QB", 1), ranked("c2", "RB", 2)];
    const legal = chooseCpuPickOrBestAvailable(candidates, current, slots, (p) => p.adp.ppr, seededRandom(7));
    expect(legal).not.toBeNull();
    // Sanity: matches what chooseCpuPick alone would have produced (no fallback needed).
    expect(legal?.id).toBe(chooseCpuPick(candidates, current, slots, (p) => p.adp.ppr, seededRandom(7))?.id);
  });

  it("returns null (not a crash) when there are no candidates at all", () => {
    expect(chooseCpuPickOrBestAvailable([], [], slots, () => null, seededRandom(1))).toBeNull();
  });
});

describe("BUG 7 — keeper merge must not silently overwrite an existing pick", () => {
  it("reproduces the bug: a naive Map merge overwrites an imported pick at the same pickNumber", () => {
    const existing = [{ pickNumber: 5, teamSlot: 1, playerId: "imported-player" }];
    const keeperPicks = [{ pickNumber: 5, teamSlot: 1, playerId: "keeper-player", isKeeper: true as const }];
    const naiveMerge = new Map(existing.map((p) => [p.pickNumber, p]));
    for (const kp of keeperPicks) naiveMerge.set(kp.pickNumber, kp); // <- the old, destructive behavior
    expect(naiveMerge.get(5)?.playerId).toBe("keeper-player"); // imported pick silently lost
  });

  it("mergeKeepersNonDestructive keeps the existing pick and reports the collision", () => {
    const existing = [{ pickNumber: 5, teamSlot: 1, playerId: "imported-player" }];
    const keeperPicks = [{ pickNumber: 5, teamSlot: 1, playerId: "keeper-player", isKeeper: true as const }];
    const { merged, accepted, skipped } = mergeKeepersNonDestructive(existing, keeperPicks);
    expect(merged.find((p) => p.pickNumber === 5)?.playerId).toBe("imported-player");
    expect(accepted).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].playerId).toBe("keeper-player");
  });

  it("still merges a keeper into an empty slot, and a keeper can replace another keeper at the same slot", () => {
    const existing = [{ pickNumber: 3, teamSlot: 2, playerId: "old-keeper", isKeeper: true as const }];
    const keeperPicks = [
      { pickNumber: 3, teamSlot: 2, playerId: "new-keeper", isKeeper: true as const },
      { pickNumber: 7, teamSlot: 1, playerId: "fresh-keeper", isKeeper: true as const },
    ];
    const { merged, accepted, skipped } = mergeKeepersNonDestructive(existing, keeperPicks);
    expect(skipped).toHaveLength(0);
    expect(accepted).toHaveLength(2);
    expect(merged.find((p) => p.pickNumber === 3)?.playerId).toBe("new-keeper");
    expect(merged.find((p) => p.pickNumber === 7)?.playerId).toBe("fresh-keeper");
    expect(merged).toHaveLength(2);
  });

  it("rejects a second incoming keeper that lands on a pickNumber another keeper in the same batch already claimed", () => {
    // Neither pickNumber-4 keeper is in `existing`, so byPickNum alone
    // wouldn't catch this — only tracking accepted pick numbers within the
    // batch does. The second one must not silently clobber the first.
    const existing: { pickNumber: number; teamSlot: number; playerId: string; isKeeper?: boolean }[] = [];
    const keeperPicks = [
      { pickNumber: 4, teamSlot: 1, playerId: "first-keeper", isKeeper: true as const },
      { pickNumber: 4, teamSlot: 2, playerId: "second-keeper", isKeeper: true as const },
    ];
    const { merged, accepted, skipped } = mergeKeepersNonDestructive(existing, keeperPicks);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].playerId).toBe("first-keeper");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].playerId).toBe("second-keeper");
    expect(merged.find((p) => p.pickNumber === 4)?.playerId).toBe("first-keeper");
    expect(merged).toHaveLength(1);
  });
});

describe("BUG 8 — live poll backoff", () => {
  it("doubles 8s -> 16s -> 32s and caps there, resetting to 8s on success (failures=0)", () => {
    expect(pollBackoffDelay(0)).toBe(8000);
    expect(pollBackoffDelay(1)).toBe(16000);
    expect(pollBackoffDelay(2)).toBe(32000);
    expect(pollBackoffDelay(3)).toBe(32000); // capped
    expect(pollBackoffDelay(10)).toBe(32000); // stays capped
  });
});
