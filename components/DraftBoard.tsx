"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type { Player, Position, RankedPlayer } from "@/lib/types";
import { POSITIONS, ALL_POSITIONS } from "@/lib/types";
import {
  rankPlayers,
  BASELINE_LABELS,
  type BaselineMethod,
  type Baselines,
} from "@/lib/vbd";
import { adpKeyFor, DEFAULT_ROSTER, DEFAULT_SCORING } from "@/lib/presets";
import { SEASON } from "@/lib/sleeper";
import { POS_BADGE, POS_DOT } from "@/lib/ui";
import { useLocalStorage } from "./useLocalStorage";
import ConfigPanel from "./ConfigPanel";
import { marketReference, valueVsMarket } from "@/lib/market";
import { assessRisk } from "@/lib/risk";
import { fantasyPointsForStats } from "@/lib/scoring";
import { annotationKey, EMPTY_ANNOTATION, updateAnnotation, type AnnotationStore, type PlayerAnnotation } from "@/lib/annotations";
import {
  validRoster,
  validScoring,
  validDraftedIds,
  validBaselineMethod,
  validAnnotationStore,
  validAdpSnapshot,
  type AdpSnapshot,
} from "@/lib/validation";
import PlayerCompare from "./PlayerCompare";

type Filter = "ALL" | Position;
type SortKey = "rank" | "proj" | "vor" | "adp" | "value" | "risk";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Typing a note updates the input's local state immediately (so it feels
// responsive) but only commits to the shared annotation store after a short
// pause in typing — every commit re-renders the table via `annotations` and
// re-serializes the WHOLE store to localStorage (see useLocalStorage), so
// batching keystrokes into one write instead of one per key is the point.
const NOTE_COMMIT_DEBOUNCE_MS = 300;

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

function SortTh({
  label, sk, sortKey, sortDir, onSort, className, subLabel,
}: {
  label: string; sk: SortKey; sortKey: SortKey; sortDir: 1 | -1;
  onSort: (key: SortKey) => void; className?: string; subLabel?: string;
}) {
  const active = sortKey === sk;
  return (
    <th aria-sort={active ? (sortDir === 1 ? "ascending" : "descending") : "none"} className={`select-none px-3 py-2 font-medium ${active ? "text-emerald-400" : "text-zinc-500"} ${className ?? ""}`}>
      <button type="button" onClick={() => onSort(sk)} className="rounded px-1 transition hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-400">
        {label}{subLabel && <span className="ml-1 font-normal text-zinc-600">{subLabel}</span>}
        <span className="ml-0.5 text-[10px]">{active ? sortDir === 1 ? " ↑" : " ↓" : <span className="text-zinc-700"> ⇅</span>}</span>
      </button>
    </th>
  );
}

