import type { RosterConfig, ScoringConfig } from "./types";

const BASE_URL = "https://api.sleeper.app/v1";

/** Normalize a user-typed Sleeper draft id: a pasted full URL is reduced to
 *  its longest run of digits (the draft id) — Sleeper draft ids are long
 *  digit strings, so taking the longest run (rather than the last) avoids
 *  picking up a short trailing numeric query param (e.g. "?ref=5"); a bare
 *  id passes through (URL-encoded). Shared by fetchLeagueKeepers and
 *  inferKeeperRoundConvention so a pasted URL behaves identically in both. */
function normalizeDraftId(draftId: string): string {
  const trimmed = String(draftId).trim();
  if (!trimmed.includes("/")) return encodeURIComponent(trimmed);
  const runs = trimmed.match(/\d+/g);
  return runs ? runs.reduce((a, b) => (b.length > a.length ? b : a)) : "";
}

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
  // total_rosters is authoritative; settings.num_teams is the fallback. Guard
  // a literal 0 (or any non-positive count), not just null/undefined — a team
  // count of 0 divides into Infinity round numbers downstream (same guard as
  // fetchLeagueKeepers).
  const rawTeams = raw.total_rosters ?? raw.settings?.num_teams;
  return {
    league_id: raw.league_id,
    name: raw.name,
    total_rosters: rawTeams && rawTeams > 0 ? rawTeams : 12,
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
    // Unlike the other stats above, `rec` and `bonus_rec_te` deliberately do NOT
    // fall back to the current config if the league doesn't set them. Sleeper
    // omits `rec` entirely for standard (non-PPR) leagues rather than sending 0 —
    // so "absent" means "this league doesn't award reception points," and
    // falling back to whatever PPR/half-PPR value happens to be in `fallback`
    // would silently misprice every WR/RB (e.g. import a standard league while
    // a PPR config is active → everyone keeps getting PPR points). Defaulting
    // to 0 here is the only value that's correct for every league type.
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

interface RawDraftForKeepers {
  league_id?: string;
  settings?: { teams?: number };
  // Keys are draft-slot strings ("1".."teams"), values are roster ids —
  // same shape MockDraft's traded-pick parsing inverts (handleImport).
  slot_to_roster_id?: Record<string, number> | null;
}

interface RawDraftPick {
  pick_no: number;
  draft_slot: number;
  player_id: string | null;
  is_keeper: true | null;
}

interface RawLeagueRosterForKeepers {
  roster_id: number;
  keepers: string[] | null;
}

/**
 * A keeper resolved from a league, before it's turned into a mock-draft
 * pending keeper. `teamSlot`/`round` are nullable because one of the two
 * source mechanisms (see fetchLeagueKeepers) can't supply them.
 */
export interface LeagueKeeper {
  playerId: string;
  /** Draft slot 1..teams, or null when the roster→slot mapping is unavailable. */
  teamSlot: number | null;
  /** Round from the draft board, or null when Sleeper did not supply one. */
  round: number | null;
}

export interface LeagueKeeperResult {
  keepers: LeagueKeeper[];
  /** Which mechanism supplied the data — drives the UI message. */
  source: "board" | "rosters";
}

/**
 * Sleeper exposes pre-draft keepers through two different, mutually
 * exclusive mechanisms:
 *
 *  1. The draft board (`/draft/<id>/picks`, entries with `is_keeper ===
 *     true`). Once Sleeper has materialized keepers onto the board, each
 *     keeper pick carries both `pick_no` (→ round) and `draft_slot` (→
 *     team), because it's a real slot in the snake order. This is strictly
 *     richer than the rosters mechanism below, so it wins outright whenever
 *     it has anything to say.
 *  2. League rosters (`/league/<id>/rosters`, each roster's `keepers`
 *     array). Available as soon as managers designate keepers — well before
 *     the board exists — but a roster only records *which players* are
 *     kept, never what round they cost. The round is a per-league keeper
 *     rule Sleeper doesn't model, so it has to come from the user by hand.
 *
 * The two mechanisms key players differently (draft slot vs. roster id), so
 * resolving a roster's owner to a draft slot requires inverting the draft's
 * `slot_to_roster_id` map.
 */
export async function fetchLeagueKeepers(draftId: string): Promise<LeagueKeeperResult> {
  // draftId is user-typed and may be pasted as a full Sleeper URL rather
  // than a bare id. See normalizeDraftId for the extraction rule; this
  // avoids a malformed request (a stray `/` corrupting the fetch URL)
  // turning into a confusing generic error.
  const id = normalizeDraftId(draftId);
  const draftRes = await fetch(`${BASE_URL}/draft/${id}`, {
    headers: { accept: "application/json" },
  });
  if (!draftRes.ok) throw new Error(`Draft not found (${draftRes.status})`);
  const draft: RawDraftForKeepers = await draftRes.json();
  // Guard a literal 0 (or any non-positive value), not just null/undefined: a
  // team count of 0 would divide into Infinity round numbers downstream.
  const rawTeams = draft.settings?.teams;
  const teams = rawTeams && rawTeams > 0 ? rawTeams : 12;

  // Board first: is_keeper picks carry a real round, so when any exist the
  // rosters endpoint is never even consulted (see doc comment above).
  let picks: RawDraftPick[] = [];
  try {
    const picksRes = await fetch(`${BASE_URL}/draft/${id}/picks`, {
      headers: { accept: "application/json" },
    });
    if (picksRes.ok) {
      const data = await picksRes.json();
      if (Array.isArray(data)) picks = data;
    }
  } catch { /* non-critical -- fall through to the rosters mechanism */ }

  const boardKeepers = picks.filter((p) => p.is_keeper === true);
  if (boardKeepers.length > 0) {
    const seen = new Set<string>();
    const keepers: LeagueKeeper[] = [];
    for (const p of boardKeepers) {
      if (!p.player_id || seen.has(p.player_id)) continue;
      seen.add(p.player_id);
      keepers.push({
        playerId: p.player_id,
        teamSlot: p.draft_slot,
        round: Math.ceil(p.pick_no / teams),
      });
    }
    return { keepers, source: "board" };
  }

  // Rosters mechanism: no round is ever available here, so it's left null
  // for every keeper — the caller (MockDraft) treats that as "unconfirmed"
  // and makes the user set one before the draft can start.
  if (!draft.league_id) return { keepers: [], source: "rosters" };

  let rosters: RawLeagueRosterForKeepers[] = [];
  try {
    const rostersRes = await fetch(`${BASE_URL}/league/${draft.league_id}/rosters`, {
      headers: { accept: "application/json" },
    });
    if (rostersRes.ok) {
      const data = await rostersRes.json();
      if (Array.isArray(data)) rosters = data;
    }
  } catch { /* non-critical -- returns whatever we have (possibly nothing) */ }

  const rosterToSlot = new Map<number, number>();
  if (draft.slot_to_roster_id) {
    for (const [slotStr, rosterId] of Object.entries(draft.slot_to_roster_id)) {
      rosterToSlot.set(rosterId, Number(slotStr));
    }
  }

  const seen = new Set<string>();
  const keepers: LeagueKeeper[] = [];
  for (const roster of rosters) {
    for (const playerId of roster.keepers ?? []) {
      if (!playerId || seen.has(playerId)) continue;
      seen.add(playerId);
      keepers.push({ playerId, teamSlot: rosterToSlot.get(roster.roster_id) ?? null, round: null });
    }
  }
  return { keepers, source: "rosters" };
}

export interface KeeperRoundConvention {
  /** Rounds in the CURRENT draft that keepers occupy, ascending. */
  rounds: number[];
  /** League id the convention was read from (the previous season's league). */
  sourceLeagueId: string;
  /** The season string of that league, for the UI message. May be "" if the
   *  season lookup itself failed — non-fatal, see step 3 below. */
  sourceSeason: string;
  /** The rounds keepers occupied in that prior draft, ascending. */
  priorRounds: number[];
}

interface RawDraftForConvention {
  league_id?: string;
  settings?: { rounds?: number };
}

interface RawLeagueForConvention {
  previous_league_id?: string | null;
  season?: string;
}

interface RawDraftListEntry {
  draft_id: string;
  type?: string;
  sport?: string;
}

interface RawPickForConvention {
  round: number;
  is_keeper: boolean | null;
}

/**
 * Infers a league's keeper-round convention — "keepers always occupy the
 * last N rounds of the draft" — from that league's own draft history, and
 * maps it onto the current draft. Used by MockDraft to fill in the round for
 * keepers that came from the rosters mechanism (see fetchLeagueKeepers
 * above), which never carries one.
 *
 * ## Why this exists
 *
 * A roster-mechanism keeper records *which* player is kept, never what
 * round they cost — that cost is a per-league house rule Sleeper doesn't
 * model at all. Left alone, every such keeper lands at a placeholder round
 * and blocks Start Draft until the user fixes each one by hand.
 *
 * Many keeper leagues use the simplest possible rule: keepers always cost
 * the last N rounds of the draft — e.g. rounds 13 and 14 of a 14-round
 * draft, every year, regardless of who's kept. When that pattern holds,
 * this function reads it straight off last season's draft and reapplies it
 * to the current season's draft length. Verified against a real 12-team,
 * 14-round league whose 2025 keepers occupied EXACTLY rounds 13 and 14 (12
 * keepers apiece, round 12 completely untouched) — the convention this
 * function looks for.
 *
 * ## What it deliberately does NOT do
 *
 * It does not try to recover which specific round any individual keeper
 * cost (there's no reliable within-team ordering signal — see
 * assignKeeperRounds in lib/draft.ts for why), and it does not attempt to
 * recognize any OTHER convention, such as "a keeper costs the round it was
 * drafted in the year before." That's a real rule some leagues use, but
 * nothing in Sleeper's data reliably distinguishes it from noise here, and
 * asserting a specific round on a wrong guess is worse than leaving the
 * keeper unconfirmed for the user. If the prior draft's keeper rounds don't
 * form a clean trailing block, this returns null — exactly as if no
 * convention existed — and the caller falls back to manual entry.
 *
 * ## Algorithm
 *
 * 1. Fetch the current draft for its `league_id` and `settings.rounds`
 *    (`currentRounds`). Null if either is missing.
 * 2. Fetch that league for `previous_league_id`. Null if absent — a league
 *    with no recorded predecessor has no history to read a convention from.
 * 3. Fetch the previous league for its `season`, used only for the UI
 *    message. Non-fatal: falls back to `""` on failure.
 * 4. Fetch the previous league's drafts and pick the snake/nfl one (or the
 *    first entry, if none match) as the source of evidence. Null if there
 *    are none.
 * 5. Fetch every pick of that prior draft.
 * 6. `priorTotalRounds` = the max `round` across all picks. The keeper
 *    rounds are the distinct `round` values carrying at least one
 *    `is_keeper === true` pick (N of them, ascending). Null if there are
 *    none.
 * 7. Validate the convention is really "the last N rounds": the keeper
 *    rounds must equal the exact contiguous block
 *    `[priorTotalRounds - N + 1 .. priorTotalRounds]`, no gaps and nothing
 *    outside it. A league that instead charges "the round the player went
 *    in last year" scatters keepers throughout the draft and correctly
 *    fails this check.
 * 8. Require each of those rounds to be *predominantly* keepers — at least
 *    80% of the picks in the round. Without this, a coincidence (a couple
 *    of ordinary late keepers landing in the final rounds of a league that
 *    doesn't actually use this convention) could pass step 7 by accident.
 * 9. Map N onto the CURRENT draft: the convention becomes that draft's own
 *    last N rounds, `[currentRounds - N + 1 .. currentRounds]`. Null if
 *    `currentRounds < N` — nowhere to put them.
 *
 * Every fetch degrades to `null` on failure or an unexpected shape rather
 * than throwing — this is a best-effort enhancement layered on a working
 * manual-entry flow, never a reason the keeper import itself should fail.
 */
export async function inferKeeperRoundConvention(
  draftId: string
): Promise<KeeperRoundConvention | null> {
  let currentRounds: number;
  let leagueId: string;
  const id = normalizeDraftId(draftId);
  try {
    const draft: RawDraftForConvention = await sleepFetch(`${BASE_URL}/draft/${id}`);
    if (!draft.league_id || !draft.settings?.rounds) return null;
    leagueId = draft.league_id;
    currentRounds = draft.settings.rounds;
  } catch {
    return null;
  }

  let previousLeagueId: string;
  try {
    const league: RawLeagueForConvention = await sleepFetch(`${BASE_URL}/league/${leagueId}`);
    if (!league.previous_league_id) return null;
    previousLeagueId = league.previous_league_id;
  } catch {
    return null;
  }

  let sourceSeason = "";
  try {
    const priorLeague: RawLeagueForConvention = await sleepFetch(`${BASE_URL}/league/${previousLeagueId}`);
    sourceSeason = priorLeague.season ?? "";
  } catch {
    // Non-fatal -- the UI message just omits the season if this fails.
  }

  let priorDraftId: string;
  try {
    const drafts: RawDraftListEntry[] = await sleepFetch(`${BASE_URL}/league/${previousLeagueId}/drafts`);
    if (!Array.isArray(drafts) || drafts.length === 0) return null;
    const snake = drafts.find((d) => d.type === "snake" && d.sport === "nfl");
    const chosen = snake ?? drafts[0];
    if (!chosen?.draft_id) return null;
    priorDraftId = chosen.draft_id;
  } catch {
    return null;
  }

  let picks: RawPickForConvention[];
  try {
    const data = await sleepFetch(`${BASE_URL}/draft/${priorDraftId}/picks`);
    if (!Array.isArray(data) || data.length === 0) return null;
    picks = data;
  } catch {
    return null;
  }

  const priorTotalRounds = picks.reduce((max, p) => Math.max(max, p.round), 0);
  if (priorTotalRounds <= 0) return null;

  const keeperRoundSet = new Set<number>();
  for (const p of picks) if (p.is_keeper === true) keeperRoundSet.add(p.round);
  if (keeperRoundSet.size === 0) return null;

  const priorRounds = [...keeperRoundSet].sort((a, b) => a - b);
  const n = priorRounds.length;

  // Must be exactly the trailing block [priorTotalRounds - n + 1 .. priorTotalRounds].
  const expectedStart = priorTotalRounds - n + 1;
  for (let i = 0; i < n; i++) {
    if (priorRounds[i] !== expectedStart + i) return null;
  }

  // Each keeper round must be predominantly keepers, not merely contain one
  // -- guards against a coincidence rather than a real convention.
  for (const round of priorRounds) {
    const picksInRound = picks.filter((p) => p.round === round);
    const keeperCount = picksInRound.filter((p) => p.is_keeper === true).length;
    if (picksInRound.length === 0 || keeperCount / picksInRound.length < 0.8) return null;
  }

  if (currentRounds < n) return null;

  const rounds = Array.from({ length: n }, (_, i) => currentRounds - n + 1 + i);

  return { rounds, sourceLeagueId: previousLeagueId, sourceSeason, priorRounds };
}
