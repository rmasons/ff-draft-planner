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
import { useLocalStorage } from "./useLocalStorage";
import ConfigPanel from "./ConfigPanel";

type Filter = "ALL" | Position;
type SortKey = "rank" | "proj" | "vor" | "adp" | "value";

const SORT_DEFAULTS: Record<SortKey, 1 | -1> = {
  rank: 1,   // asc: lower = better
  proj: -1,  // desc: more points = better
  vor: -1,   // desc: more VOR = better
  adp: 1,    // asc: earlier ADP = higher consensus value
  value: -1, // desc: bigger steal = better
};

const TIER_COLORS = [
  "#34d399", "#60a5fa", "#c084fc", "#fbbf24",
  "#fb7185", "#22d3ee", "#a3e635", "#f472b6",
];
const tierColor = (tier: number) => TIER_COLORS[(tier - 1) % TIER_COLORS.length];

const POS_BADGE: Record<Position, string> = {
  QB:  "bg-rose-500/15 text-rose-300 border-rose-500/30",
  RB:  "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  WR:  "bg-sky-500/15 text-sky-300 border-sky-500/30",
  TE:  "bg-amber-500/15 text-amber-300 border-amber-500/30",
  K:   "bg-violet-500/15 text-violet-300 border-violet-500/30",
  DEF: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};
const POS_DOT: Record<Position, string> = {
  QB:  "#fb7185",
  RB:  "#34d399",
  WR:  "#38bdf8",
  TE:  "#fbbf24",
  K:   "#a78bfa",
  DEF: "#fb923c",
};

export default function DraftBoard() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<string>("");

  const [scoring, setScoring] = useLocalStorage("ffdp.scoring", DEFAULT_SCORING);
  const [roster, setRoster] = useLocalStorage("ffdp.roster", DEFAULT_ROSTER);
  const [method, setMethod] = useLocalStorage<BaselineMethod>("ffdp.method", "VOLS");
  const [drafted, setDrafted] = useLocalStorage<string[]>("ffdp.drafted", []);

  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [hideDrafted, setHideDrafted] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

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

  const { ranked, baselines } = useMemo(() => {
    if (!players) return { ranked: [] as RankedPlayer[], baselines: null as Baselines | null };
    const res = rankPlayers(players, scoring, roster, method);
    return { ranked: res.players, baselines: res.baselines };
  }, [players, scoring, roster, method]);

  const draftedSet = useMemo(() => new Set(drafted), [drafted]);
  const adpKey = adpKeyFor(scoring, roster);

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
          const getVal = (p: RankedPlayer): number | null => {
            const sl = p.adp[adpKey] >= 999 ? null : p.adp[adpKey];
            const es = p.adp.espn >= 999 ? null : p.adp.espn;
            const srcs = [sl, es].filter((x): x is number => x !== null);
            if (!srcs.length) return null;
            const consensus = srcs.reduce((acc, n) => acc + n, 0) / srcs.length;
            return consensus - p.overallRank;
          };
          const va = getVal(a);
          const vb = getVal(b);
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
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

  // Tier dividers and replacement line only make sense on the default rank sort.
  const isRankSort = sortKey === "rank" && sortDir === 1;
  const showTierDividers = filter !== "ALL" && !query.trim() && isRankSort;
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
                  <SortTh label="VOR" sk="vor" className="text-right" />
                  <SortTh label="ADP" sk="adp" className="text-right" subLabel="SL·ESPN" />
                  <SortTh label="Value" sk="value" className="text-right" />
                  <th className="px-2 py-2 text-center font-medium text-zinc-500"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => {
                  const prev = rows[i - 1];
                  const tierBreak =
                    showTierDividers && (!prev || prev.tier !== p.tier);
                  const replBreak =
                    replRank !== null &&
                    p.posRank > replRank &&
                    (!prev || prev.posRank <= replRank);
                  const isDrafted = draftedSet.has(p.id);
                  const adpRaw = p.adp[adpKey];
                  const adpDisplay = adpRaw >= 999 ? null : adpRaw;
                  const espnAdp = p.adp.espn >= 999 ? null : p.adp.espn;
                  const adpSources = [adpDisplay, espnAdp].filter((x): x is number => x !== null);
                  const consensusAdp = adpSources.length > 0
                    ? adpSources.reduce((a, b) => a + b, 0) / adpSources.length
                    : null;
                  const value = consensusAdp !== null ? Math.round(consensusAdp - p.overallRank) : null;
                  return (
                    <Row
                      key={p.id}
                      p={p}
                      rank={filter === "ALL" ? p.overallRank : p.posRank}
                      adp={adpDisplay}
                      espnAdp={espnAdp}
                      value={value}
                      isDrafted={isDrafted}
                      tierBreak={tierBreak}
                      replBreak={replBreak}
                      onToggle={() => toggleDrafted(p.id)}
                    />
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-zinc-500">
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
    </div>
  );
}

function Row({
  p,
  rank,
  adp,
  espnAdp,
  value,
  isDrafted,
  tierBreak,
  replBreak,
  onToggle,
}: {
  p: RankedPlayer;
  rank: number;
  adp: number | null;
  espnAdp: number | null;
  value: number | null;
  isDrafted: boolean;
  tierBreak: boolean;
  replBreak: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      {replBreak && (
        <tr>
          <td
            colSpan={9}
            className="border-y border-dashed border-zinc-600 bg-zinc-800/40 px-3 py-1 text-center text-[11px] font-semibold uppercase tracking-widest text-zinc-400"
          >
            ▼ Replacement level · players below have negative VOR
          </td>
        </tr>
      )}
      {tierBreak && !replBreak && (
        <tr>
          <td
            colSpan={9}
            className="border-l-2 px-3 py-1 text-xs font-semibold uppercase tracking-wide"
            style={{
              color: tierColor(p.tier),
              borderColor: tierColor(p.tier),
              backgroundColor: `${tierColor(p.tier)}12`,
            }}
          >
            Tier {p.tier}
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
          </div>
          <div className="text-xs text-zinc-500">
            {p.team ?? "FA"}
            {p.bye ? ` · Bye ${p.bye}` : ""}
            {p.injuryStatus ? (
              <span className="ml-1 text-amber-500">{p.injuryStatus}</span>
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
              ? "text-zinc-600"
              : value >= 10
              ? "text-emerald-400"
              : value >= 1
              ? "text-emerald-500/70"
              : value <= -10
              ? "text-rose-400"
              : value <= -1
              ? "text-rose-500/70"
              : "text-zinc-500"
          }`}
        >
          {value === null ? "—" : value > 0 ? `+${value}` : String(value)}
        </td>
        <td className="px-2 py-2 text-center">
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
        </td>
      </tr>
    </>
  );
}
