import type { Player, RankedPlayer } from "./types";

/** Which Sleeper ADP column to use, matching a scoring/roster format.
 *  See `adpKeyFor` in lib/presets.ts for how this is derived. */
type AdpKey = "ppr" | "half" | "std" | "superflex";

/**
 * Consensus ADP for a player: the average of Sleeper's ADP (for the given
 * format) and ESPN's PPR ADP, ignoring either source when it's >= 999
 * (Sleeper/ESPN's sentinel for "no ADP data available" — the player isn't
 * being drafted in that format/site).
 *
 * Returns null when neither source has data (nothing to average).
 *
 * This is the same "filter >=999, average what's left" snippet that used to
 * be duplicated across DraftBoard/MockDraft/PlayerCompare — centralized here
 * so every screen computes consensus ADP the same way.
 */
export function consensusAdp(p: Player, adpKey: AdpKey): number | null {
  const sleeper = p.adp[adpKey] >= 999 ? null : p.adp[adpKey];
  const espn = p.adp.espn >= 999 ? null : p.adp.espn;
  const sources = [sleeper, espn].filter((x): x is number => x !== null);
  if (sources.length === 0) return null;
  return sources.reduce((a, b) => a + b, 0) / sources.length;
}

/**
 * "Value over ADP": how much later a player is going in your rankings than
 * where the market (consensus ADP) expects them to go. Positive = steal
 * (market drafts them later than your board), negative = reach.
 *
 * Returns null when consensus ADP is unavailable, OR when the player is a
 * K/DEF — their `overallRank` is forced to the bottom of the board by design
 * (see rankPlayers in lib/vbd.ts: K/DEF are appended after all skill
 * positions regardless of VBD), so ADP minus overallRank would be a huge,
 * meaningless negative number rather than a real value signal. This mirrors
 * the existing fix already applied to DraftBoard's "value" sort column.
 */
export function valueVsAdp(p: RankedPlayer, adpKey: AdpKey): number | null {
  if (p.position === "K" || p.position === "DEF") return null;
  const adp = consensusAdp(p, adpKey);
  if (adp === null) return null;
  return adp - p.overallRank;
}
