"use client";

import type { Position, RankedPlayer } from "@/lib/types";

export interface BoardPick {
  pickNumber: number;
  teamSlot: number;
  playerId: string;
  playerName?: string;
  playerPos?: string;
  isKeeper?: boolean;
}

export interface BoardTradedPick {
  round: number;
  originalSlot: number;
  currentSlot: number;
}

interface Props {
  picks: BoardPick[];
  tradedPicks: BoardTradedPick[];
  numTeams: number;
  numRounds: number;
  userSlot: number;
  currentPickNum: number;
  playerById: Map<string, RankedPlayer>;
  draftMode: "cpu" | "manual";
}

const POS_BADGE: Record<Position, string> = {
  QB: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  RB: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  WR: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  TE: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  K: "bg-violet-500/20 text-violet-300 border-violet-500/40",
  DEF: "bg-orange-500/20 text-orange-300 border-orange-500/40",
};

function pickNumForCell(round: number, slot: number, numTeams: number): number {
  const base = (round - 1) * numTeams;
  return round % 2 === 1 ? base + slot : base + (numTeams + 1 - slot);
}

function lastNameOf(name: string): string {
  const parts = name.trim().split(" ");
  return parts.length > 1 ? parts.slice(1).join(" ") : name;
}

export default function DraftBoardGrid({
  picks,
  tradedPicks,
  numTeams,
  numRounds,
  userSlot,
  currentPickNum,
  playerById,
  draftMode,
}: Props) {
  // Build lookup: pickNumber → pick
  const pickByNum = new Map<number, BoardPick>();
  for (const p of picks) pickByNum.set(p.pickNumber, p);

  // Build traded pick lookup: "round-originalSlot" → currentSlot
  const tradedByCell = new Map<string, number>();
  for (const tp of tradedPicks) {
    tradedByCell.set(`${tp.round}-${tp.originalSlot}`, tp.currentSlot);
  }

  const slots = Array.from({ length: numTeams }, (_, i) => i + 1);
  const rounds = Array.from({ length: numRounds }, (_, i) => i + 1);

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="border-collapse text-xs">
        <thead>
          <tr className="bg-zinc-900/80">
            <th className="sticky left-0 z-10 bg-zinc-900/80 px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-600 whitespace-nowrap">
              Rd
            </th>
            {slots.map((slot) => (
              <th
                key={slot}
                className={`px-1 py-2 text-center text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap ${
                  draftMode === "cpu" && slot === userSlot
                    ? "text-emerald-400"
                    : "text-zinc-500"
                }`}
              >
                {draftMode === "cpu" && slot === userSlot ? (
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5">
                    T{slot} ★
                  </span>
                ) : (
                  `T${slot}`
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rounds.map((round) => (
            <tr key={round} className="border-t border-zinc-800/60">
              <td className="sticky left-0 z-10 bg-zinc-950 px-2 py-1.5 text-center font-semibold tabular-nums text-zinc-600">
                {round}
              </td>
              {slots.map((slot) => {
                const pickNum = pickNumForCell(round, slot, numTeams);
                const pick = pickByNum.get(pickNum);
                const tradedTo = tradedByCell.get(`${round}-${slot}`);
                const isCurrent = pickNum === currentPickNum;
                const isUserCol = draftMode === "cpu" && slot === userSlot;

                if (pick) {
                  const player = playerById.get(pick.playerId);
                  const name =
                    player?.name ?? pick.playerName ?? pick.playerId;
                  const pos =
                    (player?.position ?? pick.playerPos) as Position | undefined;
                  const badgeClass =
                    pos && pos in POS_BADGE ? POS_BADGE[pos] : undefined;
                  const displayName = lastNameOf(name);

                  return (
                    <td
                      key={slot}
                      className={`min-w-[88px] max-w-[110px] px-1.5 py-1.5 align-top ${
                        isUserCol
                          ? "bg-emerald-500/5"
                          : ""
                      }`}
                    >
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1">
                          {pos && badgeClass && (
                            <span
                              className={`shrink-0 rounded border px-1 py-px text-[9px] font-bold ${badgeClass}`}
                            >
                              {pos}
                            </span>
                          )}
                          {pick.isKeeper && (
                            <span className="shrink-0 rounded border border-amber-400/40 bg-amber-400/10 px-1 py-px text-[9px] font-bold text-amber-300">
                              K
                            </span>
                          )}
                        </div>
                        <span
                          className={`truncate leading-tight ${
                            pick.isKeeper
                              ? "italic text-amber-200"
                              : isUserCol
                              ? "font-medium text-emerald-200"
                              : "text-zinc-200"
                          }`}
                          title={name}
                        >
                          {displayName}
                        </span>
                      </div>
                    </td>
                  );
                }

                // Empty cell
                return (
                  <td
                    key={slot}
                    className={`min-w-[88px] max-w-[110px] px-1.5 py-1.5 ${
                      isCurrent
                        ? "ring-1 ring-inset ring-emerald-500/60 bg-emerald-500/5"
                        : isUserCol
                        ? "bg-emerald-500/5"
                        : ""
                    }`}
                  >
                    <div className="flex h-9 items-center justify-center">
                      {tradedTo && tradedTo !== slot ? (
                        <span className="text-[10px] font-medium text-zinc-500">
                          →T{tradedTo}
                        </span>
                      ) : isCurrent ? (
                        <span className="text-[10px] font-medium text-emerald-500">
                          ●
                        </span>
                      ) : (
                        <span className="text-[10px] text-zinc-800">
                          {pickNum}
                        </span>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
