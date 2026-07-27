import { describe, expect, it } from "vitest";
import {
  auctionBudget, auctionPriceFromPool, auctionValuePool, averageAuctionBudget, clampAuctionSetupInput,
  isValidAuctionSetup, isValidWonPlayers, legalAuctionPurchase, legalPositionsForTeam, teamAuctionValue,
  unionLegalPositions, type AuctionBudget,
} from "../lib/auction";
import { rosterSlots } from "../lib/draft";
import { DEFAULT_ROSTER } from "../lib/presets";
import type { Position, RankedPlayer } from "../lib/types";
import { ALL_POSITIONS } from "../lib/types";

const slots = rosterSlots(DEFAULT_ROSTER); // 12-team standard: QB1 RB2 WR2 TE1 FLEX1 K DEF BN6 = 16 slots

const rankedPlayer = (id: string, position: Position, vbd: number): RankedPlayer => ({
  id, name: id, position, team: "TST", yearsExp: 2, injuryStatus: null, injuryBody: null,
  injuryNotes: null, bye: null, stats: {}, adp: { ppr: 1, half: 1, std: 1, superflex: 1, espn: 1 },
  actualStats2025: null, actualPts2025: null,
  points: 100, vbd, tier: 1, posRank: 1, overallRank: 1,
});

/** The pre-fix approach: derive the legal-position set by running
 * legalAuctionPurchase against every available player and deduping the
 * positions of the ones that pass. This is what suggestedBid() used to do
 * on every visible row. */
function bruteForceLegalPositions(
  available: RankedPlayer[], budget: AuctionBudget, roster: { id: string; position: Position }[],
): Set<Position> {
  return new Set(
    available
      .filter((candidate) => legalAuctionPurchase(1, budget, roster, candidate, slots).legal)
      .map((candidate) => candidate.position)
  );
}

describe("BUG 4 — memoized per-team legal positions match the brute-force per-player scan", () => {
  const available: RankedPlayer[] = [
    rankedPlayer("qb1", "QB", 40), rankedPlayer("qb2", "QB", 10),
    rankedPlayer("rb1", "RB", 50), rankedPlayer("rb2", "RB", 30),
    rankedPlayer("wr1", "WR", 45), rankedPlayer("wr2", "WR", 20),
    rankedPlayer("te1", "TE", 15), rankedPlayer("k1", "K", 5), rankedPlayer("def1", "DEF", 5),
  ];

  it("agrees with the brute-force scan for an empty roster", () => {
    const roster: { id: string; position: Position }[] = [];
    const budget = auctionBudget(200, 0, slots.length, 0);
    expect(legalPositionsForTeam(budget, roster, slots)).toEqual(bruteForceLegalPositions(available, budget, roster));
  });

  it("agrees with the brute-force scan once specific slots are filled (e.g. QB slot taken)", () => {
    const roster = [{ id: "won-qb", position: "QB" as Position }];
    const budget = auctionBudget(200, 1, slots.length, 1);
    const memoized = legalPositionsForTeam(budget, roster, slots);
    const bruteForce = bruteForceLegalPositions(available, budget, roster);
    expect(memoized).toEqual(bruteForce);
  });

  it("agrees with the brute-force scan when the roster is nearly full (few open slots left)", () => {
    // Fill every non-bench slot except one FLEX-eligible slot, leaving a roster
    // where only RB/WR/TE nominations are legal.
    const roster = [
      { id: "q", position: "QB" as Position }, { id: "r1", position: "RB" as Position }, { id: "r2", position: "RB" as Position },
      { id: "w1", position: "WR" as Position }, { id: "w2", position: "WR" as Position }, { id: "t", position: "TE" as Position },
      { id: "k", position: "K" as Position }, { id: "d", position: "DEF" as Position },
    ];
    const budget = auctionBudget(200, 8, slots.length, roster.length);
    const memoized = legalPositionsForTeam(budget, roster, slots);
    const bruteForce = bruteForceLegalPositions(available, budget, roster);
    expect(memoized).toEqual(bruteForce);
    expect(memoized.has("RB") || memoized.has("WR") || memoized.has("TE")).toBe(true);
  });

  it("agrees with the brute-force scan when the roster is full (no legal purchase)", () => {
    const roster = Array.from({ length: slots.length }, (_, i) => ({ id: `p${i}`, position: "RB" as Position }));
    const budget = auctionBudget(200, 200, slots.length, roster.length);
    expect(legalPositionsForTeam(budget, roster, slots)).toEqual(bruteForceLegalPositions(available, budget, roster));
    expect(legalPositionsForTeam(budget, roster, slots).size).toBe(0);
  });

  it("only probes the ~6 known positions, not every available player", () => {
    // ALL_POSITIONS has 6 entries; legalPositionsForTeam must not scale with
    // the size of the available pool.
    expect(ALL_POSITIONS.length).toBe(6);
    const budget = auctionBudget(200, 0, slots.length, 0);
    const bigAvailable = Array.from({ length: 500 }, (_, i) => rankedPlayer(`p${i}`, ALL_POSITIONS[i % 6], i));
    const memoized = legalPositionsForTeam(budget, [], slots);
    expect(memoized).toEqual(bruteForceLegalPositions(bigAvailable, budget, []));
  });

  it("produces identical suggested bids whether the legal-position set comes from the memoized helper or the brute-force scan", () => {
    const roster = [{ id: "won-qb", position: "QB" as Position }];
    const budget = auctionBudget(200, 1, slots.length, 1);
    const memoizedPositions = legalPositionsForTeam(budget, roster, slots);
    const bruteForcePositions = bruteForceLegalPositions(available, budget, roster);
    for (const player of available) {
      expect(teamAuctionValue(player, available, budget, memoizedPositions))
        .toBe(teamAuctionValue(player, available, budget, bruteForcePositions));
    }
  });
});

