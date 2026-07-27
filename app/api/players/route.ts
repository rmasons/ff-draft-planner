import { NextResponse } from "next/server";
import { fetchPlayers, fetch2025ActualStats, SEASON } from "@/lib/sleeper";
import { fetchEspnAdp, espnAdpKey } from "@/lib/espn";
// `unstable_cache` is superseded in Next 16 — docs/.../04-functions/unstable_cache.md
// says it "has been replaced by `use cache`". We are deliberately NOT migrating
// yet. Blockers, in order of importance (paths are under
// node_modules/next/dist/docs/01-app/):
//
// 1. `use cache` does not document the stale-on-error behavior the per-source
//    split below depends on. That guarantee is stated only for the ISR/Data
//    Cache path, in 02-guides/incremental-static-regeneration.md ("Handling
//    uncaught exceptions"): "If an error is thrown while attempting to
//    revalidate data, the last successfully generated data will continue to be
//    served from the cache. On the next subsequent request, Next.js will retry
//    revalidating the data." Nothing in 03-api-reference/01-directives/use-cache.md,
//    04-functions/cacheLife.md or 04-functions/cacheTag.md says what a
//    `use cache` entry does when its revalidation throws. Trading a documented
//    guarantee for an unestablished one is the exact failure this route is
//    built to avoid — see the block comment below for what rests on it.
//
// 2. `use cache` at runtime is an in-memory LRU, not the durable Data Cache.
//    use-cache.md ("Runtime caching considerations") on Serverless: "Cache
//    entries typically don't persist across requests (each request can be a
//    different instance), or during revalidation." unstable_cache instead
//    "uses Next.js' built-in cache to persist the result across requests and
//    deployments" (unstable_cache.md). This route exists to hold three
//    third-party APIs to one fetch per 12h, which a non-persisting cache
//    defeats. Restoring persistence needs `use cache: remote`, which per
//    use-cache.md "requires a network roundtrip to check the cache and
//    typically incurs platform fees".
//
// 3. `use cache` is gated on `cacheComponents: true` in next.config.ts
//    (use-cache.md, "Usage"). Per 03-api-reference/05-config/01-next-config-js/cacheComponents.md
//    that flag also makes PPR the App Router default and retires
//    `export const revalidate` (02-guides/migrating-to-cache-components.md), so
//    it is a repo-wide switch, not an isolated change to this route.
//
// Note this is not an unsupported path: 02-guides/caching-without-cache-components.md
// is the maintained guide for "projects not using Cache Components" and still
// documents `unstable_cache` for exactly this non-`fetch`, per-source shape.
// Revisit if a future release documents `use cache` revalidation-error
// semantics.
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
