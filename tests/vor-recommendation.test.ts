import { describe, expect, it } from "vitest";
import {
  depthValueFactor,
  fillLineupSlots,
  leagueOpenSlots,
  remainingPicksForSlot,
  rosterConfigFromLeague,
  rosterSlots,
  selectSuggestedPick,
  depthCapacityByPosition,
  SLEEPER_SLOT_ELIGIBLE,
} from "../lib/draft";
import { rankPlayers } from "../lib/vbd";
import { adpKeyFor } from "../lib/presets";
import { DEFAULT_ROSTER, DEFAULT_SCORING } from "../lib/presets";
import type { Player, Position, RankedPlayer } from "../lib/types";

const player = (id: string, position: Position, points = 100, adp = 20): Player => ({
  id, name: id, position, team: "TST", yearsExp: 2, injuryStatus: null, injuryBody: null,
  injuryNotes: null, bye: null,
  stats: position === "K" || position === "DEF" ? { pts_std: points } : { rush_yd: points * 10 },
  adp: { ppr: adp, half: adp + 1, std: adp + 2, superflex: adp + 3, espn: adp + 4 },
  actualStats2025: null, actualPts2025: null,
});

const ranked = (id: string, position: Position, vbd: number, points = 200): RankedPlayer => ({
  ...player(id, position, points),
  points, vbd, tier: 1, posRank: 1, overallRank: 1,
});

/** Stand-in for the component's evaluateCandidate: score is just VOR. */
const scoreByVor = (p: RankedPlayer) => p.vbd;

const ctx = (openStarterSlotTypes: string[], picksRemaining: number) => ({
  openStarterSlotTypes, picksRemaining,
});

describe("selectSuggestedPick — K/DEF are not ranked against skill VOR", () => {
  // The shape that produced the bug: mid-draft, every remaining skill player's
  // VOR has decayed below the top defense's fixed +20 (DEF1 vs DEF13).
  const board = [
    ranked("rb-mid", "RB", 12),
    ranked("wr-mid", "WR", 9),
    ranked("def-1", "DEF", 20),
    ranked("k-1", "K", 13),
  ];

  it("does not suggest a defense while skill starter slots are open", () => {
    const result = selectSuggestedPick(board, ctx(["RB", "WR", "FLEX", "K", "DEF"], 8), scoreByVor);
    expect(result?.player.id).toBe("rb-mid");
    expect(result?.isBench).toBe(false);
  });

  it("still refuses the defense when only a FLEX remains open", () => {
    const result = selectSuggestedPick(board, ctx(["FLEX", "K", "DEF"], 8), scoreByVor);
    expect(result?.player.position).not.toBe("DEF");
    expect(result?.player.id).toBe("rb-mid");
  });

  it("suggests the defense once K/DEF are the only starter slots left", () => {
    const result = selectSuggestedPick(board, ctx(["K", "DEF"], 8), scoreByVor);
    expect(result?.player.id).toBe("def-1");
    expect(result?.isBench).toBe(false);
  });

  it("never suggests a specialist as a bench stash", () => {
    const result = selectSuggestedPick(board, ctx([], 8), scoreByVor);
    expect(result?.isBench).toBe(true);
    expect(result?.player.id).toBe("rb-mid");
  });

  it("only offers the specialist the league actually rosters", () => {
    // A league with a K slot but no DEF slot: DEF1 outscores K1 on raw VOR,
    // but there is no defense slot for it to fill.
    const result = selectSuggestedPick(board, ctx(["K"], 8), scoreByVor);
    expect(result?.player.id).toBe("k-1");
  });

  it("returns null on an empty board", () => {
    expect(selectSuggestedPick([], ctx(["RB"], 8), scoreByVor)).toBeNull();
  });
});