describe("BUG 3b — non-finite budgets no longer bypass the max-bid gate", () => {
  const roster: { id: string; position: Position }[] = [];
  const nominee = { id: "nominee", position: "RB" as Position };

  it("auctionBudget never returns a non-finite maxBid, even with NaN inputs", () => {
    const budget = auctionBudget(NaN, NaN, slots.length, 0);
    expect(Number.isFinite(budget.maxBid)).toBe(true);
    expect(Number.isFinite(budget.remaining)).toBe(true);
    expect(Number.isFinite(budget.spendable)).toBe(true);
  });

  it("rejects a bid when initial/spent are NaN (malformed persisted price)", () => {
    // Before the fix: remaining = NaN, maxBid = Math.max(0, NaN - k) = NaN,
    // and `price > NaN` is always false, so legalAuctionPurchase let any bid through.
    const budget = auctionBudget(NaN, NaN, slots.length, 0);
    const result = legalAuctionPurchase(50, budget, roster, nominee, slots);
    expect(result.legal).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects a bid when handed a budget object with a non-finite maxBid directly", () => {
    const malformedBudget: AuctionBudget = {
      remaining: NaN, openSlots: 5, reservedMinimum: 5, spendable: NaN, maxBid: NaN, dollarsPerSlot: NaN,
    };
    const result = legalAuctionPurchase(1, malformedBudget, roster, nominee, slots);
    expect(result.legal).toBe(false);
  });

  it("rejects a bid when openSlots is non-finite", () => {
    const malformedBudget: AuctionBudget = {
      remaining: 100, openSlots: NaN, reservedMinimum: 0, spendable: 100, maxBid: 100, dollarsPerSlot: 0,
    };
    const result = legalAuctionPurchase(1, malformedBudget, roster, nominee, slots);
    expect(result.legal).toBe(false);
  });

  it("still allows a legitimate bid through a healthy budget", () => {
    const budget = auctionBudget(200, 0, slots.length, 0);
    const result = legalAuctionPurchase(50, budget, roster, nominee, slots);
    expect(result.legal).toBe(true);
  });
});

