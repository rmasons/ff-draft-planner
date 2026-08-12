import { SEASON } from "./sleeper";

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
  ownership?: { averageDraftPosition?: number };
}

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

const TTL_MS = 12 * 60 * 60 * 1000; // 12h
let memo: { at: number; data: Map<string, number> } | null = null;

/**
 * Returns a map of normalized player name → ESPN PPR ADP.
 * Cached server-side for 12h; returns an empty map on any error so the
 * rest of the app degrades gracefully.
 */
export async function fetchEspnAdp(): Promise<Map<string, number>> {
  const now = Date.now();
  if (memo && now - memo.at < TTL_MS) return memo.data;

  const res = await fetch(ESPN_URL, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "x-fantasy-filter": ESPN_FILTER,
    },
  });
  if (!res.ok) throw new Error(`ESPN API ${res.status} ${res.statusText}`);

  const players: EspnPlayer[] = await res.json();
  const map = new Map<string, number>();
  for (const p of players) {
    const adp = p.ownership?.averageDraftPosition;
    if (adp && adp > 0 && adp < 999) {
      map.set(normalizeName(p.fullName), adp);
    }
  }
  memo = { at: now, data: map };
  return map;
}
