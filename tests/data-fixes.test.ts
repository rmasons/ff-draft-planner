import { afterEach, describe, expect, it, vi } from "vitest";
import { espnAdpKey, fetchEspnAdp, normalizeName } from "../lib/espn";
import { fetch2025ActualStats, fetchPlayers } from "../lib/sleeper";

// Regression tests for:
//  - BUG 9: ESPN ADP must be joined by name + position, not name alone.
//    Real duplicate NFL names across positions/teams (e.g. two "Josh Allen"s)
//    must not silently steal/share one ADP; a genuine name+position collision
//    must drop the ambiguous ADP entirely and be counted in diagnostics.
//  - BUG 10: every source (ESPN ADP, 2025 actual stats, and the required
//    Sleeper player pool) that fails should retry once. For the optional
//    sources, a failure that survives the retry must not poison the rest of
//    the payload — the caller degrades that one source instead of throwing
//    away everything. For the required source, a failure that survives the
//    retry is expected to propagate (see app/api/players/route.ts).

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

function espnPlayer(overrides: Record<string, unknown>) {
  return {
    id: 1,
    fullName: "Test Player",
    defaultPositionId: 3,
    ownership: { averageDraftPosition: 10 },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeName", () => {
  it("lowercases, strips punctuation/accents, and strips trailing generational suffixes", () => {
    expect(normalizeName("Marvin Harrison Jr.")).toBe("marvin harrison");
    expect(normalizeName("Michael Pittman III")).toBe("michael pittman");
    expect(normalizeName("Odell Beckham Jr.")).toBe("odell beckham");
    expect(normalizeName("Amari Cooper")).toBe("amari cooper");
    // "iv" only strips as its own trailing word, not mid-word.
    expect(normalizeName("Oliver")).toBe("oliver");
  });
});

describe("espnAdpKey", () => {
  it("combines normalized name and position so same-name/different-position players don't collide", () => {
    expect(espnAdpKey("Josh Allen", "QB")).not.toBe(espnAdpKey("Josh Allen", "RB"));
    expect(espnAdpKey("Josh Allen Jr.", "QB")).toBe(espnAdpKey("Josh Allen", "QB"));
  });
});

describe("fetchEspnAdp — name+position join (BUG 9)", () => {
  it("joins by normalized name + mapped ESPN defaultPositionId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          espnPlayer({ id: 1, fullName: "Justin Jefferson", defaultPositionId: 3, ownership: { averageDraftPosition: 2.5 } }),
          espnPlayer({ id: 2, fullName: "Travis Kelce", defaultPositionId: 4, ownership: { averageDraftPosition: 15 } }),
          espnPlayer({ id: 3, fullName: "Broncos D/ST", defaultPositionId: 16, ownership: { averageDraftPosition: 140 } }),
        ])
      )
    );

    const result = await fetchEspnAdp();

    expect(result.ambiguousCount).toBe(0);
    expect(result.byNameAndPosition.get(espnAdpKey("Justin Jefferson", "WR"))).toBe(2.5);
    expect(result.byNameAndPosition.get(espnAdpKey("Travis Kelce", "TE"))).toBe(15);
    expect(result.byNameAndPosition.get(espnAdpKey("Broncos D/ST", "DEF"))).toBe(140);
  });

  it("keeps two same-named players distinct when their positions differ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          espnPlayer({ id: 1, fullName: "Josh Allen", defaultPositionId: 1, ownership: { averageDraftPosition: 5 } }), // QB (Bills)
          espnPlayer({ id: 2, fullName: "Josh Allen", defaultPositionId: 2, ownership: { averageDraftPosition: 300 } }), // RB (a real duplicate name)
        ])
      )
    );

    const result = await fetchEspnAdp();

    expect(result.ambiguousCount).toBe(0);
    expect(result.byNameAndPosition.get(espnAdpKey("Josh Allen", "QB"))).toBe(5);
    expect(result.byNameAndPosition.get(espnAdpKey("Josh Allen", "RB"))).toBe(300);
  });

  it("drops the ADP for a genuine name+position collision and counts it in diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          // Two distinct ESPN player IDs sharing the exact same normalized
          // name AND the same position — we can't tell them apart, so no ADP
          // should be attached to either (better than silently picking one).
          espnPlayer({ id: 10, fullName: "Michael Thomas", defaultPositionId: 3, ownership: { averageDraftPosition: 45 } }),
          espnPlayer({ id: 11, fullName: "Michael Thomas", defaultPositionId: 3, ownership: { averageDraftPosition: 410 } }),
          // An unrelated player must be unaffected by the collision above.
          espnPlayer({ id: 12, fullName: "CeeDee Lamb", defaultPositionId: 3, ownership: { averageDraftPosition: 4 } }),
        ])
      )
    );

    const result = await fetchEspnAdp();

    expect(result.ambiguousCount).toBe(1);
    expect(result.byNameAndPosition.has(espnAdpKey("Michael Thomas", "WR"))).toBe(false);
    expect(result.byNameAndPosition.get(espnAdpKey("CeeDee Lamb", "WR"))).toBe(4);
  });

  it("drops players with no mappable fantasy position instead of guessing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          espnPlayer({ id: 20, fullName: "Some Linebacker", defaultPositionId: 9, ownership: { averageDraftPosition: 300 } }),
          espnPlayer({ id: 21, fullName: "No Position Player", defaultPositionId: undefined, ownership: { averageDraftPosition: 300 } }),
        ])
      )
    );

    const result = await fetchEspnAdp();

    expect(result.byNameAndPosition.size).toBe(0);
    expect(result.ambiguousCount).toBe(0);
  });
});

