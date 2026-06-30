"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { Player, Position, RankedPlayer } from "@/lib/types";
import { ALL_POSITIONS } from "@/lib/types";
import { rankPlayers, type BaselineMethod } from "@/lib/vbd";
import { DEFAULT_ROSTER, DEFAULT_SCORING } from "@/lib/presets";
import { useLocalStorage } from "./useLocalStorage";

type Filter = "ALL" | Position;

interface WonPlayer {
  playerId: string;
  teamIndex: number;
  price: number;
}

interface AuctionSetup {
  numTeams: number;
  budgetPerTeam: number;
  started: boolean;
}

const DEFAULT_SETUP: AuctionSetup = {
  numTeams: 12,
  budgetPerTeam: 200,
  started: false,
};

const POS_BADGE: Record<Position, string> = {
  QB: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  RB: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  WR: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  TE: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  K: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  DEF: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};

export default function AuctionDraft() {
  // Player data
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inherit the same config as DraftBoard so rankings match
  const [scoring] = useLocalStorage("ffdp.scoring", DEFAULT_SCORING);
  const [rosterCfg] = useLocalStorage("ffdp.roster", DEFAULT_ROSTER);
  const [method] = useLocalStorage<BaselineMethod>("ffdp.method", "VOLS");

  // Auction-specific persisted state
  const [wonPlayers, setWonPlayers] = useLocalStorage<WonPlayer[]>(
    "ffdp.auction.wonPlayers",
    []
  );
  const [setup, setSetup, setupHydrated] = useLocalStorage<AuctionSetup>(
    "ffdp.auction.setup",
    DEFAULT_SETUP
  );

  // Local draft of the setup form (pre-Start); syncs once localStorage hydrates
  const [setupDraft, setSetupDraft] = useState({
    numTeams: DEFAULT_SETUP.numTeams,
    budgetPerTeam: DEFAULT_SETUP.budgetPerTeam,
  });

  useEffect(() => {
    if (setupHydrated) {
      setSetupDraft({
        numTeams: setup.numTeams,
        budgetPerTeam: setup.budgetPerTeam,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupHydrated]);

  // Filter / search
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");

  // Nomination state
  const [nomineeId, setNomineeId] = useState<string | null>(null);
  const [nomineeWinner, setNomineeWinner] = useState(0);
  const [nomineeBid, setNomineeBid] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/players")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(d.detail ?? d.error);
        else setPlayers(d.players);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const ranked = useMemo(() => {
    if (!players) return [] as RankedPlayer[];
    return rankPlayers(players, scoring, rosterCfg, method).players;
  }, [players, scoring, rosterCfg, method]);

  const wonSet = useMemo(
    () => new Set(wonPlayers.map((w) => w.playerId)),
    [wonPlayers]
  );

  // Available = ranked players not yet won
  const available = useMemo(
    () => ranked.filter((p) => !wonSet.has(p.id)),
    [ranked, wonSet]
  );

  // Derived budgets: initial - sum of prices paid by each team
  const budgets = useMemo(() => {
    const arr = Array.from(
      { length: setup.numTeams },
      () => setup.budgetPerTeam
    );
    for (const w of wonPlayers) {
      if (w.teamIndex >= 0 && w.teamIndex < arr.length) {
        arr[w.teamIndex] -= w.price;
      }
    }
    return arr;
  }, [wonPlayers, setup.numTeams, setup.budgetPerTeam]);

  // Suggested bid formula: (player.vbd / positiveVorPool) × remainingTotalBudget
  // Denominator is over *available* players only so it recomputes as players are won.
  const positiveVorPool = useMemo(
    () => available.reduce((sum, p) => (p.vbd > 0 ? sum + p.vbd : sum), 0),
    [available]
  );
  const remainingTotalBudget = useMemo(
    () => budgets.reduce((a, b) => a + b, 0),
    [budgets]
  );

  function suggestedBid(p: RankedPlayer): number {
    if (p.vbd <= 0 || positiveVorPool <= 0) return 1;
    return Math.max(
      1,
      Math.round((p.vbd / positiveVorPool) * remainingTotalBudget)
    );
  }

  const visibleRows = useMemo(() => {
    let list = available;
    if (filter !== "ALL") list = list.filter((p) => p.position === filter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.team ?? "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [available, filter, query]);

  function handleStart() {
    const n = Math.max(2, setupDraft.numTeams || 12);
    const b = Math.max(1, setupDraft.budgetPerTeam || 200);
    setSetup({ numTeams: n, budgetPerTeam: b, started: true });
    setWonPlayers([]);
  }

  function handleNominate(p: RankedPlayer) {
    setNomineeId(p.id);
    setNomineeWinner(0);
    setNomineeBid(String(suggestedBid(p)));
  }

  function handleConfirmWin() {
    if (!nomineeId) return;
    const price = parseInt(nomineeBid, 10);
    if (isNaN(price) || price < 1) return;
    setWonPlayers((prev) => [
      ...prev,
      { playerId: nomineeId, teamIndex: nomineeWinner, price },
    ]);
    setNomineeId(null);
    setNomineeBid("");
    setNomineeWinner(0);
  }

  function handleReset() {
    if (!window.confirm("Reset the auction? All bids will be cleared.")) return;
    setWonPlayers([]);
    setSetup({ ...setup, started: false });
  }

  // Rosters for the right panel
  const teamRosters = useMemo(() => {
    return Array.from({ length: setup.numTeams }, (_, i) =>
      wonPlayers
        .filter((w) => w.teamIndex === i)
        .map((w) => ({
          ...w,
          player: ranked.find((r) => r.id === w.playerId),
        }))
    );
  }, [wonPlayers, ranked, setup.numTeams]);

  function teamLabel(i: number) {
    return i === 0 ? "You" : `Team ${i + 1}`;
  }

  // ---- Setup screen ----
  if (!setup.started) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900/60 p-8">
          <h2 className="mb-6 text-xl font-bold text-zinc-50">Auction Setup</h2>
          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-medium text-zinc-400">
              Number of teams
            </label>
            <input
              type="number"
              min={2}
              max={32}
              value={setupDraft.numTeams}
              onChange={(e) =>
                setSetupDraft((s) => ({
                  ...s,
                  numTeams: parseInt(e.target.value, 10) || 12,
                }))
              }
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div className="mb-6">
            <label className="mb-1.5 block text-sm font-medium text-zinc-400">
              Budget per team ($)
            </label>
            <input
              type="number"
              min={1}
              value={setupDraft.budgetPerTeam}
              onChange={(e) =>
                setSetupDraft((s) => ({
                  ...s,
                  budgetPerTeam: parseInt(e.target.value, 10) || 200,
                }))
              }
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-zinc-100 focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <button
            onClick={handleStart}
            className="w-full rounded-lg bg-emerald-500 py-2.5 font-semibold text-zinc-950 transition hover:bg-emerald-400"
          >
            Start Auction
          </button>
        </div>
      </div>
    );
  }

  // ---- Main screen ----
  return (
    <div className="flex gap-4">
      {/* Left panel — available players */}
      <div className="min-w-0 flex-1">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-zinc-800 p-0.5">
            {(["ALL", ...ALL_POSITIONS] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  filter === f
                    ? "bg-emerald-500 text-zinc-950"
                    : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <input
            placeholder="Search player or team…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-40 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
          />
          <span className="text-sm tabular-nums text-zinc-500">
            {available.length} left
          </span>
          <button
            onClick={handleReset}
            className="text-sm text-zinc-500 underline hover:text-zinc-300"
          >
            Reset
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-300">
            Couldn&apos;t load players: {error}
          </div>
        )}
        {!players && !error && (
          <div className="p-8 text-center text-zinc-500">
            Loading projections…
          </div>
        )}

        {players && (
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/80 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-zinc-500">
                    #
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-zinc-500">
                    Player
                  </th>
                  <th className="px-2 py-2 text-center font-medium text-zinc-500">
                    Pos
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-zinc-500">
                    Proj
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-zinc-500">
                    VOR
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-zinc-500">
                    Sug. Bid
                  </th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((p) => {
                  const isNominated = nomineeId === p.id;
                  const bid = suggestedBid(p);
                  return (
                    <Fragment key={p.id}>
                      <tr
                        className={`border-t border-zinc-800/60 transition hover:bg-zinc-900/40 ${
                          isNominated ? "bg-zinc-800/60" : ""
                        }`}
                      >
                        <td className="px-3 py-2 tabular-nums text-zinc-500">
                          {p.overallRank}
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-zinc-100">
                            {p.name}
                          </div>
                          <div className="text-xs text-zinc-500">
                            {p.team ?? "FA"}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <span
                            className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold ${POS_BADGE[p.position]}`}
                          >
                            {p.position}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-zinc-200">
                          {p.points.toFixed(1)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right tabular-nums font-medium ${
                            p.vbd > 0 ? "text-emerald-400" : "text-zinc-500"
                          }`}
                        >
                          {p.vbd > 0 ? "+" : ""}
                          {p.vbd.toFixed(1)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium text-amber-400">
                          ${bid}
                        </td>
                        <td className="px-2 py-2">
                          {isNominated ? (
                            <button
                              onClick={() => setNomineeId(null)}
                              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition hover:text-zinc-200"
                            >
                              Cancel
                            </button>
                          ) : (
                            <button
                              onClick={() => handleNominate(p)}
                              className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs text-emerald-400 transition hover:bg-emerald-500/10"
                            >
                              Nominate
                            </button>
                          )}
                        </td>
                      </tr>
                      {isNominated && (
                        <tr className="bg-zinc-800/40">
                          <td colSpan={7} className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-3">
                              <span className="text-sm font-medium text-zinc-300">
                                {p.name} won by:
                              </span>
                              <select
                                value={nomineeWinner}
                                onChange={(e) =>
                                  setNomineeWinner(
                                    parseInt(e.target.value, 10)
                                  )
                                }
                                className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                              >
                                {Array.from(
                                  { length: setup.numTeams },
                                  (_, i) => (
                                    <option key={i} value={i}>
                                      {teamLabel(i)}
                                    </option>
                                  )
                                )}
                              </select>
                              <span className="text-sm text-zinc-400">at</span>
                              <div className="flex items-center gap-1">
                                <span className="text-sm text-zinc-400">$</span>
                                <input
                                  type="number"
                                  min={1}
                                  value={nomineeBid}
                                  onChange={(e) =>
                                    setNomineeBid(e.target.value)
                                  }
                                  className="w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                                />
                              </div>
                              <button
                                onClick={handleConfirmWin}
                                className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400"
                              >
                                Confirm Win
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {visibleRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-8 text-center text-zinc-500"
                    >
                      No players available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {players && (
          <p className="mt-3 text-xs text-zinc-600">
            {available.length} players available · {wonPlayers.length} won ·
            ${remainingTotalBudget} remaining across all teams
          </p>
        )}
      </div>

      {/* Right panel — rosters */}
      <div className="w-56 shrink-0">
        <h3 className="mb-2 text-xs uppercase tracking-widest text-zinc-500">
          Rosters
        </h3>
        <div className="flex flex-col gap-2">
          {teamRosters.map((teamRoster, i) => (
            <div
              key={i}
              className={`rounded-xl border p-3 ${
                i === 0
                  ? "border-emerald-500/40 bg-emerald-950/20"
                  : "border-zinc-800 bg-zinc-900/40"
              }`}
            >
              <div className="mb-1.5 flex items-center justify-between">
                <span
                  className={`text-xs font-semibold ${
                    i === 0 ? "text-emerald-400" : "text-zinc-300"
                  }`}
                >
                  {teamLabel(i)}
                </span>
                <span
                  className={`text-xs tabular-nums ${
                    budgets[i] < 0 ? "text-rose-400" : "text-zinc-400"
                  }`}
                >
                  ${budgets[i]}
                </span>
              </div>
              <div className="space-y-0.5">
                {teamRoster.map((w) => (
                  <div
                    key={w.playerId}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="truncate text-zinc-300">
                      {w.player?.name ?? w.playerId}
                    </span>
                    <span className="ml-1 shrink-0 text-zinc-500">
                      ${w.price}
                    </span>
                  </div>
                ))}
                {teamRoster.length === 0 && (
                  <div className="text-xs text-zinc-700">No players yet</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
