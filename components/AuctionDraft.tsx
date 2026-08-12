"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import type { Player, Position, RankedPlayer } from "@/lib/types";
import { ALL_POSITIONS } from "@/lib/types";
import { rankPlayers, type BaselineMethod } from "@/lib/vbd";
import { DEFAULT_ROSTER, DEFAULT_SCORING } from "@/lib/presets";
import { POS_BADGE } from "@/lib/ui";
import { useLocalStorage } from "./useLocalStorage";
import {
  auctionBudget, auctionPriceFromPool, auctionValuePool, averageAuctionBudget, clampAuctionSetupInput,
  isValidAuctionSetup, isValidWonPlayers, legalAuctionPurchase, legalPositionsForTeam, teamAuctionValue,
  unionLegalPositions, wonPlayersWithinTeams, type AuctionSetup, type WonPlayer,
} from "@/lib/auction";
import { rosterSlots } from "@/lib/draft";
import { validRoster, validScoring } from "@/lib/validation";

type Filter = "ALL" | Position;

const DEFAULT_SETUP: AuctionSetup = {
  numTeams: 12,
  budgetPerTeam: 200,
  started: false,
};

export default function AuctionDraft() {
  // Player data
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inherit the same config as DraftBoard so rankings match
  const [scoring] = useLocalStorage("ffdp.scoring", DEFAULT_SCORING, validScoring);
  const [rosterCfg] = useLocalStorage("ffdp.roster", DEFAULT_ROSTER, validRoster);
  const [method] = useLocalStorage<BaselineMethod>("ffdp.method", "VOLS");

  // Auction-specific persisted state. Validated on load so malformed
  // localStorage (e.g. a non-numeric price) can't flow into budget math and
  // silently defeat the max-bid gate (see lib/auction.ts).
  const [wonPlayers, setWonPlayers] = useLocalStorage<WonPlayer[]>(
    "ffdp.auction.wonPlayers",
    [],
    isValidWonPlayers
  );
  const [setup, setSetup, setupHydrated] = useLocalStorage<AuctionSetup>(
    "ffdp.auction.setup",
    DEFAULT_SETUP,
    isValidAuctionSetup
  );

  // Local draft of the setup form (pre-Start); syncs once localStorage hydrates
  const [setupDraft, setSetupDraft] = useState({
    numTeams: DEFAULT_SETUP.numTeams,
    budgetPerTeam: DEFAULT_SETUP.budgetPerTeam,
  });
  const [setupMessage, setSetupMessage] = useState<string | null>(null);

  useEffect(() => {
    if (setupHydrated) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate editable form draft from persisted setup
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
  const [bidError, setBidError] = useState<string | null>(null);
  // Tracks whether the user has hand-edited the bid for the current
  // nomination. Once true, changing the winning-team dropdown must not
  // overwrite a price the user already typed.
  const [bidTouched, setBidTouched] = useState(false);

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

  // See wonPlayersWithinTeams in lib/auction.ts: drops any persisted
  // wonPlayers entry whose teamIndex falls outside the live team count, so
  // it can't stay marked "taken" via wonSet while being invisible to every
  // team's budget/roster derivation below.
  const validWonPlayers = useMemo(
    () => wonPlayersWithinTeams(wonPlayers, setup.numTeams),
    [wonPlayers, setup.numTeams]
  );

  const wonSet = useMemo(
    () => new Set(validWonPlayers.map((w) => w.playerId)),
    [validWonPlayers]
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
    for (const w of validWonPlayers) {
      if (w.teamIndex >= 0 && w.teamIndex < arr.length) {
        arr[w.teamIndex] -= w.price;
      }
    }
    return arr;
  }, [validWonPlayers, setup.numTeams, setup.budgetPerTeam]);

  const slots = useMemo(() => rosterSlots(rosterCfg), [rosterCfg]);
  const teamPlayers = useMemo(() => Array.from({ length: setup.numTeams }, (_, teamIndex) => validWonPlayers
    .filter((win) => win.teamIndex === teamIndex)
    .flatMap((win) => {
      const player = ranked.find((item) => item.id === win.playerId);
      return player ? [{ id: player.id, position: player.position }] : [];
    })), [setup.numTeams, validWonPlayers, ranked]);
  const budgetGuidance = useMemo(() => budgets.map((remaining, teamIndex) => auctionBudget(
    setup.budgetPerTeam,
    setup.budgetPerTeam - remaining,
    slots.length,
    teamPlayers[teamIndex]?.length ?? 0,
  )), [budgets, setup.budgetPerTeam, slots.length, teamPlayers]);
  const remainingTotalBudget = useMemo(() => budgets.reduce((sum, budget) => sum + budget, 0), [budgets]);

  // Per-team legal-position set, computed once per team (not once per
  // visible player row). Legality of a $1 nomination only depends on the
  // team's roster + budget + the candidate's position, never on which
  // specific player is asked about, so this tests the ~6 known positions
  // instead of running legalAuctionPurchase (and its backtracking
  // assignRoster solve) for every available player on every row render.
  // NOTE: this only hoists the assignRoster probe out of the per-row path —
  // it says nothing about the O(available.length) VBD-pool sum inside
  // teamAuctionValue, which is hoisted separately below (marketPool).
  const teamLegalPositions = useMemo(
    () => budgetGuidance.map((budget, teamIndex) => legalPositionsForTeam(budget, teamPlayers[teamIndex] ?? [], slots)),
    [budgetGuidance, teamPlayers, slots]
  );

  // Team-agnostic market price for the board-wide "Sug. Bid" column. Must not
  // depend on the nominee-winner dropdown (that would silently rewrite every
  // row's price whenever the dropdown changes) and must not collapse to $0
  // just because one arbitrary team's roster happens to be full — so this
  // unions legal positions across every team and averages their budgets,
  // rather than reading a single team's numbers. Computed once per render
  // (not once per row) since every row prices against the same pool.
  const marketLegalPositions = useMemo(() => unionLegalPositions(teamLegalPositions), [teamLegalPositions]);
  const marketBudget = useMemo(() => averageAuctionBudget(budgetGuidance), [budgetGuidance]);
  const marketPool = useMemo(() => auctionValuePool(available, marketLegalPositions), [available, marketLegalPositions]);

  // Team-specific price for the nomination panel, where the team is explicit
  // (either the team the dropdown is currently set to, or a caller-supplied
  // one) — unlike the board column, this one legitimately depends on teamIndex.
  function suggestedBid(p: RankedPlayer, teamIndex: number): number {
    const legalPositions = teamLegalPositions[teamIndex] ?? new Set<Position>();
    return teamAuctionValue(p, available, budgetGuidance[teamIndex], legalPositions);
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
    const minimumRoster = slots.length;
    const clamped = clampAuctionSetupInput(setupDraft.numTeams, setupDraft.budgetPerTeam, minimumRoster);
    if (clamped.adjusted) {
      // Clamp to the nearest bound and show what changed, instead of
      // silently substituting a fallback default (e.g. 33 teams -> 32, not a
      // silent 12-team default). Require a second Start click to confirm.
      setSetupDraft({ numTeams: clamped.numTeams, budgetPerTeam: clamped.budgetPerTeam });
      setSetupMessage(clamped.messages.join(" "));
      return;
    }
    setSetupMessage(null);
    setSetup({ numTeams: clamped.numTeams, budgetPerTeam: clamped.budgetPerTeam, started: true });
    setWonPlayers([]);
    // Clear any open nomination so a re-start with a different team count
    // can't leave a stale nomineeWinner index pointing past a shorter
    // budgetGuidance array.
    setNomineeId(null);
    setNomineeWinner(0);
    setNomineeBid("");
    setBidError(null);
    setBidTouched(false);
  }

  function handleNominate(p: RankedPlayer) {
    setNomineeId(p.id);
    setNomineeWinner(0);
    setNomineeBid(String(suggestedBid(p, 0)));
    setBidError(null);
    // Fresh nomination: auto-suggest again until the user edits the bid.
    setBidTouched(false);
  }

  function handleConfirmWin() {
    if (!nomineeId) return;
    const price = parseInt(nomineeBid, 10);
    const nominee = ranked.find((player) => player.id === nomineeId);
    if (!nominee) return;
    // Guard against a stale nomineeWinner index (e.g. left over from a
    // reset while a nomination panel was open, then a restart with fewer
    // teams) indexing past the current budgetGuidance array.
    const budget = budgetGuidance[nomineeWinner];
    if (!budget) { setBidError("That team is no longer part of the auction — re-nominate the player."); return; }
    const validation = legalAuctionPurchase(price, budget, teamPlayers[nomineeWinner] ?? [], nominee, slots);
    if (!validation.legal) { setBidError(validation.reason); return; }
    setWonPlayers((prev) => [
      ...prev,
      { playerId: nomineeId, teamIndex: nomineeWinner, price },
    ]);
    setNomineeId(null);
    setNomineeBid("");
    setNomineeWinner(0);
    setBidError(null);
    setBidTouched(false);
  }

  function handleReset() {
    if (!window.confirm("Reset the auction? All bids will be cleared.")) return;
    setWonPlayers([]);
    setSetup({ ...setup, started: false });
    // Clear any open nomination so a restart can't inherit a stale
    // nomineeWinner index that later falls out of bounds if the auction
    // restarts with fewer teams.
    setNomineeId(null);
    setNomineeWinner(0);
    setNomineeBid("");
    setBidError(null);
    setBidTouched(false);
  }

  // Rosters for the right panel
  const teamRosters = useMemo(() => {
    return Array.from({ length: setup.numTeams }, (_, i) =>
      validWonPlayers
        .filter((w) => w.teamIndex === i)
        .map((w) => ({
          ...w,
          player: ranked.find((r) => r.id === w.playerId),
        }))
    );
  }, [validWonPlayers, ranked, setup.numTeams]);

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
          {setupMessage && (
            <p role="alert" className="mb-4 text-xs text-rose-400">
              {setupMessage}
            </p>
          )}
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
    <div className="flex flex-col gap-4 xl:flex-row">
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
          <div className="overflow-x-auto rounded-xl border border-zinc-800" tabIndex={0} aria-label="Auction player values">
            <table className="min-w-[700px] w-full text-sm">
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
                  const bid = auctionPriceFromPool(p, marketPool, marketBudget);
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
                                onChange={(e) => {
                                  const winner = parseInt(e.target.value, 10);
                                  setNomineeWinner(winner);
                                  // Only auto-fill the suggested bid while the
                                  // user hasn't hand-edited it — otherwise
                                  // switching the winning team clobbers a
                                  // price they already typed.
                                  if (!bidTouched) setNomineeBid(String(suggestedBid(p, winner)));
                                  setBidError(null);
                                }}
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
                              <span className="text-sm text-zinc-400">
                                (max ${budgetGuidance[nomineeWinner]?.maxBid})
                              </span>
                              <span className="text-sm text-zinc-400">at</span>
                              <div className="flex items-center gap-1">
                                <span className="text-sm text-zinc-400">$</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={budgetGuidance[nomineeWinner]?.maxBid}
                                  value={nomineeBid}
                                  onChange={(e) =>
                                    { setNomineeBid(e.target.value); setBidError(null); setBidTouched(true); }
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
                              {bidError && (
                                <span className="w-full text-xs text-rose-400">
                                  {bidError}
                                </span>
                              )}
                            </div>
                            <p className="mt-2 text-xs text-zinc-500">
                              {teamLabel(nomineeWinner)}: ${budgetGuidance[nomineeWinner]?.remaining} left · ${budgetGuidance[nomineeWinner]?.reservedMinimum} reserved · ${budgetGuidance[nomineeWinner]?.maxBid} max
                            </p>
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
            {available.length} players available · {validWonPlayers.length} won ·
            ${remainingTotalBudget} remaining across all teams
          </p>
        )}
      </div>

      {/* Right panel — rosters */}
      <div className="w-full shrink-0 xl:w-64">
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
              <div className="mb-1.5 text-[11px] text-zinc-600">
                max bid ${budgetGuidance[i].maxBid}
              </div>
              <div className="space-y-0.5">
                <div className="mb-2 grid grid-cols-2 gap-x-2 text-[10px] text-zinc-500">
                  <span>{budgetGuidance[i].openSlots} slots</span>
                  <span className="text-right">${budgetGuidance[i].dollarsPerSlot.toFixed(1)}/slot</span>
                  <span>${budgetGuidance[i].reservedMinimum} reserved</span>
                  <span className="text-right">${budgetGuidance[i].maxBid} max</span>
                  <span className="col-span-2">${budgetGuidance[i].spendable} spendable above min</span>
                </div>
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
