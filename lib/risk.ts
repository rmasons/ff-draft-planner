import type { Player } from "./types";

export interface RiskAssessment { score: number; confidence: "low" | "medium" | "high"; factors: string[] }

export function assessRisk(player: Player): RiskAssessment {
  let score = 1;
  const factors: string[] = [];
  // Weights are tuned for preseason DRAFT use. A "Questionable" tag in the
  // summer is usually precautionary/stale noise, so it counts as a minor flag
  // (+1, on par with rookie/late-career/ADP-disagreement below) rather than a
  // half-Doubtful (+2). Offseason surgery (below) is the opposite — a concrete
  // durability signal for the coming season — so it outweighs it. (These two
  // deliberately diverge from PlayerCompare's in-season-oriented copy; don't
  // "reconcile" them back without re-checking this draft-context rationale.)
  const availability: Record<string, [number, string]> = {
    IR: [7, "Injured reserve"], PUP: [7, "Physically unable to perform"], Out: [5, "Currently out"],
    Doubtful: [4, "Doubtful availability"], Questionable: [1, "Questionable availability"],
  };
  const status = player.injuryStatus ? availability[player.injuryStatus] : undefined;
  if (status) { score += status[0]; factors.push(status[1]); }
  // Offseason surgery bears directly on the upcoming season (recovery timeline,
  // re-injury risk), so it outweighs a precautionary preseason "Questionable".
  if (player.injuryNotes?.toLowerCase().includes("surgery")) { score += 2; factors.push("Recent surgery noted"); }
  if (player.yearsExp === 0) { score += 1; factors.push("Rookie role uncertainty"); }
  if (player.yearsExp !== null && player.yearsExp >= 10) { score += 1; factors.push("Late-career age/role uncertainty"); }
  if (player.adp.ppr < 999 && player.adp.espn < 999 && Math.abs(player.adp.ppr - player.adp.espn) >= 24) {
    score += 1;
    factors.push("Large projection-market disagreement");
  }
  if (!factors.length) factors.push("No supported risk flags in available data");
  const evidence = [player.injuryStatus, player.injuryBody, player.injuryNotes, player.yearsExp].filter((v) => v !== null).length;
  return { score: Math.min(10, score), confidence: evidence >= 3 ? "high" : evidence >= 1 ? "medium" : "low", factors };
}