describe("selectSuggestedPick — every candidate is scored, not just the first", () => {
  it("promotes a lower-VOR player when draft context outweighs the VOR gap", () => {
    const board = [
      ranked("wr-top", "WR", 40),
      ranked("rb-cliff", "RB", 34),
    ];
    // Highest VOR alone would take the WR.
    expect(selectSuggestedPick(board, ctx(["FLEX"], 8), scoreByVor)?.player.id).toBe("wr-top");
    // With a tier cliff behind the RB, the full score flips the pick — the old
    // first-eligible-by-VOR scan could never express this.
    const withCliff = (p: RankedPlayer) => p.vbd + (p.id === "rb-cliff" ? 30 * 0.75 : 0);
    expect(selectSuggestedPick(board, ctx(["FLEX"], 8), withCliff)?.player.id).toBe("rb-cliff");
  });

  it("scores every player in the pool, not only the first eligible one", () => {
    const board = [ranked("a", "WR", 30), ranked("b", "WR", 20), ranked("c", "WR", 10)];
    const seen: string[] = [];
    selectSuggestedPick(board, ctx(["WR"], 8), (p) => { seen.push(p.id); return p.vbd; });
    expect(seen).toEqual(["a", "b", "c"]);
  });
});

describe("rosterConfigFromLeague — baselines follow the imported league", () => {
  it("derives a superflex config from Sleeper roster_positions", () => {
    const positions = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF",
      "BN", "BN", "BN", "BN", "BN", "BN"];
    const cfg = rosterConfigFromLeague(positions, { ...DEFAULT_ROSTER, teams: 10 });
    expect(cfg).toEqual({ teams: 10, qb: 1, rb: 2, wr: 2, te: 1, flex: 1, superflex: 1, bench: 6 });
  });

  it("counts Sleeper's flex variants as flex and ignores non-draftable slots", () => {
    const cfg = rosterConfigFromLeague(
      ["QB", "WRRB_FLEX", "REC_FLEX", "FLEX", "IDP_FLEX", "IR", "TAXI", "BN"],
      DEFAULT_ROSTER
    );
    expect(cfg.flex).toBe(3);
    expect(cfg.qb).toBe(1);
    expect(cfg.bench).toBe(1);
  });

  it("falls back to the base config when no slot is recognized", () => {
    const base = { ...DEFAULT_ROSTER, teams: 8 };
    expect(rosterConfigFromLeague(["DL", "LB", "DB"], base)).toEqual(base);
    expect(rosterConfigFromLeague([], base)).toEqual(base);
  });

  it("moves the QB baseline and the ADP format for a superflex league", () => {
    // 24 QBs, descending, so the baseline rank is directly observable.
    const pool: Player[] = Array.from({ length: 24 }, (_, i) => player(`qb${i}`, "QB", 400 - i * 10));
    const stale = { ...DEFAULT_ROSTER, teams: 12 };                    // 1-QB Cheat Sheet config
    const derived = rosterConfigFromLeague(["QB", "SUPER_FLEX", "BN"], stale);

    expect(rankPlayers(pool, DEFAULT_SCORING, stale).baselines.QB.rank).toBe(13);
    expect(rankPlayers(pool, DEFAULT_SCORING, derived).baselines.QB.rank).toBe(24);

    expect(adpKeyFor(DEFAULT_SCORING, stale)).not.toBe("superflex");
    expect(adpKeyFor(DEFAULT_SCORING, derived)).toBe("superflex");
  });
});

