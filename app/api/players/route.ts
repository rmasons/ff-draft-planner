import { NextResponse } from "next/server";
import { fetchPlayers, fetch2025ActualStats, SEASON } from "@/lib/sleeper";
import { fetchEspnAdp, normalizeName } from "@/lib/espn";
import { unstable_cache } from "next/cache";

// Cache headers are handled by the in-module memos in sleeper.ts and espn.ts.
export const revalidate = 43200; // 12h

const getCachedPayload = unstable_cache(async () => {
  const [players, espnAdp, actualStats] = await Promise.all([
    fetchPlayers(),
    fetchEspnAdp().catch(() => new Map<string, number>()),
    fetch2025ActualStats().catch(() => new Map()),
  ]);
  const enriched = players.map((p) => ({
    ...p,
    adp: { ...p.adp, espn: espnAdp.get(normalizeName(p.name)) ?? 999 },
    actualStats2025: actualStats.get(p.id) ?? null,
    actualPts2025: null,
  }));
  return {
    season: SEASON,
    count: enriched.length,
    players: enriched,
    sources: { sleeper: true, espn: espnAdp.size > 0, stats2025: actualStats.size > 0 },
    cache: { policy: "next-data-cache+cdn", maxAgeSeconds: 43200, staleWhileRevalidateSeconds: 86400 },
  };
}, ["players-api", SEASON], { revalidate: 43200, tags: [`players-${SEASON}`] });

export async function GET() {
  try {
    const payload = await getCachedPayload();
    return NextResponse.json(payload, { headers: { "Cache-Control": "public, s-maxage=43200, stale-while-revalidate=86400" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to load players", detail: message },
      { status: 502 }
    );
  }
}
