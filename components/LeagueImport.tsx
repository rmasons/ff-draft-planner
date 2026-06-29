"use client";

import { useState } from "react";
import type { RosterConfig, ScoringConfig } from "@/lib/types";
import { SEASON } from "@/lib/sleeper";
import {
  fetchSleeperUser,
  fetchUserLeagues,
  fetchKeptPlayerIds,
  mapLeagueToConfig,
  type SleeperLeague,
  type LeagueType,
} from "@/lib/sleeper-league";

const TYPE_LABEL: Record<LeagueType, string> = {
  redraft: "Redraft",
  keeper: "Keeper",
  dynasty: "Dynasty",
};

const TYPE_STYLE: Record<LeagueType, string> = {
  redraft: "bg-zinc-700/50 text-zinc-300",
  keeper: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
  dynasty: "bg-purple-500/15 text-purple-300 border border-purple-500/30",
};

interface Props {
  currentScoring: ScoringConfig;
  setScoring: (s: ScoringConfig) => void;
  setRoster: (r: RosterConfig) => void;
  /** Merge the given player IDs into the drafted list (union, no clobber). */
  onKeepersMerge: (ids: string[]) => void;
}

export default function LeagueImport({
  currentScoring,
  setScoring,
  setRoster,
  onKeepersMerge,
}: Props) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [leagues, setLeagues] = useState<SleeperLeague[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [loadingKeepers, setLoadingKeepers] = useState(false);
  const [keeperStatus, setKeeperStatus] = useState<string | null>(null);
  const [appliedSeason, setAppliedSeason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedLeague = leagues?.find((l) => l.league_id === selectedId) ?? null;

  async function findLeagues() {
    if (!username.trim()) return;
    setLoading(true);
    setError(null);
    setLeagues(null);
    setSelectedId("");
    setKeeperStatus(null);
    try {
      const user = await fetchSleeperUser(username.trim());
      // Try current season first; fall back to prior season if empty.
      let found = await fetchUserLeagues(user.user_id, SEASON);
      let season = SEASON;
      if (found.length === 0) {
        const prior = String(Number(SEASON) - 1);
        found = await fetchUserLeagues(user.user_id, prior);
        season = prior;
      }
      if (found.length === 0) {
        setError(`No NFL leagues found for "${username}" in ${SEASON} or ${Number(SEASON) - 1}.`);
      } else {
        setLeagues(found);
        setSelectedId(found[0].league_id);
        setAppliedSeason(season);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function applyLeague() {
    if (!selectedLeague) return;
    const { scoring, roster } = mapLeagueToConfig(selectedLeague, currentScoring);
    setScoring(scoring);
    setRoster(roster);
    setKeeperStatus(null);
  }

  async function loadKeepers() {
    if (!selectedLeague) return;
    setLoadingKeepers(true);
    setKeeperStatus(null);
    try {
      const ids = await fetchKeptPlayerIds(selectedLeague);
      if (ids.length === 0) {
        const msg =
          selectedLeague.type === "keeper"
            ? "No keepers set yet — check back closer to your draft."
            : "No rostered players found.";
        setKeeperStatus(msg);
      } else {
        onKeepersMerge(ids);
        const label =
          selectedLeague.type === "dynasty" ? "rostered players" : "keepers";
        setKeeperStatus(`${ids.length} ${label} marked as drafted.`);
      }
    } catch (e) {
      setKeeperStatus(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingKeepers(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-sm font-semibold uppercase tracking-wide text-zinc-300"
      >
        Import from Sleeper
        <span className="text-zinc-600">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-4 flex flex-col gap-3">
          {/* Username input */}
          <div className="flex gap-2">
            <input
              placeholder="Sleeper username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && findLeagues()}
              className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
            />
            <button
              onClick={findLeagues}
              disabled={loading || !username.trim()}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-emerald-500 hover:text-emerald-400 disabled:opacity-40"
            >
              {loading ? "…" : "Find"}
            </button>
          </div>

          {error && (
            <p className="text-xs text-rose-400">{error}</p>
          )}

          {/* League picker */}
          {leagues && leagues.length > 0 && (
            <>
              {appliedSeason && appliedSeason !== SEASON && (
                <p className="text-xs text-amber-400">
                  No {SEASON} leagues found — showing {appliedSeason} leagues.
                </p>
              )}
              <select
                value={selectedId}
                onChange={(e) => {
                  setSelectedId(e.target.value);
                  setKeeperStatus(null);
                }}
                className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
              >
                {leagues.map((l) => (
                  <option key={l.league_id} value={l.league_id}>
                    {l.name}
                  </option>
                ))}
              </select>

              {/* Selected league metadata */}
              {selectedLeague && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${TYPE_STYLE[selectedLeague.type]}`}
                  >
                    {TYPE_LABEL[selectedLeague.type]}
                  </span>
                  <span className="text-zinc-500">
                    {selectedLeague.total_rosters} teams · {selectedLeague.season}
                  </span>
                  {selectedLeague.status && (
                    <span className="text-zinc-600 capitalize">
                      {selectedLeague.status.replace(/_/g, " ")}
                    </span>
                  )}
                </div>
              )}

              {/* Apply button */}
              <button
                onClick={applyLeague}
                disabled={!selectedLeague}
                className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 transition hover:bg-emerald-500/20 disabled:opacity-40"
              >
                Apply scoring &amp; roster
              </button>

              {/* Keeper / dynasty loader */}
              {selectedLeague && selectedLeague.type !== "redraft" && (
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={loadKeepers}
                    disabled={loadingKeepers}
                    className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-amber-500/50 hover:text-amber-400 disabled:opacity-40"
                  >
                    {loadingKeepers
                      ? "Loading…"
                      : selectedLeague.type === "dynasty"
                      ? "Mark rostered players as drafted"
                      : "Mark keepers as drafted"}
                  </button>
                  {keeperStatus && (
                    <p className="text-xs text-zinc-400">{keeperStatus}</p>
                  )}
                  {selectedLeague.type === "dynasty" && (
                    <p className="text-[11px] leading-snug text-zinc-600">
                      Dynasty: all rostered players are marked off. Available
                      players are free agents and rookies.
                    </p>
                  )}
                </div>
              )}

              <p className="text-[11px] leading-snug text-zinc-600">
                Scoring is mapped from your league settings. Leagues with custom
                bonus scoring (first downs, yardage tiers) will approximate.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
