import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLeagueKeepers, inferKeeperRoundConvention } from "../lib/sleeper-league";
import {
  assignKeeperRounds,
  keeperConflict,
  mergeImportedKeepers,
  type ImportedKeeper,
  type KeeperCandidate,
} from "../lib/draft";

// Minimal fetch stub keyed by URL substring match, in the style of a router.
// Each test registers only the endpoints it needs; anything unmatched
// throws loudly (via a 404-shaped response) so an unexpected call is
// immediately visible instead of silently returning undefined.
function stubFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  // Longest key first: "/draft/d1" would otherwise also match the more
  // specific "/draft/d1/picks" URL, since both are substring tests.
  const entries = Object.entries(routes).sort((a, b) => b[0].length - a[0].length);
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    for (const [key, body] of entries) {
      if (url.includes(key)) {
        return { ok: true, status: 200, json: async () => body } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLeagueKeepers — board mechanism", () => {
  it("computes round from pick_no in a 12-team draft (odd and even rounds)", async () => {
    const { calls } = stubFetch({
      "/draft/d1": { league_id: "L1", settings: { teams: 12 }, slot_to_roster_id: {} },
      "/draft/d1/picks": [
        { pick_no: 1, draft_slot: 1, player_id: "p1", is_keeper: true },
        { pick_no: 12, draft_slot: 12, player_id: "p12", is_keeper: true },
        { pick_no: 13, draft_slot: 1, player_id: "p13", is_keeper: true },
        { pick_no: 24, draft_slot: 12, player_id: "p24", is_keeper: true },
        { pick_no: 25, draft_slot: 1, player_id: "p25", is_keeper: null }, // not a keeper
      ],
    });

    const result = await fetchLeagueKeepers("d1");
    expect(result.source).toBe("board");
    expect(result.keepers).toEqual([
      { playerId: "p1", teamSlot: 1, round: 1 },
      { playerId: "p12", teamSlot: 12, round: 1 },
      { playerId: "p13", teamSlot: 1, round: 2 },
      { playerId: "p24", teamSlot: 12, round: 2 },
    ]);
    // The board had keepers, so the rosters endpoint must never be hit.
    expect(calls.some((u) => u.includes("/rosters"))).toBe(false);
  });

  it("skips null and duplicate player ids", async () => {
    stubFetch({
      "/draft/d2": { league_id: "L2", settings: { teams: 10 } },
      "/draft/d2/picks": [
        { pick_no: 1, draft_slot: 1, player_id: null, is_keeper: true },
        { pick_no: 2, draft_slot: 2, player_id: "dup", is_keeper: true },
        { pick_no: 3, draft_slot: 3, player_id: "dup", is_keeper: true },
      ],
    });
    const result = await fetchLeagueKeepers("d2");
    expect(result.source).toBe("board");
    expect(result.keepers).toHaveLength(1);
    expect(result.keepers[0].playerId).toBe("dup");
  });
});

describe("fetchLeagueKeepers — rosters mechanism", () => {
  it("falls back to rosters when the board has no keepers, resolving teamSlot via slot_to_roster_id and leaving round null", async () => {
    stubFetch({
      "/draft/d3": {
        league_id: "L3",
        settings: { teams: 4 },
        slot_to_roster_id: { "1": 101, "2": 102, "3": 103, "4": 104 },
      },
      "/draft/d3/picks": [],
      "/league/L3/rosters": [
        { roster_id: 101, keepers: ["a", "b"] },
        { roster_id: 102, keepers: null },
      ],
    });
    const result = await fetchLeagueKeepers("d3");
    expect(result.source).toBe("rosters");
    expect(result.keepers).toEqual([
      { playerId: "a", teamSlot: 1, round: null },
      { playerId: "b", teamSlot: 1, round: null },
    ]);
  });

  it("returns teamSlot: null when slot_to_roster_id is missing", async () => {
    stubFetch({
      "/draft/d4": { league_id: "L4", settings: { teams: 4 } },
      "/draft/d4/picks": [],
      "/league/L4/rosters": [{ roster_id: 201, keepers: ["c"] }],
    });
    const result = await fetchLeagueKeepers("d4");
    expect(result.source).toBe("rosters");
    expect(result.keepers).toEqual([{ playerId: "c", teamSlot: null, round: null }]);
  });

  it("skips null and duplicate player ids across rosters", async () => {
    stubFetch({
      "/draft/d5": { league_id: "L5", settings: { teams: 4 }, slot_to_roster_id: { "1": 301, "2": 302 } },
      "/draft/d5/picks": [],
      "/league/L5/rosters": [
        { roster_id: 301, keepers: ["x", null] },
        { roster_id: 302, keepers: ["x"] },
      ],
    });
    const result = await fetchLeagueKeepers("d5");
    expect(result.keepers).toHaveLength(1);
    expect(result.keepers[0]).toEqual({ playerId: "x", teamSlot: 1, round: null });
  });

  it("returns no keepers (without throwing) when the draft has no league_id", async () => {
    stubFetch({ "/draft/d6": { settings: { teams: 4 } }, "/draft/d6/picks": [] });
    const result = await fetchLeagueKeepers("d6");
    expect(result).toEqual({ keepers: [], source: "rosters" });
  });
});

