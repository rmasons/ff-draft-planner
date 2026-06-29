// 2026 team bye weeks. Sleeper's projection feed doesn't include byes, so this
// is a small static map. TODO: fill in once the 2026 NFL schedule is finalized
// (left empty rather than guessing — wrong bye data is worse than none).
export const BYE_WEEKS_2026: Record<string, number> = {
  // Example shape: ARI: 8, ATL: 5, ...
};

export function byeFor(team: string | null): number | null {
  if (!team) return null;
  return BYE_WEEKS_2026[team] ?? null;
}
