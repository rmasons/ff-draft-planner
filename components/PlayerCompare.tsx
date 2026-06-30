"use client";

import type { Player, Position, RankedPlayer } from "@/lib/types";

// ---------- helpers (not exported from DraftBoard — duplicated here) ----------

function riskScore(p: Player): number {
  let score = 1;
  if (p.injuryStatus === "IR" || p.injuryStatus === "PUP") score += 7;
  else if (p.injuryStatus === "Out") score += 5;
  else if (p.injuryStatus === "Doubtful") score += 4;
  else if (p.injuryStatus === "Questionable") score += 2;
  if (p.injuryNotes?.includes("Surgery")) score += 2;
  if (p.yearsExp === 0) score += 1;
  if (p.yearsExp !== null && p.yearsExp >= 10) score += 1;
  return Math.min(score, 10);
}

const POS_BADGE: Record<Position, string> = {
  QB:  "bg-rose-500/15 text-rose-300 border-rose-500/30",
  RB:  "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  WR:  "bg-sky-500/15 text-sky-300 border-sky-500/30",
  TE:  "bg-amber-500/15 text-amber-300 border-amber-500/30",
  K:   "bg-violet-500/15 text-violet-300 border-violet-500/30",
  DEF: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};

/** Consensus ADP (Sleeper PPR + ESPN avg) and value-over-ADP. */
function adpAndVal(p: RankedPlayer): { adp: number | null; val: number | null } {
  const sl = p.adp.ppr >= 999 ? null : p.adp.ppr;
  const es = p.adp.espn >= 999 ? null : p.adp.espn;
  const srcs = [sl, es].filter((x): x is number => x !== null);
  if (srcs.length === 0) return { adp: null, val: null };
  const adp = srcs.reduce((a, b) => a + b, 0) / srcs.length;
  return { adp, val: adp - p.overallRank };
}

/**
 * Returns the set of indices tied for best (max or min).
 * Returns an empty set when fewer than two non-null values exist — no
 * meaningful comparison, so we don't highlight anything.
 */
function bestIdx(values: (number | null)[], prefer: "max" | "min"): Set<number> {
  const defined = values
    .map((v, i) => (v !== null ? { v, i } : null))
    .filter((x): x is { v: number; i: number } => x !== null);
  if (defined.length < 2) return new Set();
  const extreme =
    prefer === "max"
      ? Math.max(...defined.map((x) => x.v))
      : Math.min(...defined.map((x) => x.v));
  return new Set(defined.filter((x) => x.v === extreme).map((x) => x.i));
}

// ---------- sub-components ----------

function StatRow({
  label,
  cells,
  highlight,
}: {
  label: string;
  cells: React.ReactNode[];
  highlight: Set<number>;
}) {
  return (
    <tr className="border-t border-zinc-800/60">
      <td className="px-3 py-2 text-xs font-medium text-zinc-500 whitespace-nowrap">{label}</td>
      {cells.map((cell, i) => (
        <td
          key={i}
          className={`px-3 py-2 text-center tabular-nums transition-colors ${
            highlight.has(i) ? "bg-emerald-500/10" : ""
          }`}
        >
          {cell}
        </td>
      ))}
    </tr>
  );
}

// ---------- main component ----------

export interface Props {
  players: RankedPlayer[];
  onClose: () => void;
  onRemove: (id: string) => void;
}

