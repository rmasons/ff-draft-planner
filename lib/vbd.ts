import type {
  Player,
  Position,
  RankedPlayer,
  RosterConfig,
  ScoringConfig,
} from "./types";
import { POSITIONS } from "./types";
import { fantasyPoints } from "./scoring";

const FLEX_POS: Position[] = ["RB", "WR", "TE"];
const ALL_POS: Position[] = ["QB", "RB", "WR", "TE"];

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
 * Replacement level per position via greedy slot assignment.
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
function computeBaselines(
  pointsByPos: Record<Position, number[]>, // each sorted desc
  roster: RosterConfig,
  method: BaselineMethod
): Baselines {
  const t = roster.teams;
  const started: Record<Position, number> = {
    QB: roster.qb * t,
    RB: roster.rb * t,
    WR: roster.wr * t,
    TE: roster.te * t,
  };

  const ptsAt = (pos: Position, i: number) =>
    i < pointsByPos[pos].length ? pointsByPos[pos][i] : -Infinity;

  const fill = (slots: number, pool: Position[], value: (pos: Position) => number) => {
    for (let i = 0; i < slots; i++) {
      let best: Position | null = null;
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
  fill(roster.superflex * t, ALL_POS, (pos) => ptsAt(pos, started[pos]));

  if (method === "VORP") {
    // Value-over-last-starter of each position's next available player.
    const volsBase: Record<Position, number> = {
      QB: ptsAt("QB", started.QB),
      RB: ptsAt("RB", started.RB),
      WR: ptsAt("WR", started.WR),
      TE: ptsAt("TE", started.TE),
    };
    // Bench picks prioritized by VOR, not raw points.
    fill(
      roster.bench * t,
      ALL_POS,
      (pos) => ptsAt(pos, started[pos]) - volsBase[pos]
    );
  }

  const baselines = {} as Baselines;
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
    QB: [],
    RB: [],
    WR: [],
    TE: [],
  };
  for (const wp of withPoints) byPos[wp.player.position].push(wp);
  for (const pos of POSITIONS) byPos[pos].sort((a, b) => b.points - a.points);

  const pointsByPos: Record<Position, number[]> = {
    QB: byPos.QB.map((x) => x.points),
    RB: byPos.RB.map((x) => x.points),
    WR: byPos.WR.map((x) => x.points),
    TE: byPos.TE.map((x) => x.points),
  };

  const baselines = computeBaselines(pointsByPos, roster, method);

  const ranked: RankedPlayer[] = [];
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

  ranked.sort((a, b) => b.vbd - a.vbd);
  ranked.forEach((p, i) => (p.overallRank = i + 1));

  return { players: ranked, baselines, method };
}