describe("fetchLeagueKeepers — draft endpoint failure", () => {
  it("throws a clear error when the draft itself can't be fetched", async () => {
    stubFetch({}); // everything 404s
    await expect(fetchLeagueKeepers("missing")).rejects.toThrow("Draft not found (404)");
  });
});

describe("keeperConflict", () => {
  const numTeams = 12;
  const confirmed = (over: Partial<KeeperCandidate> = {}): KeeperCandidate => ({
    playerId: "p", teamSlot: 1, round: 1, roundConfirmed: true, ...over,
  });

  it("accepts a candidate with no conflicts", () => {
    expect(keeperConflict(confirmed(), [], [], numTeams)).toBeNull();
  });

  it("rejects a duplicate player already pending", () => {
    const candidate = confirmed({ playerId: "dup", teamSlot: 5, round: 3 });
    const others = [confirmed({ playerId: "dup", teamSlot: 1, round: 1 })];
    expect(keeperConflict(candidate, others, [], numTeams)).toBe("duplicate-pending-keeper");
  });

  it("rejects a player already drafted (present in existingPicks)", () => {
    const candidate = confirmed({ playerId: "drafted-guy", teamSlot: 5, round: 3 });
    const existingPicks = [{ pickNumber: 99, playerId: "drafted-guy", isKeeper: false }];
    expect(keeperConflict(candidate, [], existingPicks, numTeams)).toBe("duplicate-drafted-player");
  });

  it("rejects a pick-number collision with an existing non-keeper pick", () => {
    // Round 1, slot 1 in a 12-team draft => pick #1.
    const candidate = confirmed({ round: 1, teamSlot: 1 });
    const existingPicks = [{ pickNumber: 1, playerId: "someone-else", isKeeper: false }];
    expect(keeperConflict(candidate, [], existingPicks, numTeams)).toBe("collision-existing-pick");
  });

  it("does NOT collide with an existing pick that is itself a keeper", () => {
    const candidate = confirmed({ round: 1, teamSlot: 1 });
    const existingPicks = [{ pickNumber: 1, playerId: "someone-else", isKeeper: true }];
    expect(keeperConflict(candidate, [], existingPicks, numTeams)).toBeNull();
  });

  it("rejects a pick-number collision with another accepted (confirmed) keeper", () => {
    const candidate = confirmed({ playerId: "new-guy", round: 2, teamSlot: 3 });
    const others = [confirmed({ playerId: "other-guy", round: 2, teamSlot: 3 })];
    expect(keeperConflict(candidate, others, [], numTeams)).toBe("collision-pending-keeper");
  });

  it("unconfirmed rows bypass the pick-number collision rule entirely", () => {
    // Both default to round 1 / slot 1 (pick #1) because Sleeper supplied no
    // round for either — without the roundConfirmed bypass this would be a
    // pick-number collision, but neither row's round is real yet.
    const candidate: KeeperCandidate = { playerId: "unconfirmed-a", teamSlot: 1, round: 1, roundConfirmed: false };
    const others: KeeperCandidate[] = [{ playerId: "unconfirmed-b", teamSlot: 1, round: 1, roundConfirmed: false }];
    expect(keeperConflict(candidate, others, [], numTeams)).toBeNull();
  });

  it("an unconfirmed row still rejects on duplicate player or already-drafted", () => {
    const dup: KeeperCandidate = { playerId: "same", teamSlot: 1, round: 1, roundConfirmed: false };
    const others: KeeperCandidate[] = [{ playerId: "same", teamSlot: 2, round: 1, roundConfirmed: false }];
    expect(keeperConflict(dup, others, [], numTeams)).toBe("duplicate-pending-keeper");

    const drafted: KeeperCandidate = { playerId: "already-drafted", teamSlot: 1, round: 1, roundConfirmed: false };
    const existingPicks = [{ pickNumber: 50, playerId: "already-drafted", isKeeper: false }];
    expect(keeperConflict(drafted, [], existingPicks, numTeams)).toBe("duplicate-drafted-player");
  });
});

