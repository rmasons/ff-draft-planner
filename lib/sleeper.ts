import type { Player, Position, RawStats } from "./types";
import { ALL_POSITIONS } from "./types";
import { byeFor } from "./byes";

// NFL fantasy season year, derived from today's date instead of hardcoded.
// The season "year" is the calendar year of the season's autumn/winter, but
// free agency, the draft, and offseason roster moves all happen in the
// following Jan/Feb under the SAME season label (e.g. the 2025 season's
// offseason runs into March 2026). So: Jan/Feb still belong to the PREVIOUS
// season, and the new season "year" only starts once March begins.
// `getMonth()` is 0-indexed, so March is index 2 — cutoff is `>= 2`.
const today = new Date();
const seasonYear = today.getMonth() >= 2 ? today.getFullYear() : today.getFullYear() - 1;
export const SEASON: string = String(seasonYear);

const SLEEPER_URL =
  `https://api.sleeper.com/projections/nfl/${SEASON}` +
  `?season_type=regular&order_by=pts_ppr` +
  ALL_POSITIONS.map((p) => `&position[]=${p}`).join("");

// Shape of a single Sleeper projection record (only fields we use).
interface SleeperRecord {
  player_id: string;
  stats: Record<string, number | undefined>;
  player: {
    first_name?: string;
    last_name?: string;
    position?: string;
    fantasy_positions?: string[];
    team?: string | null;
    team_abbr?: string | null;
    years_exp?: number | null;
    injury_status?: string | null;
    injury_body_part?: string | null;
    injury_notes?: string | null;
  };
}

function pickPosition(rec: SleeperRecord): Position | null {
  const cand = [rec.player.position, ...(rec.player.fantasy_positions ?? [])];
  for (const c of cand) {
    if (c && (ALL_POSITIONS as string[]).includes(c)) return c as Position;
  }
  return null;
}

const STAT_KEYS: (keyof RawStats)[] = [
  "pass_yd",
  "pass_td",
  "pass_int",
  "pass_2pt",
  "rush_yd",
  "rush_td",
  "rush_2pt",
  "rec",
  "rec_yd",
  "rec_td",
  "rec_2pt",
  "fum_lost",
  "gp",
  "pts_std", // K/DEF: precomputed season total
];

function normalize(rec: SleeperRecord): Player | null {
  const position = pickPosition(rec);
  if (!position) return null;

  const s = rec.stats ?? {};
  const ptsPpr = s.pts_ppr ?? 0;
  const ptsStd = s.pts_std ?? 0;
  const adpPpr = s.adp_ppr ?? 999;
  // DEF has pts_std > 0 but pts_ppr ≈ 0; include if any scoring projection exists.
  if (ptsPpr <= 0 && ptsStd <= 0 && adpPpr >= 999) return null;

  const stats: RawStats = {};
  for (const k of STAT_KEYS) {
    const v = s[k];
    if (typeof v === "number") stats[k] = v;
  }

  const team = rec.player.team_abbr ?? rec.player.team ?? null;
  const name = `${rec.player.first_name ?? ""} ${
    rec.player.last_name ?? ""
  }`.trim();

  return {
    id: rec.player_id,
    name: name || "Unknown",
    position,
    team,
    yearsExp: rec.player.years_exp ?? null,
    injuryStatus: rec.player.injury_status ?? null,
    injuryBody: rec.player.injury_body_part ?? null,
    injuryNotes: rec.player.injury_notes ?? null,
    bye: byeFor(team),
    stats,
    adp: {
      ppr: s.adp_ppr ?? 999,
      half: s.adp_half_ppr ?? 999,
      std: s.adp_std ?? 999,
      superflex: s.adp_2qb ?? 999,
      espn: 999, // filled in server-side by /api/players after ESPN fetch
    },
    actualStats2025: null,
    actualPts2025: null, // filled in server-side by /api/players after stats fetch
  };
}

// The raw Sleeper response is ~3.9MB (over Next's 2MB fetch-cache limit), so
// we fetch uncached (cache: "no-store") and let the caller's own durable
// cache (see app/api/players/route.ts, which wraps this in unstable_cache)
// persist the much smaller normalized result. This fetch is not itself
// double-cached: it runs fresh each time the outer cache actually invokes it
// (Next's fetch `no-store` fetches the resource from the remote server every
// time it's called, regardless of the surrounding cache/revalidate context —
// see node_modules/next/dist/docs/01-app/03-api-reference/04-functions/fetch.md).
async function fetchPlayersOnce(): Promise<Player[]> {
  const res = await fetch(SLEEPER_URL, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Sleeper request failed: ${res.status} ${res.statusText}`);
  }
  const data: SleeperRecord[] = await res.json();
  const players: Player[] = [];
  const seen = new Set<string>();
  for (const rec of data) {
    const p = normalize(rec);
    // De-dupe by id (the feed occasionally repeats a player across roles).
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      players.push(p);
    }
  }
  return players;
}

/**
 * Fetch + normalize the draftable player pool. This is the required source:
 * a caller (app/api/players/route.ts) is expected to let a failure here
 * propagate rather than fall back to an empty pool. Retries once on failure,
 * then lets the rejection propagate — mirrors fetch2025ActualStats below (and
 * fetchEspnAdp in lib/espn.ts), which the caching-strategy comment in
 * app/api/players/route.ts relies on for every source.
 */
export async function fetchPlayers(): Promise<Player[]> {
  try {
    return await fetchPlayersOnce();
  } catch {
    return await fetchPlayersOnce();
  }
}

// ── 2025 season actuals ────────────────────────────────────────────────────────

// One bulk request covering all fantasy positions. The stats response is the
// same size class as projections (~3MB+), so it also exceeds Next's 2MB
// fetch-cache limit — use cache:"no-store" (see fetchPlayersOnce above for
// why that doesn't mean "uncached": the caller's unstable_cache layer is the
// durable cache for the normalized result).
// Tracks the prior completed season (seasonYear - 1), mirroring SEASON above,
// so this doesn't go stale once the app rolls into a new season.
const PRIOR_STATS_URL =
  `https://api.sleeper.com/stats/nfl/${seasonYear - 1}` +
  `?season_type=regular&order_by=pts_ppr` +
  ALL_POSITIONS.map((p) => `&position[]=${p}`).join("");

async function fetch2025ActualStatsOnce(): Promise<Map<string, RawStats>> {
  const res = await fetch(PRIOR_STATS_URL, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Sleeper stats request failed: ${res.status} ${res.statusText}`
    );
  }

  const records: Array<{
    player_id: string;
    stats: Record<string, number | undefined>;
  }> = await res.json();

  const data = new Map<string, RawStats>();
  for (const r of records) {
    const stats: RawStats = {};
    for (const key of STAT_KEYS) {
      const value = r.stats?.[key];
      if (typeof value === "number") stats[key] = value;
    }
    if (Object.keys(stats).length) data.set(r.player_id, stats);
  }

  return data;
}

/**
 * Returns raw historical stats so the client can apply active league scoring.
 * This is an optional source: retries once on failure, then lets the
 * rejection propagate so the caller's own caching layer can decide whether
 * to keep serving last-known-good data (see app/api/players/route.ts).
 */
export async function fetch2025ActualStats(): Promise<Map<string, RawStats>> {
  try {
    return await fetch2025ActualStatsOnce();
  } catch {
    return await fetch2025ActualStatsOnce();
  }
}
