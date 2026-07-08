"use client";

import { useEffect, useMemo, useState } from "react";
import type { Player, Position, RankedPlayer } from "@/lib/types";
import { POSITIONS, ALL_POSITIONS } from "@/lib/types";
import {
  rankPlayers,
  BASELINE_LABELS,
  type BaselineMethod,
  type Baselines,
} from "@/lib/vbd";
import { adpKeyFor, DEFAULT_ROSTER, DEFAULT_SCORING } from "@/lib/presets";
import { consensusAdp, valueVsAdp } from "@/lib/adp";
import { riskScore } from "@/lib/risk";
import { POS_BADGE, POS_DOT } from "@/lib/ui";
import { useLocalStorage } from "./useLocalStorage";
import ConfigPanel from "./ConfigPanel";
import PlayerCompare from "./PlayerCompare";

type Filter = "ALL" | Position;
type SortKey = "rank" | "proj" | "vor" | "adp" | "value" | "risk";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

interface AdpSnapshot {
  ts: number;
  data: Record<string, number>;
  // Which adpKey (ppr/half/std/superflex, see adpKeyFor) the snapshot's `data`
  // was computed under. Consensus ADP differs by scoring/roster format, so a
  // snapshot seeded under one key is meaningless compared against another —
  // this lets us detect a format switch and rebuild instead of showing bogus
  // trend arrows. Optional so snapshots persisted before this field existed
  // are handled gracefully (treated as a mismatch, see trendMap below).
  adpKey?: string;
}

const SORT_DEFAULTS: Record<SortKey, 1 | -1> = {
  rank: 1,   // asc: lower = better
  proj: -1,  // desc: more points = better
  vor: -1,   // desc: more VOR = better
  adp: 1,    // asc: earlier ADP = higher consensus value
  value: -1, // desc: bigger steal = better
  risk: -1,  // desc: higher risk first (surface the most dangerous picks)
};

const TIER_COLORS = [
  "#34d399", "#60a5fa", "#c084fc", "#fbbf24",
  "#fb7185", "#22d3ee", "#a3e635", "#f472b6",
];
const tierColor = (tier: number) => TIER_COLORS[(tier - 1) % TIER_COLORS.length];