describe("BUG 3b — isValidWonPlayers validator", () => {
  it("accepts a well-formed won-players array", () => {
    expect(isValidWonPlayers([{ playerId: "abc", teamIndex: 0, price: 25 }])).toBe(true);
    expect(isValidWonPlayers([])).toBe(true);
  });

  it("rejects non-arrays", () => {
    expect(isValidWonPlayers(null)).toBe(false);
    expect(isValidWonPlayers({})).toBe(false);
    expect(isValidWonPlayers("nope")).toBe(false);
  });

  it("rejects a non-numeric/NaN price (the malformed-localStorage scenario)", () => {
    expect(isValidWonPlayers([{ playerId: "abc", teamIndex: 0, price: "25" }])).toBe(false);
    expect(isValidWonPlayers([{ playerId: "abc", teamIndex: 0, price: NaN }])).toBe(false);
    expect(isValidWonPlayers([{ playerId: "abc", teamIndex: 0, price: 0 }])).toBe(false);
    expect(isValidWonPlayers([{ playerId: "abc", teamIndex: 0, price: 1.5 }])).toBe(false);
  });

  it("rejects a missing/empty/non-string playerId", () => {
    expect(isValidWonPlayers([{ teamIndex: 0, price: 1 }])).toBe(false);
    expect(isValidWonPlayers([{ playerId: "", teamIndex: 0, price: 1 }])).toBe(false);
    expect(isValidWonPlayers([{ playerId: 123, teamIndex: 0, price: 1 }])).toBe(false);
  });

  it("rejects an out-of-range or non-integer teamIndex", () => {
    expect(isValidWonPlayers([{ playerId: "abc", teamIndex: -1, price: 1 }])).toBe(false);
    expect(isValidWonPlayers([{ playerId: "abc", teamIndex: 1.5, price: 1 }])).toBe(false);
    expect(isValidWonPlayers([{ playerId: "abc", teamIndex: 999, price: 1 }])).toBe(false);
  });

  it("rejects if any single record in the array is malformed", () => {
    expect(isValidWonPlayers([
      { playerId: "ok", teamIndex: 0, price: 10 },
      { playerId: "bad", teamIndex: 0, price: NaN },
    ])).toBe(false);
  });
});

describe("BUG 3b — isValidAuctionSetup validator", () => {
  it("accepts a well-formed setup", () => {
    expect(isValidAuctionSetup({ numTeams: 12, budgetPerTeam: 200, started: true })).toBe(true);
  });

  it("rejects malformed shapes", () => {
    expect(isValidAuctionSetup(null)).toBe(false);
    expect(isValidAuctionSetup({ numTeams: 12, budgetPerTeam: 200 })).toBe(false); // missing started
    expect(isValidAuctionSetup({ numTeams: NaN, budgetPerTeam: 200, started: true })).toBe(false);
    expect(isValidAuctionSetup({ numTeams: 12, budgetPerTeam: "200", started: true })).toBe(false);
    expect(isValidAuctionSetup({ numTeams: 33, budgetPerTeam: 200, started: true })).toBe(false);
    expect(isValidAuctionSetup({ numTeams: 12, budgetPerTeam: NaN, started: true })).toBe(false);
  });
});

describe("Sug. Bid column — hoisted pool matches teamAuctionValue (Part B)", () => {
  const available: RankedPlayer[] = [
    rankedPlayer("qb1", "QB", 40), rankedPlayer("rb1", "RB", 50), rankedPlayer("rb2", "RB", -5),
    rankedPlayer("wr1", "WR", 45), rankedPlayer("te1", "TE", 0),
  ];
  const legalPositions = new Set<Position>(["QB", "RB", "WR", "TE"]);
  const budget = auctionBudget(200, 20, slots.length, 2);

  it("auctionPriceFromPool(player, auctionValuePool(...), budget) equals teamAuctionValue(...) for every player", () => {
    const pool = auctionValuePool(available, legalPositions);
    for (const player of available) {
      expect(auctionPriceFromPool(player, pool, budget)).toBe(teamAuctionValue(player, available, budget, legalPositions));
    }
  });

  it("auctionValuePool only sums positive VBD at legal positions, matching teamAuctionValue's internal reduce", () => {
    const rbOnly = new Set<Position>(["RB"]);
    // rb2 has negative VBD (Math.max(0, ...) floors it at 0) and qb1/wr1/te1 are off-position.
    expect(auctionValuePool(available, rbOnly)).toBe(50);
  });
});