describe("fetchEspnAdp — retry + failure isolation (BUG 10)", () => {
  it("retries once on failure and succeeds on the second attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(
        jsonResponse([espnPlayer({ fullName: "Amon-Ra St. Brown", defaultPositionId: 3, ownership: { averageDraftPosition: 20 } })])
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchEspnAdp();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.byNameAndPosition.get(espnAdpKey("Amon-Ra St. Brown", "WR"))).toBe(20);
  });

  it("propagates the error only after both the initial attempt and the retry fail", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("still down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEspnAdp()).rejects.toThrow("still down");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a failure that survives the retry degrades gracefully instead of poisoning the payload", async () => {
    // This mirrors exactly the fallback pattern app/api/players/route.ts uses
    // around its optional sources: catch at the call site (never inside the
    // cached function) so the empty result is never durably cached.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ESPN is down")));

    const fallback = { entries: [] as [string, number][], ambiguousCount: 0 };
    const result = await fetchEspnAdp()
      .then((r) => ({ entries: [...r.byNameAndPosition.entries()] as [string, number][], ambiguousCount: r.ambiguousCount }))
      .catch(() => fallback);

    expect(result).toEqual(fallback);
    // The shape a route consumer would derive from this (an accurate,
    // non-hardcoded `sources.espn` flag) must reflect the real outcome.
    const sourcesEspn = new Map(result.entries).size > 0;
    expect(sourcesEspn).toBe(false);
  });
});

describe("fetch2025ActualStats — optional source retry (BUG 10)", () => {
  it("retries once on a failed request and returns data from the successful retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false, 503))
      .mockResolvedValueOnce(jsonResponse([{ player_id: "p1", stats: { rec: 5, rec_yd: 60 } }]));
    vi.stubGlobal("fetch", fetchMock);

    const stats = await fetch2025ActualStats();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stats.get("p1")).toEqual({ rec: 5, rec_yd: 60 });
  });

  it("propagates the error when both the initial attempt and the retry fail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetch2025ActualStats()).rejects.toThrow(/Sleeper stats request failed/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a failure that survives the retry degrades gracefully instead of poisoning the payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false, 500)));

    const stats = await fetch2025ActualStats().catch(() => new Map());

    expect(stats.size).toBe(0);
  });
});

describe("fetchPlayers — required source retry (BUG 10)", () => {
  const sleeperPlayerRecord = {
    player_id: "p1",
    stats: { pts_ppr: 12.3 },
    player: { first_name: "Test", last_name: "Player", position: "RB" },
  };

  it("retries once on a failed request and returns data from the successful retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false, 503))
      .mockResolvedValueOnce(jsonResponse([sleeperPlayerRecord]));
    vi.stubGlobal("fetch", fetchMock);

    const players = await fetchPlayers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(players).toHaveLength(1);
    expect(players[0].id).toBe("p1");
  });

  it("propagates the error when both the initial attempt and the retry fail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPlayers()).rejects.toThrow(/Sleeper request failed/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
