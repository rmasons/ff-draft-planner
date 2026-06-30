"use client";

import { useMemo } from "react";
import type { RankedPlayer } from "@/lib/types";

interface Props {
  ranked: RankedPlayer[];
  draftedIds: Set<string>;
  numTeams: number;
  numRounds: number;
  currentPickNum: number;
}

type ChartPos = "RB" | "WR" | "TE" | "QB";

const CHART_POSITIONS: ChartPos[] = ["RB", "WR", "TE", "QB"];

const POS_CONFIG: Record<
  ChartPos,
  { badge: string; filled: string; depth: string; label: string }
> = {
  RB: {
    badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    filled: "bg-emerald-500",
    depth: "bg-emerald-500/20",
    label: "text-emerald-300",
  },
  WR: {
    badge: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    filled: "bg-sky-500",
    depth: "bg-sky-500/20",
    label: "text-sky-300",
  },
  TE: {
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    filled: "bg-amber-500",
    depth: "bg-amber-500/20",
    label: "text-amber-300",
  },
  QB: {
    badge: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    filled: "bg-rose-500",
    depth: "bg-rose-500/20",
    label: "text-rose-300",
  },
};

export default function ScarcityChart({
  ranked,
  draftedIds,
  numTeams,
  numRounds,
  currentPickNum,
}: Props) {
  const posData = useMemo(() => {
    return CHART_POSITIONS.map((pos) => {
      const undrafted = ranked.filter(
        (p) => p.position === pos && !draftedIds.has(p.id)
      );
      const starters = undrafted.filter((p) => p.vbd > 0).length;
      const depth = undrafted.filter((p) => p.vbd <= 0 && p.points > 50).length;
      return { pos, starters, depth, total: starters + depth };
    });
  }, [ranked, draftedIds]);

  const maxTotal = Math.max(...posData.map((d) => d.total), 1);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-6">
      <div className="mb-6">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Positional Scarcity
        </h2>
        <p className="text-xs text-zinc-600">
          Undrafted players remaining · Pick {currentPickNum} of{" "}
          {numTeams * numRounds} · {numTeams} teams · {numRounds} rounds
        </p>
      </div>

      <div className="space-y-6">
        {posData.map(({ pos, starters, depth, total }) => {
          const cfg = POS_CONFIG[pos];
          const starterPct = (starters / maxTotal) * 100;
          const depthPct = (depth / maxTotal) * 100;
          const isLow = starters > 0 && starters < numTeams;
          const isDepleted = starters === 0;

          return (
            <div key={pos}>
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`inline-block rounded border px-1.5 py-0.5 text-xs font-bold ${cfg.badge}`}
                  >
                    {pos}
                  </span>
                  <span
                    className={`text-sm font-semibold tabular-nums ${
                      isDepleted
                        ? "text-rose-400"
                        : isLow
                        ? "text-amber-400"
                        : cfg.label
                    }`}
                  >
                    {starters} starter{starters !== 1 ? "s" : ""}
                  </span>
                  <span className="text-zinc-700">·</span>
                  <span className="text-sm tabular-nums text-zinc-500">
                    {depth} depth
                  </span>
                </div>
                <span className="text-xs tabular-nums text-zinc-700">
                  {total} total
                </span>
              </div>

              <div className="flex h-4 overflow-hidden rounded-full bg-zinc-800/80">
                {starterPct > 0 && (
                  <div
                    className={`${cfg.filled} transition-[width] duration-300`}
                    style={{ width: `${starterPct}%` }}
                  />
                )}
                {depthPct > 0 && (
                  <div
                    className={`${cfg.depth} transition-[width] duration-300`}
                    style={{ width: `${depthPct}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex items-center gap-5 text-xs text-zinc-600">
        <div className="flex items-center gap-1.5">
          <div className="h-2.5 w-5 rounded-sm bg-zinc-400" />
          <span>Starter-quality (VOR &gt; 0)</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2.5 w-5 rounded-sm bg-zinc-700" />
          <span>Depth (proj &gt; 50 pts)</span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-amber-400">amber</span>
          <span>= less than one per team remaining</span>
        </div>
      </div>
    </div>
  );
}
