import { SEASON } from "./sleeper";
import type { Position } from "./types";
import { ALL_POSITIONS } from "./types";

const ESPN_URL =
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}` +
  `/players?scoringPeriodId=0&view=kona_player_info`;

// Fetch top 1000 players by PPR ADP — covers our full skill-position board.
const ESPN_FILTER = JSON.stringify({
  players: {
    limit: 1000,
    sortDraftRanks: { sortPriority: 100, sortAsc: true, value: "PPR" },
    filterRanksForScoringPeriodIds: { value: [0] },
    filterRanksForRankTypes: { value: ["PPR"] },
  },
});

interface EspnPlayer {
  id: number;
  fullName: string;
  defaultPositionId?: number;
  ownership?: { averageDraftPosition?: number };
}

// ESPN's `defaultPositionId` → our Position. Confirmed against a live sample
// of the kona_player_info payload: 1=QB, 2=RB, 3=WR, 4=TE, 5=K, 16=D/ST.
// IDs outside this map (IDL/LB/DB/etc., used for real-defense IDP payloads
// we don't fetch, plus various non-fantasy slots) are intentionally dropped —
// we have no Position to key on for them, so they can't be safely joined.
const ESPN_POSITION_ID: Record<number, Position> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "DEF",
};

// Generational suffixes to strip from the END of a name only, so a Sleeper
// name like "Marvin Harrison" matches ESPN's "Marvin Harrison Jr." (otherwise
// they're treated as two different players and the ESPN ADP silently never
// gets attached). Ordered longest-first in the alternation so "iii" isn't
// half-consumed by the "ii" branch first.
//
// Test-by-hand examples (after the earlier normalization steps have already
// lowercased + stripped punctuation, so "Jr." has become "jr"):
//   "marvin harrison jr"   -> "marvin harrison"
//   "michael pittman iii"  -> "michael pittman"
//   "odell beckham jr"     -> "odell beckham"
//   "amari cooper"         -> "amari cooper"      (no suffix, untouched)
//   "oliver"               -> "oliver"            (contains "iv" but not as its own
//                                                   trailing word, so untouched)
const SUFFIX_RE = / (iii|ii|iv|v|jr|sr)$/;

/** Normalize to lowercase ASCII letters + spaces for fuzzy name matching. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accent marks
    .replace(/[^a-z ]/g, "")         // strip punctuation, apostrophes, dots
    .replace(/\s+/g, " ")
    .trim()
    .replace(SUFFIX_RE, ""); // strip trailing generational suffix, e.g. "... jr"
}

/**
 * Join key for matching a Sleeper player to an ESPN ADP entry: name alone is
 * not enough (the NFL has real duplicate names across positions/teams, e.g.
 * more than one "Josh Allen"), so we key on normalized name + position.
 */
export function espnAdpKey(name: string, position: Position | string): string {
  return `${normalizeName(name)}:${position}`;
}

export interface EspnAdpMap {
  /** key: `espnAdpKey(fullName, position)` -> ESPN PPR ADP. */
  byNameAndPosition: Map<string, number>;
  /**
   * Count of name+position collisions (two different ESPN players sharing
   * the same normalized name AND the same position). We drop ADP for those
   * keys entirely rather than guess — no ADP is better than a wrong one
   * silently attached to the wrong star player.
   */
  ambiguousCount: number;
}

async function fetchEspnAdpOnce(): Promise<EspnAdpMap> {
  const res = await fetch(ESPN_URL, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "x-fantasy-filter": ESPN_FILTER,
    },
  });
  if (!res.ok) throw new Error(`ESPN API ${res.status} ${res.statusText}`);

  const players: EspnPlayer[] = await res.json();
  const byNameAndPosition = new Map<string, number>();
  const seenKeys = new Set<string>();
  const ambiguousKeys = new Set<string>();

  for (const p of players) {
    const adp = p.ownership?.averageDraftPosition;
    if (!adp || adp <= 0 || adp >= 999) continue;

    const position =
      p.defaultPositionId !== undefined
        ? ESPN_POSITION_ID[p.defaultPositionId]
        : undefined;
    if (!position || !(ALL_POSITIONS as string[]).includes(position)) continue;

    const key = espnAdpKey(p.fullName, position);
    if (seenKeys.has(key)) {
      // Second (or later) sighting of this exact name+position combo: it's
      // genuinely ambiguous which player the ADP belongs to.
      ambiguousKeys.add(key);
      continue;
    }
    seenKeys.add(key);
    byNameAndPosition.set(key, adp);
  }

  // Drop any key that turned out ambiguous, even though we already stored a
  // (possibly correct, possibly wrong) value for its first sighting.
  for (const key of ambiguousKeys) byNameAndPosition.delete(key);

  return { byNameAndPosition, ambiguousCount: ambiguousKeys.size };
}

/**
 * Returns ESPN PPR ADP keyed by normalized name + position (see
 * `espnAdpKey`). Retries once on failure; if the retry also fails the
 * rejection propagates so the caller's own caching layer can decide whether
 * to keep serving last-known-good data (see app/api/players/route.ts).
 */
export async function fetchEspnAdp(): Promise<EspnAdpMap> {
  try {
    return await fetchEspnAdpOnce();
  } catch {
    return await fetchEspnAdpOnce();
  }
}
