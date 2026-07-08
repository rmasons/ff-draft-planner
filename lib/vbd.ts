import type {
  Player,
  Position,
  SkillPosition,
  RankedPlayer,
  RosterConfig,
  ScoringConfig,
} from "./types";
import { POSITIONS, ALL_POSITIONS } from "./types";
import { fantasyPoints } from "./scoring";

const FLEX_POS: SkillPosition[] = ["RB", "WR", "TE"];
const SKILL_POS_ALL: SkillPosition[] = ["QB", "RB", "WR", "TE"];

/** Where VOR sets the "replacement" baseline.
 *  - VOLS: Value Over Last Starter — baseline = first player past all starters.
 *  - VORP: deeper — also accounts for teams rostering backups (bench depth). */
export type BaselineMethod = "VOLS" | "VORP";

export const BASELINE_LABELS: Record<BaselineMethod, string> = {
  VOLS: "Last starter",
  VORP: "Bench depth",
};

export interface Baseline {
  /** Number of players at this position rostered above the replacement line. */
  rank: number;
  /** Projected points of the replacement-level player. */
  points: number;
}
export type Baselines = Record<Position, Baseline>;

export interface RankingResult {
  players: RankedPlayer[];
  baselines: Baselines;
  method: BaselineMethod;
}

/**
 * Replacement level per skill position via greedy slot assignment.
 *
 * Starters first: dedicated slots, then FLEX (RB/WR/TE), then SUPERFLEX
 * (QB/RB/WR/TE), each handed to the best remaining player by projected points.
 * This is what makes flex/superflex VOR correct — positions that feed flex get
 * more starters drafted, so their baseline sits deeper.
 *
 * For VORP we then fill `bench × teams` more slots, but prioritized by
 * value-over-last-starter (not raw points) so we don't over-draft high-scoring
 * QBs to the bench in 1-QB leagues.
 */
function computeSkillBaselines(
  pointsByPos: Record<SkillPosition, number[]>, // each sorted desc
  roster: RosterConfig,
  method: BaselineMethod
): Record<SkillPosition, Baseline> {
  const t = roster.teams;
  const started: Record<SkillPosition, number> = {
    QB: roster.qb * t,
    RB: roster.rb * t,
    WR: roster.wr * t,
    TE: roster.te * t,
  };

  const ptsAt = (pos: SkillPosition, i: number) =>
    i < pointsByPos[pos].length ? pointsByPos[pos][i] : -Infinity;

  const fill = (slots: number, pool: SkillPosition[], value: (pos: SkillPosition) => number) => {
    for (let i = 0; i < slots; i++) {
      let best: SkillPosition | null = null;
      let bestV = -Infinity;
      for (const pos of pool) {
        const v = value(pos);
        if (v > bestV) {
          bestV = v;
          best = pos;
        }
      }
      if (best === null || bestV === -Infinity) break; // pool exhausted
      started[best]++;
    }
  };

  // Starters: flex then superflex, by raw projected points of the next player.
  fill(roster.flex * t, FLEX_POS, (pos) => ptsAt(pos, started[pos]));
  fill(roster.superflex * t, SKILL_POS_ALL, (pos) => ptsAt(pos, started[pos]));

  if (method === "VORP") {
    // Value-over-last-starter of each position's next available player.
    const volsBase: Record<SkillPosition, number> = {
      QB: ptsAt("QB", started.QB),
      RB: ptsAt("RB", started.RB),
      WR: ptsAt("WR", started.WR),
      TE: ptsAt("TE", started.TE),
    };
    // Bench picks prioritized by VOR, not raw points.
    fill(
      roster.bench * t,
      SKILL_POS_ALL,
      (pos) => ptsAt(pos, started[pos]) - volsBase[pos]
    );
  }

  const baselines = {} as Record<SkillPosition, Baseline>;
  for (const pos of POSITIONS) {
    const arr = pointsByPos[pos];
    const idx = started[pos];
    baselines[pos] = {
      rank: Math.min(idx, arr.length),
      points: arr.length === 0 ? 0 : (arr[idx] ?? arr[arr.length - 1] ?? 0),
    };
  }
  return baselines;
}

/**
 * Gap-based tiers within a position. A new tier starts when the drop to the
 * next player exceeds 1.5× the average gap among the position's relevant pool.
 */