describe("regression — the top defense no longer hijacks the recommendation", () => {
  // Reproduces the original failure against a realistic board: a 12-team PPR
  // VOLS league mid-draft, where DEF1's fixed +20 outranked every remaining
  // skill player and the suggestion froze on it for the rest of the draft.
  const pool: Player[] = [
    ...Array.from({ length: 60 }, (_, i) => player(`rb${i}`, "RB", 300 - i * 3)),
    ...Array.from({ length: 80 }, (_, i) => player(`wr${i}`, "WR", 300 - i * 2.5)),
    ...Array.from({ length: 30 }, (_, i) => player(`qb${i}`, "QB", 400 - i * 6)),
    ...Array.from({ length: 30 }, (_, i) => player(`te${i}`, "TE", 240 - i * 5)),
    ...Array.from({ length: 30 }, (_, i) => player(`k${i}`, "K", 160 - i * 2)),
    ...Array.from({ length: 30 }, (_, i) => player(`def${i}`, "DEF", 150 - i * 3)),
  ];
  const board = rankPlayers(pool, DEFAULT_SCORING, DEFAULT_ROSTER, "VOLS").players;

  it("confirms the setup: a defense really does top the board on raw VOR", () => {
    // Simulate ~90 picks gone (round 8 of a 12-team draft). CPU teams carry an
    // early-specialist penalty, so no defense has come off the board.
    const gone = new Set(board.filter((p) => p.position !== "K" && p.position !== "DEF")
      .slice(0, 90).map((p) => p.id));
    const available = board.filter((p) => !gone.has(p.id));
    const topByVor = [...available].sort((a, b) => b.vbd - a.vbd)[0];
    expect(topByVor.position).toBe("DEF");
  });

  it("suggests a skill player at every point of a full draft", () => {
    const openSlots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF"];
    for (const picksGone of [0, 24, 60, 90, 120, 150]) {
      const gone = new Set(board.filter((p) => p.position !== "K" && p.position !== "DEF")
        .slice(0, picksGone).map((p) => p.id));
      const available = board.filter((p) => !gone.has(p.id));
      const result = selectSuggestedPick(available, ctx(openSlots, 16), scoreByVor);
      expect(result, `pick ${picksGone}`).not.toBeNull();
      expect(["K", "DEF"], `pick ${picksGone} suggested ${result!.player.name}`)
        .not.toContain(result!.player.position);
    }
  });
});

describe("selectSuggestedPick — roster need is a weight, not a filter", () => {
  // An elite player who fits no open slot, against a mediocre one who fills a hole.
  const board = [ranked("wr-elite", "WR", 30), ranked("qb-need", "QB", 20)];

  it("takes the better player early, when there is time to fill the hole later", () => {
    const result = selectSuggestedPick(board, ctx(["QB"], 12), scoreByVor);
    expect(result?.player.id).toBe("wr-elite");
    expect(result?.isBench).toBe(true);
    expect(result?.forced).toBe(false);
    expect(result?.needWeight).toBeCloseTo(1 / 12);
  });

  it("fills the hole late, when picks are running out", () => {
    const result = selectSuggestedPick(board, ctx(["QB"], 2), scoreByVor);
    expect(result?.player.id).toBe("qb-need");
    expect(result?.isBench).toBe(false);
    expect(result?.forced).toBe(false); // persuaded by the weight, not compelled
    expect(result?.needWeight).toBeCloseTo(0.5);
  });

  it("hard-constrains the pick when every remaining one must fill a starter", () => {
    // The bench stash is worth vastly more on score alone; taking it would end
    // the draft with an empty QB slot, so the weight is not allowed to decide.
    const desperate = [ranked("wr-huge", "WR", 100), ranked("qb-bad", "QB", -50)];
    const result = selectSuggestedPick(desperate, ctx(["QB"], 1), scoreByVor);
    expect(result?.player.id).toBe("qb-bad");
    expect(result?.forced).toBe(true);
    expect(result?.isBench).toBe(false);
  });

  it("does not constrain while there are more picks than holes", () => {
    const desperate = [ranked("wr-huge", "WR", 100), ranked("qb-bad", "QB", -50)];
    const result = selectSuggestedPick(desperate, ctx(["QB"], 2), scoreByVor);
    expect(result?.player.id).toBe("wr-huge");
    expect(result?.forced).toBe(false);
  });

  it("weights a dedicated slot above a flexible one", () => {
    // Equal VOR; only the RB fills the dedicated slot, so it wins.
    const tied = [ranked("wr-flex", "WR", 20), ranked("rb-slot", "RB", 20)];
    expect(selectSuggestedPick(tied, ctx(["RB", "FLEX"], 3), scoreByVor)?.player.id).toBe("rb-slot");
  });

  it("carries no need weight once the lineup is full", () => {
    const result = selectSuggestedPick(board, ctx([], 4), scoreByVor);
    expect(result?.needWeight).toBe(0);
    expect(result?.player.id).toBe("wr-elite");
  });
});

