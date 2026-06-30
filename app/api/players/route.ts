import { NextResponse } from "next/server";
import { fetchPlayers, fetch2025ActualPts, SEASON } from "@/lib/sleeper";
import { fetchEspnAdp, normalizeName } from "@/lib/espn";

// Cache headers are handled by the in-module memos in sleeper.ts and espn.ts.
export const revalidate = 43200; // 12h

export async function GET() {
  try {
    // Fetch all three sources in parallel; ESPN and stats failures are non-fatal.
    const [players, espnAdp, actualPts] = await Promise.all([
      fetchPlayers(),
      fetchEspnAdp().catch(() => new Map<string, number>()),
      fetch2025ActualPts().catch(() => new Map<string, number>()),
    ]);

    const enriched = players.map((p) => ({
      ...p,
      adp: {
        ...p.adp,
        espn: espnAdp.get(normalizeName(p.name)) ?? 999,
      },
      actualPts2025: actualPts.get(p.id) ?? null,
    }));

    return NextResponse.json({
      season: SEASON,
      count: enriched.length,
      players: enriched,
      sources: { sleeper: true, espn: espnAdp.size > 0, stats2025: actualPts.size > 0 },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to load players", detail: message },
      { status: 502 }
    );
  }
}