describe("mergeImportedKeepers", () => {
  const numTeams = 12;

  it("applies defaults and marks a round-less keeper unconfirmed", () => {
    const { keepers, added, upgraded, skipped } = mergeImportedKeepers(
      [],
      [{ playerId: "a", teamSlot: 4, round: null }],
      [],
      numTeams
    );
    expect({ added, upgraded, skipped }).toEqual({ added: 1, upgraded: 0, skipped: 0 });
    expect(keepers).toEqual([{ playerId: "a", teamSlot: 4, round: 1, roundConfirmed: false }]);
  });

  it("defaults a missing team slot to 1 while keeping a supplied round confirmed", () => {
    const { keepers } = mergeImportedKeepers([], [{ playerId: "a", teamSlot: null, round: 3 }], [], numTeams);
    expect(keepers[0]).toEqual({ playerId: "a", teamSlot: 1, round: 3, roundConfirmed: true });
  });

  it("accepts a whole rosters-sourced batch despite every row sharing pick #1", () => {
    // No rounds means every row defaults to round 1 / slot 1 unless Sleeper
    // supplied a slot — they must not knock each other out on pick number.
    const incoming = [
      { playerId: "a", teamSlot: null, round: null },
      { playerId: "b", teamSlot: null, round: null },
      { playerId: "c", teamSlot: null, round: null },
    ];
    const { keepers, added, skipped } = mergeImportedKeepers([], incoming, [], numTeams);
    expect({ added, skipped }).toEqual({ added: 3, skipped: 0 });
    expect(keepers.every((k) => k.roundConfirmed === false)).toBe(true);
  });

  it("upgrades an unconfirmed pending row when the board supplies a real round", () => {
    const pending: KeeperCandidate[] = [{ playerId: "a", teamSlot: 1, round: 1, roundConfirmed: false }];
    const { keepers, added, upgraded, skipped } = mergeImportedKeepers(
      pending,
      [{ playerId: "a", teamSlot: 7, round: 5 }],
      [],
      numTeams
    );
    expect({ added, upgraded, skipped }).toEqual({ added: 0, upgraded: 1, skipped: 0 });
    expect(keepers).toEqual([{ playerId: "a", teamSlot: 7, round: 5, roundConfirmed: true }]);
  });

  it("never lets a placeholder overwrite a round the user already set", () => {
    const pending: KeeperCandidate[] = [{ playerId: "a", teamSlot: 7, round: 5, roundConfirmed: true }];
    const { keepers, added, upgraded, skipped } = mergeImportedKeepers(
      pending,
      [{ playerId: "a", teamSlot: 1, round: null }],
      [],
      numTeams
    );
    expect({ added, upgraded, skipped }).toEqual({ added: 0, upgraded: 0, skipped: 1 });
    expect(keepers).toEqual(pending);
  });

  it("does not mutate the pending list it was given", () => {
    const pending: KeeperCandidate[] = [{ playerId: "a", teamSlot: 1, round: 1, roundConfirmed: false }];
    mergeImportedKeepers(pending, [{ playerId: "a", teamSlot: 7, round: 5 }], [], numTeams);
    expect(pending).toEqual([{ playerId: "a", teamSlot: 1, round: 1, roundConfirmed: false }]);
  });

  it("skips a player who is already an existing pick", () => {
    const { keepers, added, skipped } = mergeImportedKeepers(
      [],
      [{ playerId: "a", teamSlot: 2, round: 3 }],
      [{ pickNumber: 40, playerId: "a", isKeeper: false }],
      numTeams
    );
    expect({ added, skipped }).toEqual({ added: 0, skipped: 1 });
    expect(keepers).toEqual([]);
  });

  it("skips a confirmed row colliding on pick number with an earlier row in the same batch", () => {
    const incoming = [
      { playerId: "a", teamSlot: 3, round: 2 },
      { playerId: "b", teamSlot: 3, round: 2 },
    ];
    const { keepers, added, skipped } = mergeImportedKeepers([], incoming, [], numTeams);
    expect({ added, skipped }).toEqual({ added: 1, skipped: 1 });
    expect(keepers.map((k) => k.playerId)).toEqual(["a"]);
  });
});

