"use client";

import { memo, useMemo } from "react";
import type { Position, RankedPlayer } from "@/lib/types";
import { POS_BADGE, UNKNOWN_BADGE } from "@/lib/ui";

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
  draftMode: "cpu" | "manual" | "live";
  teamNames?: Record<number, string>;
}

// POS_BADGE / UNKNOWN_BADGE now come from @/lib/ui (shared across screens).

function pickNumForCell(round: number, slot: number, numTeams: number): number {
  const base = (round - 1) * numTeams;
  return round % 2 === 1 ? base + slot : base + (numTeams + 1 - slot);
}

function lastNameOf(name: string): string {
  const parts = name.trim().split(" ");
  return parts.length > 1 ? parts.slice(1).join(" ") : name;
}

interface CellProps {
  pickNum: number;
  pick: BoardPick | undefined;
  tradedTo: number | undefined;
  isCurrent: boolean;
  isUserCol: boolean;
  playerById: Map<string, RankedPlayer>;
}

const BoardCell = memo(function BoardCell({ pickNum, pick, tradedTo, isCurrent, isUserCol, playerById }: CellProps) {
  if (pick) {
    const player = playerById.get(pick.playerId);
    const name = player?.name ?? pick.playerName ?? pick.playerId;
    const pos = (player?.position ?? pick.playerPos) as Position | undefined;
    // Same known-position-with-fallback pattern used in MockDraft.tsx: a
    // recognized Position gets its POS_BADGE color, anything else (e.g. a
    // raw Sleeper metadata position string that doesn't match) falls back
    // to the shared UNKNOWN_BADGE styling instead of hiding the badge.
    const badgeClass = pos && pos in POS_BADGE ? POS_BADGE[pos] : UNKNOWN_BADGE;
    const displayName = lastNameOf(name);

    return (
      <td className={`min-w-[88px] max-w-[110px] px-1.5 py-1.5 align-top ${isUserCol ? "bg-emerald-500/5" : ""}`}>
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            {pos && (
              <span className={`shrink-0 rounded border px-1 py-px text-[9px] font-bold ${badgeClass}`}>
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
              pick.isKeeper ? "italic text-amber-200" : isUserCol ? "font-medium text-emerald-200" : "text-zinc-200"
            }`}
            title={name}
          >
            {displayName}
          </span>
        </div>
      </td>
    );
  }

  return (
    <td
      className={`min-w-[88px] max-w-[110px] px-1.5 py-1.5 ${
        isCurrent ? "ring-1 ring-inset ring-emerald-500/60 bg-emerald-500/5" : isUserCol ? "bg-emerald-500/5" : ""
      }`}
    >
      <div className="flex h-9 items-center justify-center">
        {tradedTo ? (
          <span className="text-[10px] font-medium text-zinc-500">→T{tradedTo}</span>
        ) : isCurrent ? (
          <span className="text-[10px] font-medium text-emerald-500">●</span>
        ) : (
          <span className="text-[10px] text-zinc-800">{pickNum}</span>
        )}
      </div>
    </td>
  );
});

function DraftBoardGrid({
  picks,
  tradedPicks,
  numTeams,
  numRounds,
  userSlot,
  currentPickNum,
  playerById,
  draftMode,
  teamNames,
}: Props) {
  const pickByNum = useMemo(() => {
    const m = new Map<number, BoardPick>();
    for (const p of picks) m.set(p.pickNumber, p);
    return m;
  }, [picks]);

  const tradedByCell = useMemo(() => {
    const m = new Map<string, number>();
    for (const tp of tradedPicks) m.set(`${tp.round}-${tp.originalSlot}`, tp.currentSlot);
    return m;
  }, [tradedPicks]);

  const slots = useMemo(() => Array.from({ length: numTeams }, (_, i) => i + 1), [numTeams]);
  const rounds = useMemo(() => Array.from({ length: numRounds }, (_, i) => i + 1), [numRounds]);

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="border-collapse text-xs">
        <thead>
          <tr className="bg-zinc-900/80">
            <th className="sticky left-0 z-10 bg-zinc-900/80 px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-zinc-600 whitespace-nowrap">
              Rd
            </th>
            {slots.map((slot) => {
              const name = teamNames?.[slot];
              const label = name ?? `T${slot}`;
              const isUser = draftMode === "cpu" && slot === userSlot;
              return (
                <th
                  key={slot}
                  title={name}
                  className={`px-1 py-2 text-center text-[10px] font-semibold uppercase tracking-wide ${
                    isUser ? "text-emerald-400" : "text-zinc-500"
                  }`}
                >
                  {isUser ? (
                    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 whitespace-nowrap">{label} ★</span>
                  ) : (
                    <span className="block max-w-[96px] overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
                  )}
                </th>
              );
            })}
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
                return (
                  <BoardCell
                    key={slot}
                    pickNum={pickNum}
                    pick={pick}
                    tradedTo={tradedTo}
                    isCurrent={isCurrent}
                    isUserCol={isUserCol}
                    playerById={playerById}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default memo(DraftBoardGrid);