describe("bench depth decays linearly with saturation", () => {
  const lineup = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN"];

  it("shares a flexible slot fractionally across the positions it accepts", () => {
    const cap = depthCapacityByPosition(lineup);
    expect(cap.QB).toBe(1);
    expect(cap.RB).toBeCloseTo(7 / 3);
    expect(cap.WR).toBeCloseTo(7 / 3);
    expect(cap.TE).toBeCloseTo(4 / 3);
    expect(cap.K).toBe(1);
    expect(cap.DEF).toBe(1);
  });

  it("discounts a second tight end that only the shared FLEX could start", () => {
    // The bug: a FLEX credited in full made a second TE worth full value.
    const cap = depthCapacityByPosition(lineup);
    expect(depthValueFactor(1, cap.TE)).toBeCloseTo(5 / 7); // ~0.714, was 1.0
  });

  it("keeps a third receiver near full value as a normal flex starter", () => {
    const cap = depthCapacityByPosition(lineup);
    expect(depthValueFactor(2, cap.WR)).toBeCloseTo(0.8);
  });

  it("keeps a second quarterback at full value in superflex, half in a one-QB league", () => {
    expect(depthValueFactor(1, depthCapacityByPosition([...lineup, "SUPER_FLEX"]).QB)).toBe(1);
    expect(depthValueFactor(1, depthCapacityByPosition(lineup).QB)).toBe(0.5);
  });

  it("holds full value until the lineup is stocked, then decays to zero", () => {
    // One startable: full value for the starter, half for the backup, nothing after.
    expect(depthValueFactor(0, 1)).toBe(1);
    expect(depthValueFactor(1, 1)).toBe(0.5);
    expect(depthValueFactor(2, 1)).toBe(0);
    // Three startable: value runs out at double the complement.
    expect(depthValueFactor(2, 3)).toBe(1);
    expect(depthValueFactor(3, 3)).toBeCloseTo(0.75);
    expect(depthValueFactor(4, 3)).toBeCloseTo(0.5);
    expect(depthValueFactor(6, 3)).toBe(0);
    // A position the lineup cannot field at all is worthless.
    expect(depthValueFactor(0, 0)).toBe(0);
  });

  it("holds the first unheld player at full value even through a shared flex", () => {
    // A TE reachable only via a 3-way FLEX has startable = 1/3. Before the
    // fix, held+1 (1) already exceeded that fractional startable, so the
    // very first TE was discounted to 0.5 — this asserts it now reads 1.
    expect(depthValueFactor(0, 1 / 3)).toBe(1);
  });

  it("discounts a backup without excluding it", () => {
    // The QB scores higher league-wide (30 vs 20), but as a second QB in a
    // 1-QB lineup he is worth half — 15, behind the receiver who is still
    // startable and so undiscounted.
    const board = [ranked("qb-2nd", "QB", 30), ranked("wr-3rd", "WR", 20)];
    const startable = depthCapacityByPosition(lineup);
    expect(selectSuggestedPick(board, { openStarterSlotTypes: [], picksRemaining: 5, startable, held: { QB: 1, WR: 2 } }, scoreByVor)?.player.id)
      .toBe("wr-3rd");
    // With no quarterback yet, the same board goes the other way.
    expect(selectSuggestedPick(board, { openStarterSlotTypes: [], picksRemaining: 5, startable, held: { QB: 0, WR: 2 } }, scoreByVor)?.player.id)
      .toBe("qb-2nd");
  });

  it("drops a saturated position rather than scoring it to zero", () => {
    // The regression: a discounted-to-zero QB scores 0, which beats every
    // sub-replacement player left late in a draft, so it would win anyway.
    const board = [ranked("qb-7th", "QB", 40), ranked("rb-depth", "RB", -5)];
    const startable = depthCapacityByPosition(lineup);
    const result = selectSuggestedPick(
      board, { openStarterSlotTypes: [], picksRemaining: 4, startable, held: { QB: 6, RB: 2 } }, scoreByVor
    );
    expect(result?.player.id).toBe("rb-depth");
  });

  it("still fills an open starter slot at a saturated position", () => {
    // Six quarterbacks and a SUPER_FLEX going begging: the slot wins.
    const board = [ranked("qb-7th", "QB", 40), ranked("rb-depth", "RB", 5)];
    const sf = [...lineup, "SUPER_FLEX"];
    const result = selectSuggestedPick(
      board,
      { openStarterSlotTypes: ["SUPER_FLEX"], picksRemaining: 1, startable: depthCapacityByPosition(sf), held: { QB: 6, RB: 6 } },
      scoreByVor
    );
    expect(result?.forced).toBe(true);
    expect(result?.isBench).toBe(false);
  });

  it("still returns a pick when every position is saturated", () => {
    const board = [ranked("qb-7th", "QB", 40), ranked("rb-7th", "RB", 10)];
    const result = selectSuggestedPick(
      board,
      { openStarterSlotTypes: [], picksRemaining: 1, startable: depthCapacityByPosition(lineup), held: { QB: 6, RB: 6 } },
      scoreByVor
    );
    expect(result).not.toBeNull();
    expect(result?.player.id).toBe("qb-7th"); // nothing usable left; take the best
  });

  it("applies no discount when the caller supplies no lineup", () => {
    const board = [ranked("qb-7th", "QB", 40), ranked("rb-depth", "RB", 10)];
    expect(selectSuggestedPick(board, ctx([], 4), scoreByVor)?.player.id).toBe("qb-7th");
  });

  it("no longer lets a surplus tight end out-rank a real flex receiver", () => {
    // Held: a starting QB, a starting TE, two WRs. Only a FLEX is open, which
    // both the second TE and a third WR could fill. The TE has the higher raw
    // VOR, so with the old full-credit FLEX it topped the pick; discounting the
    // shared second-TE start flips it to the more startable receiver.
    const board = [ranked("te-2nd", "TE", 17), ranked("wr-3rd", "WR", 16)];
    const cap = depthCapacityByPosition(lineup);
    const result = selectSuggestedPick(
      board,
      { openStarterSlotTypes: ["FLEX"], picksRemaining: 10, startable: cap, held: { QB: 1, TE: 1, WR: 2 } },
      scoreByVor
    );
    expect(result?.player.id).toBe("wr-3rd");
  });
});

