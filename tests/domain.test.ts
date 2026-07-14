import { describe, expect, it } from "vitest";
import { auctionBudget, legalAuctionPurchase, teamAuctionValue } from "../lib/auction";
import {
  assignRoster, chooseCpuPick, gradeLetter, gradePick, keeperValue, ownerForPick,
  pickNumberForSlot, positionalRun, rosterSlots, seededRandom, survivalEstimate,
  teamSlotForPick, transitionDraft,
} from "../lib/draft";
import { marketReference } from "../lib/market";
import { encodeStored, parseStored } from "../lib/persistence";
import { assessRisk } from "../lib/risk";
import { fantasyPoints, fantasyPointsForStats } from "../lib/scoring";
import { validRoster, validScoring } from "../lib/validation";
import { rankPlayers } from "../lib/vbd";
import { DEFAULT_ROSTER, DEFAULT_SCORING } from "../lib/presets";
import type { Player, Position, RankedPlayer } from "../lib/types";

const player = (id: string, position: Position, points = 100, adp = 20): Player => ({
  id, name: id, position, team: "TST", yearsExp: 2, injuryStatus: null, injuryBody: null,
  injuryNotes: null, bye: null, stats: position === "K" || position === "DEF" ? { pts_std: points } : { rush_yd: points * 10 },
  adp: { ppr: adp, half: adp + 1, std: adp + 2, superflex: adp + 3, espn: adp + 4 },
  actualStats2025: null, actualPts2025: null,
});

describe("scoring and rankings", () => {
  it("scores receptions, TE premium, two-point plays, and K fallback", () => {
    const te = { ...player("te", "TE"), stats: { rec: 10, rec_yd: 100, rec_td: 1, rec_2pt: 1 } };
    expect(fantasyPoints(te, { ...DEFAULT_SCORING, teRecBonus: 0.5 })).toBe(33);
    expect(fantasyPoints(player("k", "K", 123.4), DEFAULT_SCORING)).toBe(123.4);
    expect(fantasyPointsForStats("QB", { pass_td: 2, pass_int: 1 }, { ...DEFAULT_SCORING, passTd: 6 })).toBe(10);
  });

  it("uses the first undrafted player for every replacement baseline", () => {
    const roster = { ...DEFAULT_ROSTER, teams: 2, qb: 1, rb: 0, wr: 0, te: 0, flex: 0, bench: 0 };
    const pool = [player("q1", "QB", 300), player("q2", "QB", 200), player("q3", "QB", 150), player("k1", "K", 30), player("k2", "K", 20), player("k3", "K", 10)];
    const result = rankPlayers(pool, DEFAULT_SCORING, roster);
    expect(result.baselines.QB).toEqual({ rank: 3, points: 150 });
    expect(result.baselines.K).toEqual({ rank: 3, points: 10 });
    expect(result.players.find((item) => item.id === "q3")?.vbd).toBe(0);
  });
});

describe("snake, ownership, grades, and state", () => {
  it("round-trips snake positions across odd and even rounds", () => {
    for (const teams of [2, 12, 32]) for (let round = 1; round <= 4; round++) for (let slot = 1; slot <= teams; slot++) {
      expect(teamSlotForPick(pickNumberForSlot(round, slot, teams), teams)).toBe(slot);
    }
    expect(pickNumberForSlot(2, 3, 12)).toBe(22);
  });

  it("resolves traded ownership and corrected keeper/pick value", () => {
    expect(ownerForPick(22, 12, [{ round: 2, roster_id: 3, owner_id: 8 }])).toBe(8);
    expect(keeperValue(2, 3, 12, 30)).toEqual({ pickEquivalent: 22, surplus: -8 });
    expect(gradePick(40, 25)).toBe(15);
    expect(gradePick(40, 55)).toBe(-15);
    expect(gradeLetter(6)).toBe("A");
  });

  it("rejects illegal draft transitions", () => {
    expect(transitionDraft("setup", { type: "START" })).toBe("setup");
    expect(transitionDraft("setup", { type: "READY" })).toBe("ready");
    expect(transitionDraft("running", { type: "COMPLETE" })).toBe("complete");
    expect(transitionDraft("complete", { type: "RESET" })).toBe("setup");
  });
});

