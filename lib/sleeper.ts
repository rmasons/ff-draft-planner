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
    actualPts2025: null, // filled in server-side by /api/players after stats fetch
  };
}

// The raw Sleeper response is ~3.9MB (over Next's 2MB fetch-cache limit), so we
// fetch uncached and memoize the much smaller normalized result in-module.
const TTL_MS = 60 * 60 * 12 * 1000; // 12h
let memo: { at: number; data: Player[] } | null = null;

async function fetchAndNormalize(): Promise<Player[]> {
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

/** Fetch + normalize the draftable player pool, memoized for 12h. */
export async function fetchPlayers(): Promise<Player[]> {
  const now = Date.now();
  if (memo && now - memo.at < TTL_MS) return memo.data;
  const data = await fetchAndNormalize();
  memo = { at: now, data };
  return data;
}

// ── 2025 season actuals ────────────────────────────────────────────────────────

// One bulk request covering all fantasy positions. The stats response is the
// same size class as projections (~3MB+), so it also exceeds Next's 2MB
// fetch-cache limit — use cache:"no-store" + in-module memo.
const STATS_2025_URL =
  `https://api.sleeper.com/stats/nfl/2025` +
  `?season_type=regular&order_by=pts_ppr` +
  ALL_POSITIONS.map((p) => `&position[]=${p}`).join("");

let statsMemo: { at: number; data: Map<string, number> } | null = null;

/**
 * Returns a map of player_id → 2025 PPR season total.
 * Falls back to pts_std for positions that have no pts_ppr value.
 */
export async function fetch2025ActualPts(): Promise<Map<string, number>> {
  const now = Date.now();
  if (statsMemo && now - statsMemo.at < TTL_MS) return statsMemo.data;

  const res = await fetch(STATS_2025_URL, {
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

  const data = new Map<string, number>();
  for (const r of records) {
    const pts = r.stats?.pts_ppr ?? r.stats?.pts_std;
    if (typeof pts === "number" && pts > 0) {
      data.set(r.player_id, pts);
    }
  }

  statsMemo = { at: now, data };
  return data;
}