describe("fillLineupSlots / leagueOpenSlots", () => {
  const roster = ["QB", "RB", "WR", "FLEX", "BN"];

  it("fills the most restrictive slot first", () => {
    // The RB could go to RB or FLEX; the WR-only slot must get the WR.
    const assigned = fillLineupSlots(roster, ["RB", "WR"]);
    expect(assigned).toEqual([null, 0, 1, null, null]);
  });

  it("reports each team's unfilled slots across the league", () => {
    const picks = [
      { teamSlot: 1, playerId: "a" },
      { teamSlot: 1, playerId: "b" },
    ];
    const positionOf = (id: string) => ({ a: "QB", b: "RB" }[id]);
    expect(leagueOpenSlots(picks, positionOf, roster, 2)).toEqual([
      "WR", "FLEX", "BN",              // team 1 still needs these
      "QB", "RB", "WR", "FLEX", "BN",  // team 2 has drafted nothing
    ]);
  });

  it("counts a bench stash as filling the bench, not the starter demand", () => {
    // Two quarterbacks: one starts, one sits. The league's RB/WR/FLEX demand
    // is untouched — which is the whole reason this counts real slots rather
    // than subtracting drafted players from total demand.
    const picks = [
      { teamSlot: 1, playerId: "a" },
      { teamSlot: 1, playerId: "b" },
    ];
    const positionOf = () => "QB";
    expect(leagueOpenSlots(picks, positionOf, roster, 1)).toEqual(["RB", "WR", "FLEX"]);
  });

  it("ignores slots the app does not draft", () => {
    expect(leagueOpenSlots([], () => undefined, ["QB", "IDP_FLEX", "IR"], 1)).toEqual(["QB"]);
  });

  it("fills both WRRB_FLEX and REC_FLEX even though their eligibility overlaps without nesting", () => {
    // Greedy assigns the WR to WRRB_FLEX first (it comes first in priority),
    // leaving REC_FLEX (WR/TE only) unable to take the remaining RB — reported
    // OPEN even though both slots are fillable via WRRB_FLEX<-RB, REC_FLEX<-WR.
    // Matching finds that assignment instead.
    const assigned = fillLineupSlots(["WRRB_FLEX", "REC_FLEX"], ["WR", "RB"]);
    expect(assigned.every((x) => x !== null)).toBe(true);
    assigned.forEach((playerIndex, slotIndex) => {
      if (playerIndex === null) return;
      const slotType = ["WRRB_FLEX", "REC_FLEX"][slotIndex];
      const position = ["WR", "RB"][playerIndex];
      expect(SLEEPER_SLOT_ELIGIBLE[slotType]).toContain(position);
    });
  });

  it("still fills a nesting case (RB slot + FLEX)", () => {
    const assigned = fillLineupSlots(["RB", "FLEX"], ["RB", "WR"]);
    expect(assigned.every((x) => x !== null)).toBe(true);
  });

  it("leaves surplus players unseated when there are more players than slots", () => {
    const assigned = fillLineupSlots(["RB"], ["RB", "RB"]);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).not.toBeNull();
  });
});

