import { NextResponse } from "next/server";
import { fetchPlayers, fetch2025ActualStats, SEASON } from "@/lib/sleeper";
import { fetchEspnAdp, espnAdpKey } from "@/lib/espn";
import { unstable_cache } from "next/cache";
import type { RawStats } from "@/lib/types";

export const revalidate = 43200; // 12h

// Each source gets its OWN unstable_cache entry (own key + tag) instead of
// one big cache wrapping the whole combined payload. This is the single
// caching layer now (see lib/sleeper.ts / lib/espn.ts — the old in-module
// memos were removed because a second cache layer meant the outer Data Cache
// could revalidate and durably re-cache data that was itself already up to
// 12h stale from the inner memo).
//
// Splitting per source also means a transient failure in an optional source
// (ESPN ADP, 2025 actuals) can't poison the required source (Sleeper's
// player pool) or the other optional source for a full 12h. Per
// node_modules/next/dist/docs/01-app/02-guides/incremental-static-regeneration.md
// ("Handling uncaught exceptions") and the unstable_cache implementation
// itself, when a stale cache entry's background revalidation throws, Next
// keeps serving the last-known-good cached value and retries on the next
// request — it does not durably cache the failure. We lean on that: each
// source's fetcher retries once internally, and only throws if the retry
// also fails, which is exactly the condition where that stale-on-error
// behavior kicks in (once the source has ever produced good data). On a
// genuine first-ever failure (no cached value yet to fall back to) the
// rejection surfaces here, where we catch it request-locally — that fallback
// is never written back to the cache, so it's short-lived, not a 12h outage.
//
// unstable_cache persists its result via JSON.stringify, so the cached
// callables below return plain JSON-safe shapes (arrays of tuples), not the
// Map objects that lib/espn.ts and lib/sleeper.ts return to other callers.

const getCachedSleeperPlayers = unstable_cache(
  fetchPlayers,
  ["players-sleeper", SEASON],
  { revalidate: 43200, tags: [`players-sleeper-${SEASON}`] }
);

const getCachedEspnAdp = unstable_cache(
  async () => {
    const { byNameAndPosition, ambiguousCount } = await fetchEspnAdp();
    return { entries: [...byNameAndPosition.entries()], ambiguousCount };
  },
  ["players-espn-adp", SEASON],
  { revalidate: 43200, tags: [`players-espn-${SEASON}`] }
);

const getCachedActualStats = unstable_cache(
  async () => [...(await fetch2025ActualStats()).entries()],
  ["players-actual-stats", SEASON],
  { revalidate: 43200, tags: [`players-stats-${SEASON}`] }
);

export async function GET() {
  try {
    // Required source: let a failure here 502 instead of masking it.
    const players = await getCachedSleeperPlayers();

    // Optional sources: a failure degrades the payload's `sources` flags
    // rather than the whole request. See the caching note above for why this
    // catch doesn't get baked into the 12h cache.
    const [espnAdpResult, actualStatsEntries] = await Promise.all([
      getCachedEspnAdp().catch(() => ({ entries: [] as [string, number][], ambiguousCount: 0 })),
      getCachedActualStats().catch(() => [] as [string, RawStats][]),
    ]);

    const espnAdpByNameAndPosition = new Map(espnAdpResult.entries);
    const actualStats = new Map(actualStatsEntries);

    const enriched = players.map((p) => ({
      ...p,
      adp: {
        ...p.adp,
        espn: espnAdpByNameAndPosition.get(espnAdpKey(p.name, p.position)) ?? 999,
      },
      actualStats2025: actualStats.get(p.id) ?? null,
      actualPts2025: null,
    }));

    const payload = {
      season: SEASON,
      count: enriched.length,
      players: enriched,
      sources: {
        sleeper: players.length > 0,
        espn: espnAdpByNameAndPosition.size > 0,
        stats2025: actualStats.size > 0,
      },
      diagnostics: {
        espnAmbiguousNameCollisions: espnAdpResult.ambiguousCount,
      },
      cache: { policy: "next-data-cache+cdn", maxAgeSeconds: 43200, staleWhileRevalidateSeconds: 86400 },
    };

    return NextResponse.json(payload, { headers: { "Cache-Control": "public, s-maxage=43200, stale-while-revalidate=86400" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to load players", detail: message },
      { status: 502 }
    );
  }
}