describe("rosters and CPU simulation", () => {
  const config = { ...DEFAULT_ROSTER, teams: 2, qb: 1, rb: 1, wr: 1, te: 0, flex: 1, superflex: 0, bench: 1 };
  const slots = rosterSlots(config, false);

  it("finds flex-valid assignments and rejects over-capacity rosters", () => {
    expect(assignRoster([{ id: "rb", position: "RB" }, { id: "wr", position: "WR" }, { id: "qb", position: "QB" }], slots).valid).toBe(true);
    expect(assignRoster(Array.from({ length: slots.length + 1 }, (_, index) => ({ id: String(index), position: "RB" as const })), slots).valid).toBe(false);
  });

  it("makes deterministic, need-aware, roster-legal picks", () => {
    const ranked = [player("qb", "QB", 200, 25), player("rb", "RB", 180, 10), player("k", "K", 150, 1)].map((p, index) => ({ ...p, points: 200 - index, vbd: 20 - index, tier: 1, posRank: 1, overallRank: index + 1 })) as RankedPlayer[];
    const first = chooseCpuPick(ranked, [], slots, (p) => p.adp.ppr, seededRandom(42));
    const second = chooseCpuPick(ranked, [], slots, (p) => p.adp.ppr, seededRandom(42));
    expect(first?.id).toBe(second?.id);
    expect(first?.position).not.toBe("K");
  });
});

describe("auction legality and inflation", () => {
  it("reserves $1 per remaining slot and caps bids", () => {
    expect(auctionBudget(10, 0, 3, 0)).toMatchObject({ remaining: 10, openSlots: 3, reservedMinimum: 3, maxBid: 8 });
    const budget = auctionBudget(10, 0, 3, 0);
    const slots = ["QB", "RB", "BN"] as const;
    expect(legalAuctionPurchase(9, budget, [], { id: "q", position: "QB" }, [...slots]).legal).toBe(false);
    expect(legalAuctionPurchase(8, budget, [], { id: "q", position: "QB" }, [...slots]).legal).toBe(true);
  });

  it("provides team-specific, legal guidance", () => {
    const p = { ...player("rb", "RB"), points: 100, vbd: 20, tier: 1, posRank: 1, overallRank: 1 } as RankedPlayer;
    const richer = teamAuctionValue(p, [p], auctionBudget(200, 0, 5, 0), new Set(["RB"]));
    const poorer = teamAuctionValue(p, [p], auctionBudget(200, 180, 5, 2), new Set(["RB"]));
    expect(richer).toBeGreaterThan(poorer);
    expect(poorer).toBeLessThanOrEqual(18);
  });
});

describe("market, persistence, validation, risk, and decision support", () => {
  it("never blends ESPN PPR into non-PPR formats", () => {
    const p = player("p", "RB");
    const standard = marketReference(p, { ...DEFAULT_SCORING, rec: 0 }, DEFAULT_ROSTER);
    expect(standard.consensus).toBe(p.adp.std);
    expect(standard.espn).toBeNull();
    const ppr = marketReference(p, DEFAULT_SCORING, DEFAULT_ROSTER);
    expect(ppr.consensus).toBe((p.adp.ppr + p.adp.espn) / 2);
  });

  it("migrates legacy storage and rejects malformed/future data", () => {
    expect(parseStored("[1,2]", [] as number[]).migrated).toBe(true);
    expect(parseStored(encodeStored([1, 2]), [] as number[]).value).toEqual([1, 2]);
    expect(parseStored("{", [9]).value).toEqual([9]);
    expect(parseStored(JSON.stringify({ version: 99, data: [1] }), [9]).error).toMatch(/newer/);
  });

  it("validates config and explains monotonic risk", () => {
    expect(validScoring(DEFAULT_SCORING)).toBe(true);
    expect(validRoster(DEFAULT_ROSTER)).toBe(true);
    expect(validRoster({ ...DEFAULT_ROSTER, teams: -1 })).toBe(false);
    const healthy = assessRisk(player("healthy", "RB"));
    const injured = assessRisk({ ...player("hurt", "RB"), injuryStatus: "IR" });
    expect(injured.score).toBeGreaterThan(healthy.score);
    expect(injured.factors).toContain("Injured reserve");
  });

  it("reports survival, tier scarcity, and keeper-free positional runs", () => {
    expect(survivalEstimate(20, 10, 30)).toBeLessThan(0.5);
    const players = new Map([["a", { position: "WR" as const }], ["b", { position: "WR" as const }], ["c", { position: "WR" as const }], ["d", { position: "WR" as const }], ["k", { position: "WR" as const }]]);
    const runs = positionalRun([
      { pickNumber: 1, teamSlot: 1, playerId: "k", isKeeper: true },
      ...["a", "b", "c", "d"].map((id, index) => ({ pickNumber: index + 2, teamSlot: 1, playerId: id })),
    ], players);
    expect(runs).toEqual([{ position: "WR", count: 4, window: 4 }]);
  });
});

