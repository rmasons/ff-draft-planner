// 2026 team bye weeks. Sleeper's projection feed doesn't include byes, so this
// is a small static map. Source: https://fantasyfootballcalculator.com/nfl-bye-weeks
// (2026 NFL schedule — all 32 teams, verified against Sleeper team abbreviations).
export const BYE_WEEKS_2026: Record<string, number> = {
  // Week 5
  KC: 5,
  CAR: 5,
  // Week 6
  MIA: 6,
  CIN: 6,
  DET: 6,
  MIN: 6,
  // Week 7
  BUF: 7,
  LAC: 7,
  WAS: 7,
  JAX: 7,
  // Week 8
  NYG: 8,
  NO: 8,
  SF: 8,
  HOU: 8,
  // Week 9
  TEN: 9,
  PIT: 9,
  // Week 10
  DEN: 10,
  PHI: 10,
  CHI: 10,
  TB: 10,
  // Week 11
  NE: 11,
  CLE: 11,
  SEA: 11,
  GB: 11,
  ATL: 11,
  LAR: 11,
  // Week 13
  IND: 13,
  NYJ: 13,
  LV: 13,
  BAL: 13,
  // Week 14
  DAL: 14,
  ARI: 14,
};

export function byeFor(team: string | null): number | null {
  if (!team) return null;
  return BYE_WEEKS_2026[team] ?? null;
}
