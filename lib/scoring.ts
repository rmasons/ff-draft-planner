import type { Player, ScoringConfig } from "./types";

/** Projected fantasy points for a player under a given scoring config.
 * Computed from raw stat projections so any scoring system works. */
export function fantasyPoints(p: Player, s: ScoringConfig): number {
  const st = p.stats;
  let pts = 0;

  pts += (st.pass_yd ?? 0) * s.passYd;
  pts += (st.pass_td ?? 0) * s.passTd;
  pts += (st.pass_int ?? 0) * s.passInt;

  pts += (st.rush_yd ?? 0) * s.rushYd;
  pts += (st.rush_td ?? 0) * s.rushTd;

  pts += (st.rec_yd ?? 0) * s.recYd;
  pts += (st.rec_td ?? 0) * s.recTd;
  pts += (st.rec ?? 0) * s.rec;

  // TE premium: extra points per reception for tight ends.
  if (p.position === "TE") pts += (st.rec ?? 0) * s.teRecBonus;

  pts += (st.fum_lost ?? 0) * s.fumLost;

  const twoPt = (st.pass_2pt ?? 0) + (st.rush_2pt ?? 0) + (st.rec_2pt ?? 0);
  pts += twoPt * s.twoPt;

  return Math.round(pts * 10) / 10;
}