function assignTiers(sortedPoints: number[]): number[] {
  const n = sortedPoints.length;
  if (n === 0) return [];
  const window = Math.min(n - 1, 40);
  let gapSum = 0;
  let gapCount = 0;
  for (let i = 0; i < window; i++) {
    gapSum += sortedPoints[i] - sortedPoints[i + 1];
    gapCount++;
  }
  const avgGap = gapCount > 0 ? gapSum / gapCount : 0;
  const threshold = avgGap * 1.5;

  const tiers: number[] = new Array(n);
  let tier = 1;
  tiers[0] = 1;
  for (let i = 1; i < n; i++) {
    const drop = sortedPoints[i - 1] - sortedPoints[i];
    if (threshold > 0 && drop > threshold) tier++;
    tiers[i] = tier;
  }
  return tiers;
}

/**
 * Rank all players: projected points, VOR, positional tiers, overall rank, and
 * the replacement baselines used. Pure function — safe to recompute on change.
 *
 * Overall rank order: skill positions (by VBD descending), then K, then DEF.
 * K/DEF are appended at the bottom regardless of VBD so draft advice stays
 * conventional — take skill positions before kickers and defenses.
 */
export function rankPlayers(
  players: Player[],
  scoring: ScoringConfig,
  roster: RosterConfig,
  method: BaselineMethod = "VOLS"
): RankingResult {
  const withPoints = players.map((p) => ({
    player: p,
    points: fantasyPoints(p, scoring),
  }));

  const byPos: Record<Position, { player: Player; points: number }[]> = {
    QB: [], RB: [], WR: [], TE: [], K: [], DEF: [],
  };
  for (const wp of withPoints) byPos[wp.player.position].push(wp);
  for (const pos of ALL_POSITIONS) byPos[pos].sort((a, b) => b.points - a.points);

  const pointsByPos: Record<SkillPosition, number[]> = {
    QB: byPos.QB.map((x) => x.points),
    RB: byPos.RB.map((x) => x.points),
    WR: byPos.WR.map((x) => x.points),
    TE: byPos.TE.map((x) => x.points),
  };

  const skillBaselines = computeSkillBaselines(pointsByPos, roster, method);

  // K/DEF baseline: 1 starter per team (simple, no greedy flex assignment).
  const kPoints = byPos.K.map((x) => x.points);
  const defPoints = byPos.DEF.map((x) => x.points);
  const baselines: Baselines = {
    ...skillBaselines,
    K: {
      rank: Math.min(roster.teams, kPoints.length),
      points: kPoints[roster.teams - 1] ?? kPoints[kPoints.length - 1] ?? 0,
    },
    DEF: {
      rank: Math.min(roster.teams, defPoints.length),
      points: defPoints[roster.teams - 1] ?? defPoints[defPoints.length - 1] ?? 0,
    },
  };

  const ranked: RankedPlayer[] = [];

  // Skill positions first, sorted by VBD later.
  for (const pos of POSITIONS) {
    const tiers = assignTiers(pointsByPos[pos]);
    byPos[pos].forEach((x, i) => {
      ranked.push({
        ...x.player,
        points: x.points,
        vbd: Math.round((x.points - baselines[pos].points) * 10) / 10,
        tier: tiers[i] ?? 1,
        posRank: i + 1,
        overallRank: 0,
      });
    });
  }

  // Sort skill players by VBD descending. Ties (equal VBD) are broken
  // deterministically by projected points desc, then name asc, so equal-VBD
  // players don't shuffle order across recomputes based on array insertion order.
  ranked.sort(
    (a, b) => b.vbd - a.vbd || b.points - a.points || a.name.localeCompare(b.name)
  );
  let rank = 1;
  for (const p of ranked) p.overallRank = rank++;

  // K and DEF appended after all skill positions (already sorted by points desc).
  for (const pos of ["K", "DEF"] as const) {
    const pts = byPos[pos].map((x) => x.points);
    const tiers = assignTiers(pts);
    byPos[pos].forEach((x, i) => {
      const rp: RankedPlayer = {
        ...x.player,
        points: x.points,
        vbd: Math.round((x.points - baselines[pos].points) * 10) / 10,
        tier: tiers[i] ?? 1,
        posRank: i + 1,
        overallRank: rank++,
      };
      ranked.push(rp);
    });
  }

  return { players: ranked, baselines, method };
}
