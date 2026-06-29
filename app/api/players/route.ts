import { NextResponse } from "next/server";
import { fetchPlayers, SEASON } from "@/lib/sleeper";
import { fetchEspnAdp, normalizeName } from "@/lib/espn";

// Cache headers are handled by the in-module memos in sleeper.ts and espn.ts.
export const revalidate = 43200; // 12h

export async function GET() {
  try {
    // Fetch both sources in parallel; ESPN failure is non-fatal.
    const [players, espnAdp] = await Promise.all([
      fetchPlayers(),
      fetchEspnAdp().catch(() => new Map<string, number>()),
    ]);

    const enriched = players.map((p) => ({
      ...p,
      adp: {
        ...p.adp,
        espn: espnAdp.get(normalizeName(p.name)) ?? 999,
      },
    }));

    return NextResponse.json({
      season: SEASON,
      count: enriched.length,
      players: enriched,
      sources: { sleeper: true, espn: espnAdp.size > 0 },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to load players", detail: message },
      { status: 502 }
    );
  }
}
