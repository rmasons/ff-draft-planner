import { NextResponse } from "next/server";
import { fetchPlayers, SEASON } from "@/lib/sleeper";

// Cache the upstream fetch; revalidate is handled in fetchPlayers().
export const revalidate = 43200; // 12h

export async function GET() {
  try {
    const players = await fetchPlayers();
    return NextResponse.json({ season: SEASON, count: players.length, players });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to load players", detail: message },
      { status: 502 }
    );
  }
}
