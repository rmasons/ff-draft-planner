import type { Player } from "./types";

// Moved here verbatim from components/DraftBoard.tsx so it can be shared
// without components importing from each other. DraftBoard and PlayerCompare
// still have their own local copies for now (PlayerCompare's differs slightly
// — Questionable is +2 there) and will switch to importing this one in a
// later phase.
export function riskScore(p: Player): number {
  let score = 1;
  if (p.injuryStatus === "IR" || p.injuryStatus === "PUP") score += 7;
  else if (p.injuryStatus === "Out") score += 5;
  else if (p.injuryStatus === "Doubtful") score += 4;
  // Questionable is weighted light: this is a pre-draft tool used mostly in
  // the summer, when "Questionable" tags are largely stale offseason noise
  // (leftover from limited practice participation, etc.) rather than a real
  // week-to-week game-status signal — full weight here overstates the risk.
  else if (p.injuryStatus === "Questionable") score += 1;
  if (p.injuryNotes?.includes("Surgery")) score += 2;
  if (p.yearsExp === 0) score += 1;
  if (p.yearsExp !== null && p.yearsExp >= 10) score += 1;
  return Math.min(score, 10);
}
