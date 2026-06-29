import type { RosterConfig, ScoringConfig } from "./types";

const BASE_URL = "https://api.sleeper.app/v1";

export type LeagueType = "redraft" | "keeper" | "dynasty";

export interface SleeperUser {
  user_id: string;
  username: string;
  display_name: string;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  total_rosters: number;
  status: string;
  season: string;
  type: LeagueType;
  scoring_settings: Record<string, number>;
  roster_positions: string[];
}

interface RawLeague {
  league_id: string;
  name: string;
  total_rosters?: number;
  status: string;
  season: string;
  settings?: { type?: number; num_teams?: number };
  scoring_settings?: Record<string, number>;
  roster_positions?: string[];
}

interface RawRoster {
  players: string[] | null;
  keepers: string[] | null;
}

async function sleepFetch(url: string) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Sleeper API ${res.status}: ${url}`);
  return res.json();
}

export async function fetchSleeperUser(username: string): Promise<SleeperUser> {
  const data = await sleepFetch(
    `${BASE_URL}/user/${encodeURIComponent(username)}`
  );
  if (!data?.user_id) throw new Error(`User "${username}" not found on Sleeper`);
  return {
    user_id: data.user_id,
    username: data.username ?? username,
    display_name: data.display_name ?? username,
  };
}

function leagueType(raw: RawLeague): LeagueType {
  const t = raw.settings?.type;
  if (t === 2) return "dynasty";
  if (t === 1) return "keeper";
  return "redraft";
}

function parseLeague(raw: RawLeague): SleeperLeague {
  return {
    league_id: raw.league_id,
    name: raw.name,
    // total_rosters is the authoritative field; settings.num_teams as fallback.
    total_rosters: raw.total_rosters ?? raw.settings?.num_teams ?? 12,
    status: raw.status,
    season: raw.season,
    type: leagueType(raw),
    scoring_settings: raw.scoring_settings ?? {},
    roster_positions: raw.roster_positions ?? [],
  };
}

/**
 * Fetches the user's NFL leagues for the given season.
 * Returns an empty array if Sleeper returns null (season not yet created).
 */
export async function fetchUserLeagues(
  user_id: string,
  season: string
): Promise<SleeperLeague[]> {
  const data: RawLeague[] | null = await sleepFetch(
    `${BASE_URL}/user/${user_id}/leagues/nfl/${season}`
  );
  if (!Array.isArray(data)) return [];
  return data.map(parseLeague);
}

// All position strings that map to our `flex` slot (RB/WR/TE eligible).
const FLEX_VARIANTS = new Set(["FLEX", "WRRB_FLEX", "REC_FLEX"]);
// Positions we actively want to ignore (don't count them as anything).
const IGNORE_POS = new Set(["K", "DEF", "IDP", "DL", "LB", "DB", "IR", "TAXI"]);

function countPos(positions: string[], val: string): number {
  return positions.filter((p) => p === val).length;
}

/** Maps a Sleeper league's scoring/roster settings onto our config types. */
export function mapLeagueToConfig(
  league: SleeperLeague,
  fallback: ScoringConfig
): { scoring: ScoringConfig; roster: RosterConfig } {
  const sc = league.scoring_settings;
  const pos = league.roster_positions.filter((p) => !IGNORE_POS.has(p));

  const roster: RosterConfig = {
    teams: league.total_rosters,
    qb: countPos(pos, "QB"),
    rb: countPos(pos, "RB"),
    wr: countPos(pos, "WR"),
    te: countPos(pos, "TE"),
    flex: pos.filter((p) => FLEX_VARIANTS.has(p)).length,
    superflex: countPos(pos, "SUPER_FLEX"),
    bench: countPos(pos, "BN"), // BN only — IR and TAXI excluded above
  };

  // For any stat not present in the league settings, keep the current config value
  // so a partial import never silently zeros out a stat.
  const scoring: ScoringConfig = {
    passYd: sc.pass_yd ?? fallback.passYd,
    passTd: sc.pass_td ?? fallback.passTd,
    passInt: sc.pass_int ?? fallback.passInt, // Sleeper stores as negative (e.g. -2)
    rushYd: sc.rush_yd ?? fallback.rushYd,
    rushTd: sc.rush_td ?? fallback.rushTd,
    recYd: sc.rec_yd ?? fallback.recYd,
    recTd: sc.rec_td ?? fallback.recTd,
    rec: sc.rec ?? 0,
    teRecBonus: sc.bonus_rec_te ?? 0,
    fumLost: sc.fum_lost ?? fallback.fumLost, // also stored as negative
    // 2pt conversions: all three types share the same value in standard leagues
    twoPt: sc.pass_2pt ?? sc.rush_2pt ?? sc.rec_2pt ?? fallback.twoPt,
  };

  return { scoring, roster };
}

/**
 * Returns the Sleeper player IDs that should be treated as unavailable
 * based on league type:
 *   - keeper:  the `keepers` array on each roster (may be empty before deadline)
 *   - dynasty: the full `players` array (entire roster carries over)
 *   - redraft: always empty
 */
export async function fetchKeptPlayerIds(
  league: SleeperLeague
): Promise<string[]> {
  if (league.type === "redraft") return [];

  const rosters: RawRoster[] = await sleepFetch(
    `${BASE_URL}/league/${league.league_id}/rosters`
  );
  if (!Array.isArray(rosters)) return [];

  const ids = new Set<string>();
  for (const r of rosters) {
    const source =
      league.type === "dynasty"
        ? (r.players ?? []) // whole roster carries over
        : (r.keepers ?? []); // only designated keepers
    for (const id of source) ids.add(id);
  }
  return [...ids];
}