describe("K and DEF slots are independent", () => {
  const config = { ...DEFAULT_ROSTER, teams: 12, qb: 1, rb: 2, wr: 2, te: 1, flex: 1, superflex: 0, bench: 1 };

  it("gives a kicker-only league no defense slot", () => {
    // A single flag for both would hand this league a DEF slot it can never
    // start, so the CPU drafts defenses and the baselines carry DEF demand.
    const slots = rosterSlots(config, true, false);
    expect(slots.filter((s) => s === "K")).toHaveLength(1);
    expect(slots).not.toContain("DEF");
  });

  it("gives a defense-only league no kicker slot", () => {
    const slots = rosterSlots(config, false, true);
    expect(slots).not.toContain("K");
    expect(slots.filter((s) => s === "DEF")).toHaveLength(1);
  });

  it("keeps the one- and two-argument forms meaning both or neither", () => {
    expect(rosterSlots(config)).toContain("K");
    expect(rosterSlots(config)).toContain("DEF");
    expect(rosterSlots(config, false)).not.toContain("K");
    expect(rosterSlots(config, false)).not.toContain("DEF");
  });
});

describe("remainingPicksForSlot", () => {
  // 4 teams, 3 rounds, snake: slot 2 owns picks 2, 7, 10.
  const noTrades: never[] = [];

  it("lists a slot's picks in snake order", () => {
    expect(remainingPicksForSlot(1, 4, 3, noTrades, 2, new Set())).toEqual([2, 7, 10]);
    expect(remainingPicksForSlot(1, 4, 3, noTrades, 1, new Set())).toEqual([1, 8, 9]);
  });

  it("skips pick numbers a keeper already consumed", () => {
    // Pick 7 is a keeper: it is in the order but nobody makes it. Counting it
    // would overstate picks remaining and aim survival at a pick that never
    // comes — the two used to disagree about this.
    const filled = new Set([7]);
    expect(remainingPicksForSlot(1, 4, 3, noTrades, 2, filled)).toEqual([2, 10]);
    const fromCurrent = remainingPicksForSlot(2, 4, 3, noTrades, 2, filled);
    expect(fromCurrent.length).toBe(2);                       // picks remaining
    expect(fromCurrent.find((n) => n > 2)).toBe(10);          // next pick, not 7
  });

  it("returns nothing once the draft is over", () => {
    expect(remainingPicksForSlot(13, 4, 3, noTrades, 2, new Set())).toEqual([]);
  });

  it("follows a traded pick to its new owner", () => {
    const trades = [{ round: 2, roster_id: 2, owner_id: 3 }];
    expect(remainingPicksForSlot(1, 4, 3, trades, 2, new Set())).toEqual([2, 10]);
    expect(remainingPicksForSlot(1, 4, 3, trades, 3, new Set())).toEqual([3, 6, 7, 11]);
  });
});