describe("Sug. Bid column — team-agnostic market price (Part A)", () => {
  it("unionLegalPositions unions across teams and handles an empty list", () => {
    const empty = new Set<Position>();
    const rbWr = new Set<Position>(["RB", "WR"]);
    const teOnly = new Set<Position>(["TE"]);
    expect(unionLegalPositions([empty, rbWr, teOnly])).toEqual(new Set(["RB", "WR", "TE"]));
    expect(unionLegalPositions([])).toEqual(new Set());
  });

  it("averageAuctionBudget averages maxBid/spendable across teams, rounded to whole dollars", () => {
    const b1: AuctionBudget = { remaining: 100, openSlots: 5, reservedMinimum: 5, spendable: 95, maxBid: 91, dollarsPerSlot: 20 };
    const b2: AuctionBudget = { remaining: 50, openSlots: 5, reservedMinimum: 5, spendable: 45, maxBid: 41, dollarsPerSlot: 10 };
    expect(averageAuctionBudget([b1, b2])).toEqual({ maxBid: 66, spendable: 70 });
    expect(averageAuctionBudget([])).toEqual({ maxBid: 0, spendable: 0 });
  });

  it("a league-average market price is not zeroed out just because one team's roster is full", () => {
    const available: RankedPlayer[] = [rankedPlayer("rb1", "RB", 50), rankedPlayer("wr1", "WR", 40)];

    // Team 0: full roster -> maxBid 0, no legal positions (mirrors the "full
    // roster" case in the BUG 4 suite above).
    const fullRoster = Array.from({ length: slots.length }, (_, i) => ({ id: `f${i}`, position: "RB" as Position }));
    const fullBudget = auctionBudget(200, 200, slots.length, fullRoster.length);
    const fullLegal = legalPositionsForTeam(fullBudget, fullRoster, slots);
    expect(fullLegal.size).toBe(0);

    // Team 1: empty roster, full budget available.
    const openBudget = auctionBudget(200, 0, slots.length, 0);
    const openLegal = legalPositionsForTeam(openBudget, [], slots);
    expect(openLegal.size).toBeGreaterThan(0);

    // Pre-fix behavior: pricing the board against one arbitrary team's own
    // budget/positions reads $0 the moment that team's roster is full.
    expect(teamAuctionValue(available[0], available, fullBudget, fullLegal)).toBe(0);

    // Fixed behavior: union legal positions and average budgets across every
    // team so a single full roster can't zero out the whole board.
    const marketLegal = unionLegalPositions([fullLegal, openLegal]);
    const marketBudget = averageAuctionBudget([fullBudget, openBudget]);
    const marketPool = auctionValuePool(available, marketLegal);
    expect(auctionPriceFromPool(available[0], marketPool, marketBudget)).toBeGreaterThan(0);
  });
});

describe("BUG 6b — clampAuctionSetupInput clamps instead of silently substituting the default", () => {
  it("clamps an out-of-range team count to the nearest bound and reports the adjustment", () => {
    const result = clampAuctionSetupInput(33, 200, 16);
    expect(result.numTeams).toBe(32); // clamped to the max, NOT the 12-team default
    expect(result.adjusted).toBe(true);
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("clamps a too-small team count up to the minimum", () => {
    const result = clampAuctionSetupInput(1, 200, 16);
    expect(result.numTeams).toBe(2);
    expect(result.adjusted).toBe(true);
  });

  it("clamps a too-small budget up to the roster minimum", () => {
    const result = clampAuctionSetupInput(12, 5, 16);
    expect(result.budgetPerTeam).toBe(16);
    expect(result.adjusted).toBe(true);
  });

  it("clamps a NaN input to a sane default without crashing", () => {
    const result = clampAuctionSetupInput(NaN, NaN, 16);
    expect(Number.isFinite(result.numTeams)).toBe(true);
    expect(Number.isFinite(result.budgetPerTeam)).toBe(true);
    expect(result.adjusted).toBe(true);
  });

  it("makes no adjustment (and reports none) for already-valid input", () => {
    const result = clampAuctionSetupInput(12, 200, 16);
    expect(result).toEqual({ numTeams: 12, budgetPerTeam: 200, adjusted: false, messages: [] });
  });
});