export default function DraftBoard() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [season, setSeason] = useState<string>("");

  const [scoring, setScoring, , scoringError] = useLocalStorage("ffdp.scoring", DEFAULT_SCORING, validScoring);
  const [roster, setRoster, , rosterError] = useLocalStorage("ffdp.roster", DEFAULT_ROSTER, validRoster);
  const [method, setMethod, , methodError] = useLocalStorage<BaselineMethod>("ffdp.method", "VOLS", validBaselineMethod);
  const [drafted, setDrafted, , draftedError] = useLocalStorage<string[]>("ffdp.drafted", [], validDraftedIds);
  const [snapshot, setSnapshot, snapshotHydrated, snapshotError] = useLocalStorage<AdpSnapshot | null>(
    "ffdp.adp-snapshot",
    null,
    validAdpSnapshot,
  );
  const [annotations, setAnnotations, , annotationsError] = useLocalStorage<AnnotationStore>("ffdp.annotations", {}, validAnnotationStore);

  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [hideDrafted, setHideDrafted] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [dismissedStorageNotice, setDismissedStorageNotice] = useState(false);

  const storageErrors = useMemo(
    () =>
      (
        [
          ["Scoring settings", scoringError],
          ["Roster settings", rosterError],
          ["Ranking method", methodError],
          ["Drafted players", draftedError],
          ["ADP trend snapshot", snapshotError],
          ["Player notes", annotationsError],
        ] as [string, string | null][]
      ).filter((entry): entry is [string, string] => entry[1] !== null),
    [scoringError, rosterError, methodError, draftedError, snapshotError, annotationsError]
  );

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
      // Still fresh AND seeded under the currently-active adpKey AND season →
      // keep it. A missing/mismatched adpKey (format switch, or a snapshot
      // from before this field existed) or a missing/mismatched season (a
      // snapshot left over from a prior season — same format, stale
      // consensus numbers) both count as a mismatch and force a rebuild.
      if (prev && prev.adpKey === adpKey && prev.season === SEASON && now - prev.ts <= SEVEN_DAYS_MS) return prev;
      // Build a new baseline from the current consensus ADP.
      const data: Record<string, number> = {};
      for (const p of players) {
        const market = marketReference(p, scoring, roster);
        if (market.consensus !== null) data[p.id] = market.consensus;
      }
      return { ts: now, data, adpKey, season: SEASON };
    });
  }, [players, snapshotHydrated, adpKey, setSnapshot, scoring, roster]);

  // Map player_id → trend delta (positive = rising, negative = falling).
  // Only populated when a fresh snapshot exists from a prior load — the
  // seeding effect above rebuilds `snapshot` as soon as it's stale (or from a
  // mismatched adpKey), so `snapshot` itself is the freshness signal; reading
  // Date.now() again here would be an impure call during render.
  const trendMap = useMemo<Record<string, number>>(() => {
    if (!players || !snapshot || !snapshotHydrated) return {};
    // Snapshot was seeded under a different adpKey (format switch, or an old
    // snapshot from before adpKey was tracked) or a different season (a
    // snapshot left over from a prior season, or from before season was
    // tracked) — its ADP values aren't comparable to the current consensus,
    // so bail out rather than show bogus trend arrows. The seeding effect
    // above will rebuild it shortly.
    if (snapshot.adpKey !== adpKey || snapshot.season !== SEASON) return {};
    const map: Record<string, number> = {};
    for (const p of players) {
      const snapAdp = snapshot.data[p.id];
      if (snapAdp === undefined) continue;
      const currentConsensus = marketReference(p, scoring, roster).consensus;
      if (currentConsensus === null) continue;
      // Positive → snapshotAdp was higher → player is now drafted earlier → rising
      map[p.id] = snapAdp - currentConsensus;
    }
    return map;
  }, [players, snapshot, snapshotHydrated, adpKey, scoring, roster]);

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
          const va = marketReference(a, scoring, roster).consensus;
          const vb = marketReference(b, scoring, roster).consensus;
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
        case "value": {
          // Returns null for K/DEF (their overallRank is forced to the bottom
          // of the board by design, see rankPlayers in lib/vbd.ts, so ADP
          // minus overallRank would be a huge, meaningless negative number)
          // and for players with no consensus ADP data.
          const va = valueVsMarket(a, scoring, roster);
          const vb = valueVsMarket(b, scoring, roster);
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
        case "risk":
          return (assessRisk(a).score - assessRisk(b).score) * sortDir;
        default:
          return 0;
      }
    });

    return hideDrafted ? sorted.filter((p) => !draftedSet.has(p.id)) : sorted;
  }, [ranked, filter, query, hideDrafted, draftedSet, sortKey, sortDir, scoring, roster]);

  // useCallback (not a plain closure) so this reference is stable across
  // DraftBoard renders — setDrafted itself is a stable useState setter, so
  // the only dependency never changes. Passed straight through to the
  // memoized Row below; a fresh closure every render would defeat that memo
  // for every row, every render.
  const toggleDrafted = useCallback(
    (id: string) =>
      setDrafted((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      ),
    [setDrafted]
  );

  // Toggle a player in/out of the compare panel (max 3).
  // When a removal would leave fewer than 2 players, clear the list (closes modal).
  // useCallback for the same identity-stability reason as toggleDrafted above.
  const toggleCompare = useCallback(
    (id: string) =>
      setCompareIds((prev) => {
        if (prev.includes(id)) {
          const next = prev.filter((x) => x !== id);
          return next.length < 2 ? [] : next;
        }
        if (prev.length >= 3) return prev;
        return [...prev, id];
      }),
    [setCompareIds]
  );

  // Same identity-stability reasoning: setAnnotations is a stable useState
  // setter, so this callback never changes reference, so passing it to every
  // Row never defeats React.memo.
  const handleAnnotation = useCallback(
    (id: string, patch: Partial<PlayerAnnotation>) =>
      setAnnotations((prev) => updateAnnotation(prev, SEASON, id, patch)),
    [setAnnotations]
  );

  // Tier dividers and replacement line only make sense on the default rank sort.
  const isRankSort = sortKey === "rank" && sortDir === 1;
  const replRank =
    filter !== "ALL" && !query.trim() && isRankSort && baselines
      ? baselines[filter].rank
      : null;

  // Per-row derived values (market reference, value-vs-market, risk, tier/
  // replacement dividers), hoisted out of the JSX map and memoized. These
  // used to be recomputed for every one of ~1000 rows on *every* DraftBoard
  // render — including a render triggered by editing a single row's note,
  // since that inline `rows.map(...)` in JSX ran unconditionally regardless
  // of whether `rows` itself had changed. `annotations` is deliberately not
  // a dependency here (same as it isn't for `rows`), so an annotation-only
  // re-render is a cache hit and does zero per-row work.
  const rowData = useMemo(
    () =>
      rows.map((p, i) => {
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
        const market = marketReference(p, scoring, roster);
        // valueVsMarket returns null for K/DEF (forced to the bottom of the
        // board by design, see rankPlayers in lib/vbd.ts) and for players
        // with no consensus ADP data.
        const value = valueVsMarket(p, scoring, roster);
        const risk = assessRisk(p);
        return {
          p,
          rank: filter === "ALL" ? p.overallRank : p.posRank,
          adp: market.sleeper,
          espnAdp: market.espn,
          value,
          risk: risk.score,
          riskExplanation: `${risk.factors.join("; ")} · ${risk.confidence} confidence estimate`,
          actualPoints: p.actualStats2025 ? fantasyPointsForStats(p.position, p.actualStats2025, scoring) : null,
          trend: trendMap[p.id] ?? 0,
          isDrafted: draftedSet.has(p.id),
          tierBreak,
          replBreak,
        };
      }),
    [rows, filter, query, isRankSort, replRank, scoring, roster, trendMap, draftedSet]
  );

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
        {storageErrors.length > 0 && !dismissedStorageNotice && (
          <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
            <div>
              <p className="font-medium">Some saved data couldn&apos;t be loaded and was reset:</p>
              <ul className="mt-1 list-disc pl-5 text-amber-300/90">
                {storageErrors.map(([label, message]) => (
                  <li key={label}>
                    {label}: {message}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-amber-300/70">
                The original saved value(s) were kept in a backup key (same name plus &quot;.corrupt&quot;) in case you need to recover them.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDismissedStorageNotice(true)}
              className="shrink-0 rounded px-2 py-1 text-xs text-amber-300 underline hover:text-amber-100"
            >
              Dismiss
            </button>
          </div>
        )}

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
          <div className="overflow-x-auto rounded-xl border border-zinc-800" tabIndex={0} aria-label="Draft rankings table">
            <table className="min-w-[940px] w-full text-sm">
              <thead className="bg-zinc-900/80 text-xs uppercase tracking-wide">
                <tr>
                  <SortTh label="#" sk="rank" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-left" />
                  <th className="px-3 py-2 text-left font-medium text-zinc-500">Player</th>
                  <th className="px-2 py-2 text-center font-medium text-zinc-500">Pos</th>
                  <th className="px-2 py-2 text-center font-medium text-zinc-500">Tier</th>
                  <SortTh label="Proj" sk="proj" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-right" />
                  <th
                    className="px-3 py-2 text-right font-medium text-zinc-500"
                    title="2025 season total, scored under your active scoring settings"
                  >
                    2025
                  </th>
                  <SortTh label="VOR" sk="vor" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortTh label="ADP" sk="adp" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-right" subLabel={adpKey === "ppr" ? "SL·ESPN" : "Sleeper"} />
                  <SortTh label="Val" sk="value" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-right" />
                  <SortTh label="Risk" sk="risk" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-center" />
                  <th className="px-2 py-2 text-center font-medium text-zinc-500"></th>
                </tr>
              </thead>
              <tbody>
                {rowData.map((r) => (
                  <Row
                    key={r.p.id}
                    p={r.p}
                    rank={r.rank}
                    adp={r.adp}
                    espnAdp={r.espnAdp}
                    value={r.value}
                    risk={r.risk}
                    riskExplanation={r.riskExplanation}
                    actualPoints={r.actualPoints}
                    annotation={annotations[annotationKey(SEASON, r.p.id)] ?? EMPTY_ANNOTATION}
                    onAnnotation={handleAnnotation}
                    trend={r.trend}
                    isDrafted={r.isDrafted}
                    tierBreak={r.tierBreak}
                    replBreak={r.replBreak}
                    onToggle={toggleDrafted}
                    inCompare={compareIds.includes(r.p.id)}
                    onCompare={toggleCompare}
                  />
                ))}
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
          scoring={scoring}
          roster={roster}
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

// Memoized so that an annotation edit on ONE row (e.g. typing a note) doesn't
// re-render all ~1000 other rows. This only pays off because every prop
// passed in from DraftBoard is identity-stable across an annotation-only
// re-render:
//  - p: from the memoized `ranked`/`rows`/`rowData` chain, which doesn't
//    depend on `annotations` — same object reference.
//  - rank/adp/espnAdp/value/risk/riskExplanation/actualPoints/trend/
//    isDrafted/tierBreak/replBreak: primitives (or a string, which JS always
//    compares by value), sourced from the memoized `rowData` — same values.
//  - annotation: `annotations[key] ?? EMPTY_ANNOTATION`. EMPTY_ANNOTATION is
//    a module-level constant, so untouched rows always get that exact
//    reference. For a row that previously had a note, updateAnnotation
//    (lib/annotations.ts) does `{ ...store, [key]: next }` — every *other*
//    key's value is carried over unchanged, so only the edited row's
//    `annotation` object identity actually changes.
//  - onAnnotation/onToggle/onCompare: useCallback-wrapped in DraftBoard with
//    only stable useState setters as deps, so they never change reference.
// A plain inline arrow function or freshly-built object for any of these
// would defeat memo(); none of them are.
const Row = memo(function Row({
  p,
  rank,
  adp,
  espnAdp,
  value,
  risk,
  riskExplanation,
  actualPoints,
  annotation,
  onAnnotation,
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
  riskExplanation: string;
  actualPoints: number | null;
  annotation: PlayerAnnotation;
  onAnnotation: (id: string, patch: Partial<PlayerAnnotation>) => void;
  trend: number;
  isDrafted: boolean;
  tierBreak: boolean;
  replBreak: boolean;
  onToggle: (id: string) => void;
  inCompare: boolean;
  onCompare: (id: string) => void;
}) {
  const riskColor =
    risk >= 7 ? "text-rose-400" : risk >= 4 ? "text-amber-400" : "text-emerald-400";

  // Local buffer for the note text so typing feels instant even though the
  // commit to the shared annotation store is debounced (see
  // NOTE_COMMIT_DEBOUNCE_MS above — every commit re-serializes the WHOLE
  // annotation store to localStorage via useLocalStorage). Target/avoid
  // still commit immediately through `annotation` — they're infrequent
  // clicks, not the perf problem.
  const [localNote, setLocalNoteState] = useState(annotation.note);
  const localNoteRef = useRef(annotation.note);
  // Last note value *this row* itself sent to the store. Lets the sync
  // effect below tell "the store changed under us" (e.g. localStorage
  // hydration finishing after mount) apart from "the store just caught up
  // with what we typed" — only the former should overwrite an in-progress
  // local edit.
  const lastSentNoteRef = useRef(annotation.note);
  const noteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setLocalNote = (value: string) => {
    localNoteRef.current = value;
    setLocalNoteState(value);
  };

  useEffect(() => {
    if (annotation.note !== lastSentNoteRef.current) {
      lastSentNoteRef.current = annotation.note;
      setLocalNote(annotation.note);
    }
  }, [annotation.note]);

  const commitNote = () => {
    if (noteTimeoutRef.current !== null) {
      clearTimeout(noteTimeoutRef.current);
      noteTimeoutRef.current = null;
    }
    lastSentNoteRef.current = localNoteRef.current;
    onAnnotation(p.id, { note: localNoteRef.current });
  };

  // Flush a pending debounced write on unmount — e.g. the row scrolls out of
  // a filtered/searched view mid-keystroke — so the last keystrokes before
  // that aren't silently dropped.
  useEffect(() => {
    return () => {
      if (noteTimeoutRef.current !== null) commitNote();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount/unmount only; commitNote reads current values via refs
  }, []);

  function handleNoteChange(event: ChangeEvent<HTMLInputElement>) {
    const value = event.target.value;
    setLocalNote(value);
    if (noteTimeoutRef.current !== null) clearTimeout(noteTimeoutRef.current);
    noteTimeoutRef.current = setTimeout(commitNote, NOTE_COMMIT_DEBOUNCE_MS);
  }

  function handleNoteBlur() {
    if (noteTimeoutRef.current !== null) commitNote();
  }

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
          <div className="mt-1 flex max-w-md items-center gap-1">
            <button type="button" aria-pressed={annotation.target} onClick={() => onAnnotation(p.id, { target: !annotation.target })} className={`rounded border px-1.5 py-0.5 text-[10px] ${annotation.target ? "border-amber-400/50 text-amber-400" : "border-zinc-700 text-zinc-600"}`}>Target</button>
            <button type="button" aria-pressed={annotation.avoid} onClick={() => onAnnotation(p.id, { avoid: !annotation.avoid, target: annotation.avoid ? annotation.target : false })} className={`rounded border px-1.5 py-0.5 text-[10px] ${annotation.avoid ? "border-rose-400/50 text-rose-400" : "border-zinc-700 text-zinc-600"}`}>Avoid</button>
            <input aria-label={`Note for ${p.name}`} value={localNote} onChange={handleNoteChange} onBlur={handleNoteBlur} placeholder="Note…" className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 text-[10px] text-zinc-300 placeholder-zinc-700 focus:border-emerald-500 focus:outline-none" />
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
          {actualPoints != null
            ? <span className="text-zinc-400">{actualPoints.toFixed(1)}</span>
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
        <td title={riskExplanation} className={`px-3 py-2 text-center tabular-nums font-semibold ${riskColor}`}>
          {risk}
        </td>
        <td className="px-2 py-2 text-center">
          <div className="flex items-center justify-center gap-1.5">
            <button
              onClick={() => onToggle(p.id)}
              className={`rounded-md border px-2 py-1 text-xs transition ${
                isDrafted
                  ? "border-zinc-700 text-zinc-500 hover:text-zinc-300"
                  : "border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
              }`}
            >
              {isDrafted ? "Undo" : "Draft"}
            </button>
            <button
              onClick={() => onCompare(p.id)}
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
});
Row.displayName = "Row";
