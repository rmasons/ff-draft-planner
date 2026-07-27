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
  /** One-based rank of the first undrafted replacement player. */
  rank: number;
  /** Projected points of the replacement-level player. */
  points: number;
}
export type Baselines = Record<Position, Baseline>;

export interface RankingResult {
  players: RankedPlayer[];
  baselines: Baselines;
  method: BaselineMethod;
  /** True when baselines were recomputed against the live board. */
  dynamic: boolean;
}

/**
 * A draft in progress, for dynamic replacement levels.
 *
 * Static baselines answer "who is replacement level in this league?" — a
 * preseason property of the player pool. Once a draft starts, the question
 * that actually matters is "who is replacement level from here?", and the
 * answer moves: a run on running backs both drains the pool and satisfies the
 * league's demand for them, and those two effects do not cancel out.
 */
export interface LiveDraftState {
  /** Player ids already off the board. */
  drafted: ReadonlySet<string>;
  /**
   * Every roster slot still unfilled across the whole league, as a flat list
   * of Sleeper slot-type names (e.g. ["RB", "WR", "FLEX", "BN", ...]). Bench
   * slots matter to VORP and are ignored by VOLS, exactly as the configured
   * bench count is in the static case.
   */
  openSlots: string[];
}

const FLEXIBLE_SLOT_POOL: Record<string, SkillPosition[]> = {
  // Most restrictive first — the order these are allocated in.
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  FLEX: FLEX_POS,
  SUPER_FLEX: SKILL_POS_ALL,
};
const FLEXIBLE_SLOT_ORDER = ["WRRB_FLEX", "REC_FLEX", "FLEX", "SUPER_FLEX"];

/** How many starters each position supplies, and how many bench slots exist. */
interface SlotDemand {
  dedicated: Record<Position, number>;
  /** Flexible slots to allocate, most restrictive first. */
  flexible: string[];
  bench: number;
}

/** League-wide demand implied by the configured roster — the static case. */
function configuredDemand(roster: RosterConfig): SlotDemand {
  const t = roster.teams;
  const repeat = (slot: string, count: number) => Array.from({ length: Math.max(0, count) }, () => slot);
  return {
    dedicated: { QB: roster.qb * t, RB: roster.rb * t, WR: roster.wr * t, TE: roster.te * t, K: t, DEF: t },
    flexible: [...repeat("FLEX", roster.flex * t), ...repeat("SUPER_FLEX", roster.superflex * t)],
    bench: roster.bench * t,
  };
}

/** League-wide demand still unmet, read off the live board — the dynamic case. */
function remainingDemand(openSlots: string[]): SlotDemand {
  const dedicated: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  const flexible: string[] = [];
  let bench = 0;
  for (const slot of openSlots) {
    if (slot === "BN") bench++;
    else if (slot in FLEXIBLE_SLOT_POOL) flexible.push(slot);
    else if (slot in dedicated) dedicated[slot as Position]++;
  }
  flexible.sort((a, b) => FLEXIBLE_SLOT_ORDER.indexOf(a) - FLEXIBLE_SLOT_ORDER.indexOf(b));
  return { dedicated, flexible, bench };
}

/**
 * Replacement level per skill position via greedy slot assignment.
 *
 * Starters first: dedicated slots, then the flexible slots most-restrictive
 * first, each handed to the best remaining player by projected points. This is
 * what makes flex/superflex VOR correct — positions that feed flex get more
 * starters drafted, so their baseline sits deeper.
 *
 * For VORP we then fill the bench slots too, but prioritized by
 * value-over-last-starter (not raw points) so we don't over-draft high-scoring
 * QBs to the bench in 1-QB leagues.
 *
 * `pointsByPos` is the pool the demand is measured against: every player
 * preseason, or only the undrafted ones mid-draft.
 */
function allocateStarters(
  pointsByPos: Record<SkillPosition, number[]>, // each sorted desc
  demand: SlotDemand,
  method: BaselineMethod
): Record<SkillPosition, number> {
  const started: Record<SkillPosition, number> = {
    QB: demand.dedicated.QB,
    RB: demand.dedicated.RB,
    WR: demand.dedicated.WR,
    TE: demand.dedicated.TE,
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

  // Flexible starters, by raw projected points of each position's next player.
  for (const slot of demand.flexible) {
    fill(1, FLEXIBLE_SLOT_POOL[slot], (pos) => ptsAt(pos, started[pos]));
  }

  if (method === "VORP") {
    // Value-over-last-starter of each position's next available player.
    const volsBase: Record<SkillPosition, number> = {
      QB: ptsAt("QB", started.QB),
      RB: ptsAt("RB", started.RB),
      WR: ptsAt("WR", started.WR),
      TE: ptsAt("TE", started.TE),
    };
    // Bench picks prioritized by VOR, not raw points.
    fill(demand.bench, SKILL_POS_ALL, (pos) => ptsAt(pos, started[pos]) - volsBase[pos]);
  }

  return started;
}

/**
 * Read the replacement player off a position's pool.
 *
 * `pool` is the position sorted best-first, carrying each player's index in
 * the full (including drafted) list so the reported `rank` stays a real
 * positional rank — the board draws its replacement divider at that rank, and
 * a rank counted only over survivors would drift as players come off.
 */
function baselineFrom(
  pool: { fullIndex: number; points: number }[],
  full: { points: number }[],
  demand: number
): Baseline {
  if (full.length === 0) return { rank: 0, points: 0 };
  // Every player at the position is gone: the worst one who existed is the
  // best anyone could still have had.
  if (pool.length === 0) return { rank: full.length, points: full[full.length - 1].points };
  const entry = pool[Math.min(demand, pool.length - 1)];
  return { rank: entry.fullIndex + 1, points: entry.points };
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
 *
 * Pass `live` to measure replacement against the board as it stands rather
 * than against the preseason pool. Drafted players are still ranked and
 * returned — only the baselines they are measured against change.
 */
export function rankPlayers(
  players: Player[],
  scoring: ScoringConfig,
  roster: RosterConfig,
  method: BaselineMethod = "VOLS",
  live?: LiveDraftState
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

  // The pool demand is measured against: everyone, or only who's left.
  const availableByPos = {} as Record<Position, { fullIndex: number; points: number }[]>;
  for (const pos of ALL_POSITIONS) {
    availableByPos[pos] = byPos[pos].flatMap((x, i) =>
      live && live.drafted.has(x.player.id) ? [] : [{ fullIndex: i, points: x.points }]
    );
  }

  const demand = live ? remainingDemand(live.openSlots) : configuredDemand(roster);
  const started = allocateStarters(
    {
      QB: availableByPos.QB.map((x) => x.points),
      RB: availableByPos.RB.map((x) => x.points),
      WR: availableByPos.WR.map((x) => x.points),
      TE: availableByPos.TE.map((x) => x.points),
    },
    demand,
    method
  );

  const baselines = {} as Baselines;
  for (const pos of POSITIONS) {
    baselines[pos] = baselineFrom(availableByPos[pos], byPos[pos], started[pos]);
  }
  // K/DEF: one starter per team, or however many of those slots are still open.
  for (const pos of ["K", "DEF"] as const) {
    baselines[pos] = baselineFrom(availableByPos[pos], byPos[pos], demand.dedicated[pos]);
  }

  const pointsByPos: Record<SkillPosition, number[]> = {
    QB: byPos.QB.map((x) => x.points),
    RB: byPos.RB.map((x) => x.points),
    WR: byPos.WR.map((x) => x.points),
    TE: byPos.TE.map((x) => x.points),
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

  return { players: ranked, baselines, method, dynamic: live !== undefined };
}