export default function DraftBoard() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<string>("");

  const [scoring, setScoring] = useLocalStorage("ffdp.scoring", DEFAULT_SCORING);
  const [roster, setRoster] = useLocalStorage("ffdp.roster", DEFAULT_ROSTER);
  const [method, setMethod] = useLocalStorage<BaselineMethod>("ffdp.method", "VOLS");
  const [drafted, setDrafted] = useLocalStorage<string[]>("ffdp.drafted", []);
  const [snapshot, setSnapshot, snapshotHydrated] = useLocalStorage<AdpSnapshot | null>(
    "ffdp.adp-snapshot",
    null,
  );

  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [hideDrafted, setHideDrafted] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/players")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setError(d.detail ?? d.error);
        else {
          setPlayers(d.players);
          setSeason(d.season);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  const adpKey = adpKeyFor(scoring, roster);

  // Seed or refresh the ADP snapshot used for trend indicators.
  // Uses a functional update so we never need `snapshot` in the dependency
  // array — avoiding a read-during-write loop.
  useEffect(() => {
    if (!players || !snapshotHydrated) return;
    setSnapshot((prev) => {
      const now = Date.now();
      // Still fresh AND seeded under the currently-active adpKey → keep it.
      // A missing adpKey (snapshot from before this field existed) or a key
      // that doesn't match the current scoring/roster format both count as
      // a mismatch and force a rebuild below.
      if (prev && prev.adpKey === adpKey && now - prev.ts <= SEVEN_DAYS_MS) return prev;
      // Build a new baseline from the current consensus ADP.
      const data: Record<string, number> = {};
      for (const p of players) {
        const c = consensusAdp(p, adpKey);
        if (c !== null) data[p.id] = c;
      }
      return { ts: now, data, adpKey };
    });
  }, [players, snapshotHydrated, adpKey, setSnapshot]);

  // Map player_id → trend delta (positive = rising, negative = falling).
  // Only populated when a fresh (≤7 day old) snapshot exists from a prior load.
  const trendMap = useMemo<Record<string, number>>(() => {
    if (!players || !snapshot || !snapshotHydrated) return {};
    if (Date.now() - snapshot.ts > SEVEN_DAYS_MS) return {};
    // Snapshot was seeded under a different adpKey (format switch, or an old
    // snapshot from before adpKey was tracked) — its ADP values aren't
    // comparable to the current consensus, so bail out rather than show
    // bogus trend arrows. The seeding effect above will rebuild it shortly.
    if (snapshot.adpKey !== adpKey) return {};
    const map: Record<string, number> = {};
    for (const p of players) {
      const snapAdp = snapshot.data[p.id];
      if (snapAdp === undefined) continue;
      const currentConsensus = consensusAdp(p, adpKey);
      if (currentConsensus === null) continue;
      // Positive → snapshotAdp was higher → player is now drafted earlier → rising
      map[p.id] = snapAdp - currentConsensus;
    }
    return map;
  }, [players, snapshot, snapshotHydrated, adpKey]);

  const { ranked, baselines } = useMemo(() => {
    if (!players) return { ranked: [] as RankedPlayer[], baselines: null as Baselines | null };
    const res = rankPlayers(players, scoring, roster, method);
    return { ranked: res.players, baselines: res.baselines };
  }, [players, scoring, roster, method]);

  const draftedSet = useMemo(() => new Set(drafted), [drafted]);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(SORT_DEFAULTS[key]);
    }
  }

  const rows = useMemo(() => {
    let list = ranked;
    if (filter !== "ALL") list = list.filter((p) => p.position === filter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.team ?? "").toLowerCase().includes(q)
      );
    }

    const sorted = [...list].sort((a, b) => {
      switch (sortKey) {
        case "rank":
          return filter === "ALL"
            ? (a.overallRank - b.overallRank) * sortDir
            : (a.posRank - b.posRank) * sortDir;
        case "proj":
          return (a.points - b.points) * sortDir;
        case "vor":
          return (a.vbd - b.vbd) * sortDir;
        case "adp": {
          const va = a.adp[adpKey] >= 999 ? null : a.adp[adpKey];
          const vb = b.adp[adpKey] >= 999 ? null : b.adp[adpKey];
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
        case "value": {
          // valueVsAdp already returns null for K/DEF (their overallRank is
          // forced to the bottom of the board by design, see rankPlayers in
          // lib/vbd.ts) and for players with no consensus ADP data.
          const va = valueVsAdp(a, adpKey);
          const vb = valueVsAdp(b, adpKey);
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
        case "risk":
          return (riskScore(a) - riskScore(b)) * sortDir;
        default:
          return 0;
      }
    });

    return hideDrafted ? sorted.filter((p) => !draftedSet.has(p.id)) : sorted;
  }, [ranked, filter, query, hideDrafted, draftedSet, sortKey, sortDir, adpKey]);

  const toggleDrafted = (id: string) =>
    setDrafted((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  // Toggle a player in/out of the compare panel (max 3).
  // When a removal would leave fewer than 2 players, clear the list (closes modal).
  const toggleCompare = (id: string) =>
    setCompareIds((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((x) => x !== id);
        return next.length < 2 ? [] : next;
      }
      if (prev.length >= 3) return prev;
      return [...prev, id];
    });

  // Tier dividers and replacement line only make sense on the default rank sort.
  const isRankSort = sortKey === "rank" && sortDir === 1;
  const replRank =
    filter !== "ALL" && !query.trim() && isRankSort && baselines
      ? baselines[filter].rank
      : null;

  function SortTh({
    label,
    sk,
    className,
    subLabel,
  }: {
    label: string;
    sk: SortKey;
    className?: string;
    subLabel?: string;
  }) {
    const active = sortKey === sk;
    return (
      <th
        onClick={() => handleSort(sk)}
        className={`cursor-pointer select-none px-3 py-2 font-medium transition hover:text-zinc-200 ${
          active ? "text-emerald-400" : "text-zinc-500"
        } ${className ?? ""}`}
      >
        {label}
        {subLabel && <span className="ml-1 font-normal text-zinc-600">{subLabel}</span>}
        <span className="ml-0.5 text-[10px]">
          {active
            ? sortDir === 1 ? " ↑" : " ↓"
            : <span className="text-zinc-700"> ⇅</span>}
        </span>
      </th>
    );
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <ConfigPanel
        scoring={scoring}
        roster={roster}
        method={method}
        setScoring={setScoring}
        setRoster={setRoster}
        setMethod={setMethod}
        onKeepersMerge={(ids) =>
          setDrafted((prev) => [...new Set([...prev, ...ids])])
        }
      />

      <main className="min-w-0 flex-1">
        {/* Baseline summary — skill positions only */}
        {baselines && (
          <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
              Replacement baseline
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">
                {method} · {BASELINE_LABELS[method]}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {POSITIONS.map((pos) => (
                <div
                  key={pos}
                  className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs"
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: POS_DOT[pos] }}
                  />
                  <span className="font-semibold text-zinc-200">
                    {pos}
                    {baselines[pos].rank}
                  </span>
                  <span className="text-zinc-500">
                    {baselines[pos].points.toFixed(1)} pts
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Toolbar */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
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
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input
              type="checkbox"
              checked={hideDrafted}
              onChange={(e) => setHideDrafted(e.target.checked)}
              className="accent-emerald-500"
            />
            Hide drafted
          </label>
          {drafted.length > 0 && (
            <button
              onClick={() => setDrafted([])}
              className="text-sm text-zinc-500 underline hover:text-zinc-300"
            >
              Reset ({drafted.length})
            </button>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-300">
            Couldn&apos;t load players: {error}
          </div>
        )}
        {!players && !error && (
          <div className="p-8 text-center text-zinc-500">Loading projections…</div>
        )}

        {players && (
          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/80 text-xs uppercase tracking-wide">
                <tr>
                  <SortTh label="#" sk="rank" className="text-left" />
                  <th className="px-3 py-2 text-left font-medium text-zinc-500">Player</th>
                  <th className="px-2 py-2 text-center font-medium text-zinc-500">Pos</th>
                  <th className="px-2 py-2 text-center font-medium text-zinc-500">Tier</th>
                  <SortTh label="Proj" sk="proj" className="text-right" />
                  <th
                    className="px-3 py-2 text-right font-medium text-zinc-500"
                    title="2025 season total, PPR scoring"
                  >
                    2025
                  </th>
                  <SortTh label="VOR" sk="vor" className="text-right" />
                  <SortTh label="ADP" sk="adp" className="text-right" subLabel="SL·ESPN" />
                  <SortTh label="Val" sk="value" className="text-right" />
                  <SortTh label="Risk" sk="risk" className="text-center" />
                  <th className="px-2 py-2 text-center font-medium text-zinc-500"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => {
                  const prev = rows[i - 1];
                  // Single-position: break on any tier change (including first row).
                  // ALL positions: break only when consecutive same-position players
                  // change tier — avoids spurious breaks across different positions.
                  const tierBreak =
                    !query.trim() &&
                    isRankSort &&
                    (filter !== "ALL"
                      ? !prev || prev.tier !== p.tier
                      : !!prev && prev.position === p.position && prev.tier !== p.tier);
                  const replBreak =
                    replRank !== null &&
                    p.posRank > replRank &&
                    (!prev || prev.posRank <= replRank);
                  const isDrafted = draftedSet.has(p.id);
                  const adpRaw = p.adp[adpKey];
                  const adpDisplay = adpRaw >= 999 ? null : adpRaw;
                  const espnAdp = p.adp.espn >= 999 ? null : p.adp.espn;
                  // valueVsAdp already returns null for K/DEF (forced to the
                  // bottom of the board by design, see rankPlayers in
                  // lib/vbd.ts) and for players with no consensus ADP data.
                  const value = valueVsAdp(p, adpKey);
                  const risk = riskScore(p);
                  const trend = trendMap[p.id] ?? 0;
                  return (
                    <Row
                      key={p.id}
                      p={p}
                      rank={filter === "ALL" ? p.overallRank : p.posRank}
                      adp={adpDisplay}
                      espnAdp={espnAdp}
                      value={value}
                      risk={risk}
                      trend={trend}
                      isDrafted={isDrafted}
                      tierBreak={tierBreak}
                      replBreak={replBreak}
                      onToggle={() => toggleDrafted(p.id)}
                      inCompare={compareIds.includes(p.id)}
                      onCompare={() => toggleCompare(p.id)}
                    />
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-8 text-center text-zinc-500">
                      No players match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {players && (
          <p className="mt-3 text-xs text-zinc-600">
            {rows.length} players · {season} projections · VOR baselines (
            {method}) from your roster settings
          </p>
        )}
      </main>

      {compareIds.length >= 2 && (
        <PlayerCompare
          players={ranked.filter((p) => compareIds.includes(p.id))}
          adpKey={adpKey}
          onClose={() => setCompareIds([])}
          onRemove={(id) =>
            setCompareIds((prev) => {
              const next = prev.filter((x) => x !== id);
              return next.length < 2 ? [] : next;
            })
          }
        />
      )}
    </div>
  );
}

function Row({
  p,
  rank,
  adp,
  espnAdp,
  value,
  risk,
  trend,
  isDrafted,
  tierBreak,
  replBreak,
  onToggle,
  inCompare,
  onCompare,
}: {
  p: RankedPlayer;
  rank: number;
  adp: number | null;
  espnAdp: number | null;
  value: number | null;
  risk: number;
  trend: number;
  isDrafted: boolean;
  tierBreak: boolean;
  replBreak: boolean;
  onToggle: () => void;
  inCompare: boolean;
  onCompare: () => void;
}) {
  const riskColor =
    risk >= 7 ? "text-rose-400" : risk >= 4 ? "text-amber-400" : "text-emerald-400";
  return (
    <>
      {replBreak && (
        <tr>
          <td
            colSpan={11}
            className="border-y border-dashed border-zinc-600 bg-zinc-800/40 px-3 py-1 text-center text-[11px] font-semibold uppercase tracking-widest text-zinc-400"
          >
            ▼ Replacement level · replacement band starts here
          </td>
        </tr>
      )}
      {tierBreak && !replBreak && (
        <tr>
          <td
            colSpan={11}
            className="bg-zinc-950 px-3 py-0.5 text-[10px] uppercase tracking-widest text-zinc-700"
          >
            — {p.position} · Tier {p.tier} —
          </td>
        </tr>
      )}
      <tr
        className={`border-t border-zinc-800/60 transition ${
          isDrafted ? "opacity-40" : "hover:bg-zinc-900/40"
        }`}
      >
        <td className="px-3 py-2 text-zinc-500 tabular-nums">{rank}</td>
        <td className="px-3 py-2">
          <div className={`font-medium text-zinc-100 ${isDrafted ? "line-through" : ""}`}>
            {p.name}
            {trend > 2 && (
              <span className="ml-1 text-[11px] text-emerald-400" title="Rising ADP">↑</span>
            )}
            {trend < -2 && (
              <span className="ml-1 text-[11px] text-rose-400" title="Falling ADP">↓</span>
            )}
          </div>
          <div className="text-xs text-zinc-500">
            {p.team ?? "FA"}
            {p.bye ? ` · Bye ${p.bye}` : ""}
            {p.yearsExp === 0 ? (
              <span className="text-amber-400/70"> · Rookie</span>
            ) : p.yearsExp !== null ? (
              <span className="text-zinc-600"> · Yr {p.yearsExp + 1}</span>
            ) : null}
            {p.injuryStatus ? (
              <span className="ml-1 text-amber-500">
                {[
                  p.injuryStatus,
                  p.injuryBody && p.injuryBody !== "Undisclosed" ? p.injuryBody : null,
                  p.injuryNotes,
                ].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </div>
        </td>
        <td className="px-2 py-2 text-center">
          <span
            className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold ${POS_BADGE[p.position]}`}
          >
            {p.position}
          </span>
        </td>
        <td className="px-2 py-2 text-center">
          <span
            className="inline-block h-5 w-5 rounded text-xs font-bold leading-5"
            style={{ color: tierColor(p.tier), backgroundColor: `${tierColor(p.tier)}1f` }}
          >
            {p.tier}
          </span>
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-zinc-200">
          {p.points.toFixed(1)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {p.actualPts2025 != null
            ? <span className="text-zinc-400">{p.actualPts2025.toFixed(1)}</span>
            : <span className="text-zinc-600">—</span>}
        </td>
        <td
          className={`px-3 py-2 text-right tabular-nums font-medium ${
            p.vbd > 0 ? "text-emerald-400" : "text-zinc-500"
          }`}
        >
          {p.vbd > 0 ? "+" : ""}
          {p.vbd.toFixed(1)}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          <div className="text-zinc-400">
            {adp !== null ? adp.toFixed(1) : "—"}
          </div>
          {espnAdp !== null && (
            <div className="text-[11px] text-zinc-600">
              {espnAdp.toFixed(1)}
            </div>
          )}
        </td>
        <td
          className={`px-3 py-2 text-right tabular-nums font-medium ${
            value === null
              ? "text-zinc-700"
              : value > 1
              ? "text-emerald-400"
              : value < -1
              ? "text-rose-400"
              : "text-zinc-500"
          }`}
        >
          {value === null
            ? "—"
            : value > 1
            ? `+${value.toFixed(1)}`
            : value < -1
            ? value.toFixed(1)
            : "~0"}
        </td>
        <td className={`px-3 py-2 text-center tabular-nums font-semibold ${riskColor}`}>
          {risk}
        </td>
        <td className="px-2 py-2 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <button
              onClick={onToggle}
              className={`rounded-md border px-2 py-1 text-xs transition ${
                isDrafted
                  ? "border-zinc-700 text-zinc-500 hover:text-zinc-300"
                  : "border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
              }`}
            >
              {isDrafted ? "Undo" : "Draft"}
            </button>
            <button
              onClick={onCompare}
              title={inCompare ? "Remove from compare" : "Add to compare"}
              className={`text-base leading-none transition ${
                inCompare ? "text-sky-400" : "text-zinc-600 hover:text-sky-400"
              }`}
            >
              ⊕
            </button>
          </div>
        </td>
      </tr>
    </>
  );
}