describe("assignKeeperRounds", () => {
  const valueOf = (points: Record<string, number>) => (playerId: string) => points[playerId] ?? 0;

  it("leaves rounds null when the convention is null", () => {
    const keepers: ImportedKeeper[] = [{ playerId: "a", teamSlot: 1, round: null }];
    const result = assignKeeperRounds(keepers, null, valueOf({}));
    expect(result).toEqual(keepers);
  });

  it("leaves rounds null when the convention is empty", () => {
    const keepers: ImportedKeeper[] = [{ playerId: "a", teamSlot: 1, round: null }];
    const result = assignKeeperRounds(keepers, [], valueOf({}));
    expect(result).toEqual(keepers);
  });

  it("assigns convention rounds within a team, best-valued player first", () => {
    const keepers: ImportedKeeper[] = [
      { playerId: "low", teamSlot: 1, round: null },
      { playerId: "high", teamSlot: 1, round: null },
    ];
    const result = assignKeeperRounds(keepers, [13, 14], valueOf({ low: 50, high: 200 }));
    expect(result).toEqual([
      { playerId: "low", teamSlot: 1, round: 14 },
      { playerId: "high", teamSlot: 1, round: 13 },
    ]);
  });

  it("never overwrites a round already set on the board", () => {
    const keepers: ImportedKeeper[] = [{ playerId: "a", teamSlot: 1, round: 7 }];
    const result = assignKeeperRounds(keepers, [13, 14], valueOf({ a: 999 }));
    expect(result).toEqual([{ playerId: "a", teamSlot: 1, round: 7 }]);
  });

  it("leaves the teamSlot: null group's rounds null", () => {
    const keepers: ImportedKeeper[] = [
      { playerId: "a", teamSlot: null, round: null },
      { playerId: "b", teamSlot: 2, round: null },
    ];
    const result = assignKeeperRounds(keepers, [13, 14], valueOf({ a: 100, b: 50 }));
    expect(result.find((k) => k.playerId === "a")).toEqual({ playerId: "a", teamSlot: null, round: null });
    expect(result.find((k) => k.playerId === "b")).toEqual({ playerId: "b", teamSlot: 2, round: 13 });
  });

  it("leaves surplus keepers null when a team has more round-less keepers than convention rounds", () => {
    const keepers: ImportedKeeper[] = [
      { playerId: "a", teamSlot: 1, round: null },
      { playerId: "b", teamSlot: 1, round: null },
      { playerId: "c", teamSlot: 1, round: null },
    ];
    const result = assignKeeperRounds(keepers, [13, 14], valueOf({ a: 300, b: 200, c: 100 }));
    expect(result).toEqual([
      { playerId: "a", teamSlot: 1, round: 13 },
      { playerId: "b", teamSlot: 1, round: 14 },
      { playerId: "c", teamSlot: 1, round: null },
    ]);
  });

  it("skips a convention round already taken by that team's board keeper", () => {
    const keepers: ImportedKeeper[] = [
      { playerId: "board", teamSlot: 1, round: 13 },
      { playerId: "inferred", teamSlot: 1, round: null },
    ];
    const result = assignKeeperRounds(keepers, [13, 14], valueOf({ inferred: 100 }));
    expect(result.find((k) => k.playerId === "inferred")).toEqual({ playerId: "inferred", teamSlot: 1, round: 14 });
  });

  it("breaks ties on equal value deterministically by playerId", () => {
    const keepers: ImportedKeeper[] = [
      { playerId: "zeta", teamSlot: 1, round: null },
      { playerId: "alpha", teamSlot: 1, round: null },
    ];
    const result = assignKeeperRounds(keepers, [13, 14], valueOf({ zeta: 100, alpha: 100 }));
    // "alpha" sorts before "zeta" on the tie-break, so it gets the earlier round.
    expect(result.find((k) => k.playerId === "alpha")?.round).toBe(13);
    expect(result.find((k) => k.playerId === "zeta")?.round).toBe(14);

    // Re-running with the same input produces the same assignment.
    const rerun = assignKeeperRounds(keepers, [13, 14], valueOf({ zeta: 100, alpha: 100 }));
    expect(rerun).toEqual(result);
  });

  it("does not mutate the input array", () => {
    const keepers: ImportedKeeper[] = [{ playerId: "a", teamSlot: 1, round: null }];
    const snapshot = keepers.map((k) => ({ ...k }));
    assignKeeperRounds(keepers, [13, 14], valueOf({ a: 100 }));
    expect(keepers).toEqual(snapshot);
  });
});