describe("dynamic replacement level", () => {
  // 2 teams, two RB slots each and a single bench spot: four RB starting jobs.
  const roster = { ...DEFAULT_ROSTER, teams: 2, qb: 0, rb: 2, wr: 0, te: 0, flex: 0, superflex: 0, bench: 1 };
  const slots = ["RB", "RB", "BN"];
  const pool: Player[] = Array.from({ length: 10 }, (_, i) => player(`rb${i + 1}`, "RB", 100 - i * 10));
  const positionOf = () => "RB";
  const live = (picks: { teamSlot: number; playerId: string }[]) => ({
    drafted: new Set(picks.map((p) => p.playerId)),
    openSlots: leagueOpenSlots(picks, positionOf, slots, roster.teams),
  });

  it("matches the static baseline before anyone has drafted", () => {
    const staticResult = rankPlayers(pool, DEFAULT_SCORING, roster);
    const dynamicResult = rankPlayers(pool, DEFAULT_SCORING, roster, "VOLS", live([]));
    expect(staticResult.baselines.RB).toEqual({ rank: 5, points: 60 });
    expect(dynamicResult.baselines.RB).toEqual(staticResult.baselines.RB);
    expect(staticResult.dynamic).toBe(false);
    expect(dynamicResult.dynamic).toBe(true);
  });

  it("does not credit a bench stash against remaining starter demand", () => {
    // Team 1 takes rb1/rb2 as starters and rb3 to the bench. Two starting RB
    // jobs are still open, and the three best backs are gone, so replacement
    // is the third-best survivor: rb6. Subtracting three drafted players from
    // the league's demand of four would land a rank early, on rb5.
    const picks = [1, 2, 3].map((n) => ({ teamSlot: 1, playerId: `rb${n}` }));
    const result = rankPlayers(pool, DEFAULT_SCORING, roster, "VOLS", live(picks));
    expect(result.baselines.RB).toEqual({ rank: 6, points: 50 });
  });

  it("drops replacement to the best survivor once the league's starters are set", () => {
    // Every RB job filled and both benches used: no team needs another back,
    // so the best one left is by definition replacement level.
    const picks = [
      ...[1, 2, 5].map((n) => ({ teamSlot: 1, playerId: `rb${n}` })),
      ...[3, 4, 6].map((n) => ({ teamSlot: 2, playerId: `rb${n}` })),
    ];
    const result = rankPlayers(pool, DEFAULT_SCORING, roster, "VOLS", live(picks));
    expect(result.baselines.RB).toEqual({ rank: 7, points: 40 });

    const byId = new Map(result.players.map((p) => [p.id, p]));
    expect(byId.get("rb7")!.vbd).toBe(0);   // the static board still called this -20
    expect(byId.get("rb8")!.vbd).toBe(-10);
  });

  it("leaves a skipped position's replacement level where it was", () => {
    // Nobody has drafted a back. Demand and supply are both untouched, so the
    // baseline must not drift just because the draft has moved on.
    const other: Player[] = Array.from({ length: 6 }, (_, i) => player(`wr${i + 1}`, "WR", 90 - i * 5));
    const withWr = [...pool, ...other];
    const wrSlots = ["RB", "RB", "WR", "BN"];
    const picks = [1, 2].map((n) => ({ teamSlot: 1, playerId: `wr${n}` }));
    const result = rankPlayers(withWr, DEFAULT_SCORING, roster, "VOLS", {
      drafted: new Set(picks.map((p) => p.playerId)),
      openSlots: leagueOpenSlots(picks, (id) => (id.startsWith("wr") ? "WR" : "RB"), wrSlots, 2),
    });
    expect(result.baselines.RB).toEqual({ rank: 5, points: 60 });
  });
});