export default function PlayerCompare({ players, onClose, onRemove }: Props) {
  // Pre-compute derived stats once per player.
  const stats = players.map((p) => ({ risk: riskScore(p), ...adpAndVal(p) }));

  // Best-value index sets for each highlightable stat row.
  const bestProj   = bestIdx(players.map((p) => p.points),        "max");
  const bestActual = bestIdx(players.map((p) => p.actualPts2025), "max");
  const bestVor    = bestIdx(players.map((p) => p.vbd),           "max");
  const bestRank   = bestIdx(players.map((p) => p.overallRank),   "min");
  const bestVal    = bestIdx(stats.map((s) => s.val),             "max");
  const bestRisk   = bestIdx(stats.map((s) => s.risk),            "min");
  const noHighlight = new Set<number>();

  return (
    // Full-screen overlay — pointer-events-none on the backdrop so rows behind
    // remain clickable, letting the user keep adding players without closing first.
    <div className="fixed inset-0 z-50 flex items-end justify-center pb-6 pointer-events-none sm:items-center">
      <div
        className="
          relative w-full max-w-2xl mx-4 rounded-xl border border-zinc-700
          bg-zinc-900 shadow-2xl pointer-events-auto overflow-hidden
        "
      >
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
            Compare Players
          </span>
          <button
            onClick={onClose}
            aria-label="Close comparison"
            className="text-xl font-light leading-none text-zinc-500 transition hover:text-zinc-200"
          >
            ×
          </button>
        </div>

        {/* Scrollable table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            {/* Player header columns */}
            <thead>
              <tr className="bg-zinc-900">
                <th className="w-28 px-3 py-3" />
                {players.map((p) => (
                  <th key={p.id} className="px-3 py-3 text-center min-w-[120px]">
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-1">
                        <span className="font-semibold text-zinc-100">{p.name}</span>
                        <button
                          onClick={() => onRemove(p.id)}
                          aria-label={`Remove ${p.name} from comparison`}
                          className="ml-0.5 text-sm leading-none text-zinc-600 transition hover:text-rose-400"
                        >
                          ×
                        </button>
                      </div>
                      <span className="text-xs text-zinc-500">{p.team ?? "FA"}</span>
                      <span
                        className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold ${POS_BADGE[p.position]}`}
                      >
                        {p.position}
                      </span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {/* Proj */}
              <StatRow
                label="Proj"
                highlight={bestProj}
                cells={players.map((p) => (
                  <span className="text-zinc-200">{p.points.toFixed(1)}</span>
                ))}
              />

              {/* 2025 Actual */}
              <StatRow
                label="2025 Actual"
                highlight={bestActual}
                cells={players.map((p) =>
                  p.actualPts2025 != null ? (
                    <span className="text-zinc-400">{p.actualPts2025.toFixed(1)}</span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )
                )}
              />

              {/* VOR */}
              <StatRow
                label="VOR"
                highlight={bestVor}
                cells={players.map((p) => (
                  <span className={`font-medium ${p.vbd > 0 ? "text-emerald-400" : "text-zinc-500"}`}>
                    {p.vbd > 0 ? "+" : ""}
                    {p.vbd.toFixed(1)}
                  </span>
                ))}
              />

              {/* Overall Rank */}
              <StatRow
                label="Overall Rank"
                highlight={bestRank}
                cells={players.map((p) => (
                  <span className="text-zinc-300">#{p.overallRank}</span>
                ))}
              />

              {/* ADP — no highlight (lower = drafted earlier, ambiguous as "best") */}
              <StatRow
                label="ADP"
                highlight={noHighlight}
                cells={stats.map((s, i) =>
                  s.adp !== null ? (
                    <span key={players[i].id} className="text-zinc-400">{s.adp.toFixed(1)}</span>
                  ) : (
                    <span key={players[i].id} className="text-zinc-600">—</span>
                  )
                )}
              />

              {/* Val (ADP minus rank; positive = value pick) */}
              <StatRow
                label="Val"
                highlight={bestVal}
                cells={stats.map((s, i) => {
                  const v = s.val;
                  return (
                    <span
                      key={players[i].id}
                      className={`font-medium ${
                        v === null
                          ? "text-zinc-700"
                          : v > 1
                          ? "text-emerald-400"
                          : v < -1
                          ? "text-rose-400"
                          : "text-zinc-500"
                      }`}
                    >
                      {v === null
                        ? "—"
                        : v > 1
                        ? `+${v.toFixed(1)}`
                        : v < -1
                        ? v.toFixed(1)
                        : "~0"}
                    </span>
                  );
                })}
              />

              {/* Risk (1–10; lower = safer = better) */}
              <StatRow
                label="Risk"
                highlight={bestRisk}
                cells={stats.map((s, i) => {
                  const riskColor =
                    s.risk >= 7
                      ? "text-rose-400"
                      : s.risk >= 4
                      ? "text-amber-400"
                      : "text-emerald-400";
                  return (
                    <span key={players[i].id} className={`font-semibold ${riskColor}`}>
                      {s.risk}
                    </span>
                  );
                })}
              />

              {/* Bye week */}
              <StatRow
                label="Bye"
                highlight={noHighlight}
                cells={players.map((p) =>
                  p.bye != null ? (
                    <span className="text-zinc-400">{p.bye}</span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )
                )}
              />

              {/* Injury status */}
              <StatRow
                label="Injury"
                highlight={noHighlight}
                cells={players.map((p) =>
                  p.injuryStatus ? (
                    <span className="text-amber-400 text-xs">{p.injuryStatus}</span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )
                )}
              />

              {/* Age / Experience */}
              <StatRow
                label="Age/Exp"
                highlight={noHighlight}
                cells={players.map((p) =>
                  p.yearsExp === 0 ? (
                    <span className="text-amber-400 text-xs">Rookie</span>
                  ) : p.yearsExp !== null ? (
                    <span className="text-zinc-400 text-xs">Yr {p.yearsExp + 1}</span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )
                )}
              />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