describe("inferKeeperRoundConvention", () => {
  it("infers the real shape: prior 14-round draft with keepers in rounds 13 & 14 maps to the current draft's last 2 rounds", async () => {
    const priorPicks = [
      { round: 1, is_keeper: null },
      { round: 1, is_keeper: null },
      { round: 13, is_keeper: true },
      { round: 13, is_keeper: true },
      { round: 13, is_keeper: true },
      { round: 14, is_keeper: true },
      { round: 14, is_keeper: true },
      { round: 14, is_keeper: true },
    ];
    stubFetch({
      "/draft/cur1": { league_id: "L100", settings: { rounds: 15 } },
      "/league/L100": { previous_league_id: "L99" },
      "/league/L99/drafts": [{ draft_id: "priorD1", type: "snake", sport: "nfl" }],
      "/league/L99": { season: "2025" },
      "/draft/priorD1/picks": priorPicks,
    });

    const convention = await inferKeeperRoundConvention("cur1");
    expect(convention).toEqual({
      rounds: [14, 15],
      sourceLeagueId: "L99",
      sourceSeason: "2025",
      priorRounds: [13, 14],
    });
  });

  it("returns null when the prior draft's keeper rounds are scattered rather than a trailing block", async () => {
    const priorPicks = [
      { round: 2, is_keeper: true },
      { round: 5, is_keeper: true },
      { round: 9, is_keeper: true },
      { round: 10, is_keeper: null },
    ];
    stubFetch({
      "/draft/cur2": { league_id: "L200", settings: { rounds: 10 } },
      "/league/L200": { previous_league_id: "L199" },
      "/league/L199/drafts": [{ draft_id: "priorD2", type: "snake", sport: "nfl" }],
      "/league/L199": { season: "2025" },
      "/draft/priorD2/picks": priorPicks,
    });

    expect(await inferKeeperRoundConvention("cur2")).toBeNull();
  });

  it("returns null when the keeper rounds are contiguous but not at the end of the draft", async () => {
    const priorPicks = [
      { round: 10, is_keeper: true },
      { round: 11, is_keeper: true },
      { round: 14, is_keeper: null },
    ];
    stubFetch({
      "/draft/cur3": { league_id: "L300", settings: { rounds: 14 } },
      "/league/L300": { previous_league_id: "L299" },
      "/league/L299/drafts": [{ draft_id: "priorD3", type: "snake", sport: "nfl" }],
      "/league/L299": { season: "2025" },
      "/draft/priorD3/picks": priorPicks,
    });

    expect(await inferKeeperRoundConvention("cur3")).toBeNull();
  });

  it("returns null when a trailing-block round is only 50% keepers", async () => {
    const priorPicks = [
      { round: 3, is_keeper: true },
      { round: 3, is_keeper: true },
      { round: 3, is_keeper: true },
      { round: 3, is_keeper: true },
      { round: 4, is_keeper: true },
      { round: 4, is_keeper: true },
      { round: 4, is_keeper: null },
      { round: 4, is_keeper: null },
    ];
    stubFetch({
      "/draft/cur4": { league_id: "L400", settings: { rounds: 4 } },
      "/league/L400": { previous_league_id: "L399" },
      "/league/L399/drafts": [{ draft_id: "priorD4", type: "snake", sport: "nfl" }],
      "/league/L399": { season: "2025" },
      "/draft/priorD4/picks": priorPicks,
    });

    expect(await inferKeeperRoundConvention("cur4")).toBeNull();
  });

  it("returns null when the league has no previous_league_id", async () => {
    stubFetch({
      "/draft/cur5": { league_id: "L500", settings: { rounds: 14 } },
      "/league/L500": {},
    });

    expect(await inferKeeperRoundConvention("cur5")).toBeNull();
  });

  it("returns null when the prior draft has no keepers at all", async () => {
    const priorPicks = [
      { round: 1, is_keeper: null },
      { round: 2, is_keeper: null },
      { round: 3, is_keeper: null },
    ];
    stubFetch({
      "/draft/cur6": { league_id: "L600", settings: { rounds: 14 } },
      "/league/L600": { previous_league_id: "L599" },
      "/league/L599/drafts": [{ draft_id: "priorD6", type: "snake", sport: "nfl" }],
      "/league/L599": { season: "2025" },
      "/draft/priorD6/picks": priorPicks,
    });

    expect(await inferKeeperRoundConvention("cur6")).toBeNull();
  });

  it("returns null when the current draft has fewer rounds than the inferred convention needs", async () => {
    const priorPicks = [
      { round: 13, is_keeper: true },
      { round: 14, is_keeper: true },
    ];
    stubFetch({
      // Current draft only has 1 round -- can't fit a 2-round convention.
      "/draft/cur7": { league_id: "L700", settings: { rounds: 1 } },
      "/league/L700": { previous_league_id: "L699" },
      "/league/L699/drafts": [{ draft_id: "priorD7", type: "snake", sport: "nfl" }],
      "/league/L699": { season: "2025" },
      "/draft/priorD7/picks": priorPicks,
    });

    expect(await inferKeeperRoundConvention("cur7")).toBeNull();
  });
});
