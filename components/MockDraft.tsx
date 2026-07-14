"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Player, Position, RankedPlayer } from "@/lib/types";
import { ALL_POSITIONS } from "@/lib/types";
import { rankPlayers, type BaselineMethod } from "@/lib/vbd";
import { DEFAULT_ROSTER, DEFAULT_SCORING } from "@/lib/presets";
import { POS_BADGE, UNKNOWN_BADGE } from "@/lib/ui";
import { useLocalStorage } from "./useLocalStorage";
import DraftBoardGrid from "./DraftBoardGrid";
import ScarcityChart from "./ScarcityChart";
import { SEASON } from "@/lib/sleeper";
import { annotationKey, updateAnnotation, type AnnotationStore } from "@/lib/annotations";
import { validRoster, validScoring } from "@/lib/validation";
import { encodeStored, parseStored } from "@/lib/persistence";
import { marketReference } from "@/lib/market";
import {
  chooseCpuPick,
  gradeLetter,
  gradePick,
  keeperValue,
  ownerForPick,
  pickNumberForSlot,
  positionalRun,
  rosterSlots,
  seededRandom,
  survivalEstimate,
  transitionDraft,
} from "@/lib/draft";

interface MockPick {
  pickNumber: number;
  teamSlot: number;
  playerId: string;
  playerName?: string;
  playerPos?: string;
  isKeeper?: boolean;
}

interface TradedPick {
  round: number;
  originalSlot: number;
  currentSlot: number;
}

interface PendingKeeper {
  playerId: string;
  teamSlot: number;
  round: number;
}

interface SleeperDraft {
  type: string;
  sport: string;
  status: string;
  league_id?: string;
  settings?: { teams?: number; rounds?: number };
  draft_order?: Record<string, number> | null;
  slot_to_roster_id?: Record<string, number> | null;
}

interface SleeperPick {
  pick_no: number;
  draft_slot: number;
  player_id: string;
  is_keeper: true | null;
  metadata?: { first_name?: string; last_name?: string; position?: string };
}

type Filter = "ALL" | Position;
type SortKey = "rank" | "proj" | "vor" | "adp" | "value";

const SORT_DEFAULTS: Record<SortKey, 1 | -1> = {
  rank: 1, proj: -1, vor: -1, adp: 1, value: -1,
};

// POS_BADGE / UNKNOWN_BADGE now come from @/lib/ui (shared across screens).

const SLOT_ELIGIBLE: Record<string, string[]> = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  BN: ["QB", "RB", "WR", "TE", "K", "DEF"],
};
const SLOT_PRIORITY: Record<string, number> = {
  K: 0, DEF: 1, QB: 2, RB: 3, WR: 4, TE: 5,
  WRRB_FLEX: 6, REC_FLEX: 7, FLEX: 8, SUPER_FLEX: 9, BN: 10,
};
const SLOT_DISPLAY: Record<string, string> = {
  WRRB_FLEX: "FLEX", REC_FLEX: "FLEX", SUPER_FLEX: "SF",
};
const SHOW_SLOTS = new Set(Object.keys(SLOT_ELIGIBLE));

interface RosterSlot {
  label: string;
  slotType: string;
  pick: MockPick | null;
  player: RankedPlayer | undefined;
}

function assignRoster(
  rosterPositions: string[],
  myPicks: MockPick[],
  playerById: Map<string, RankedPlayer>
): RosterSlot[] {
  const avail = myPicks.map((pick, idx) => ({
    idx,
    pos: playerById.get(pick.playerId)?.position ?? pick.playerPos ?? "",
    pick,
  }));
  const used = new Set<number>();
  const assigned: Array<MockPick | null> = new Array(rosterPositions.length).fill(null);

  // Sort indices by restrictiveness so leftover players fall to bench
  const byPriority = rosterPositions
    .map((_, i) => i)
    .sort((a, b) =>
      (SLOT_PRIORITY[rosterPositions[a]] ?? 99) - (SLOT_PRIORITY[rosterPositions[b]] ?? 99)
    );
  for (const si of byPriority) {
    const eligible = new Set(SLOT_ELIGIBLE[rosterPositions[si]] ?? []);
    for (const av of avail) {
      if (!used.has(av.idx) && eligible.has(av.pos)) {
        assigned[si] = av.pick;
        used.add(av.idx);
        break;
      }
    }
  }

  // Number duplicate labels (RB1/RB2 etc.; single slots stay unnumbered)
  const labelCount: Record<string, number> = {};
  for (const s of rosterPositions) {
    const lbl = SLOT_DISPLAY[s] ?? s;
    labelCount[lbl] = (labelCount[lbl] ?? 0) + 1;
  }
  const labelSeq: Record<string, number> = {};
  return rosterPositions.map((slotType, i) => {
    const base = SLOT_DISPLAY[slotType] ?? slotType;
    labelSeq[base] = (labelSeq[base] ?? 0) + 1;
    const label = labelCount[base] > 1 ? `${base}${labelSeq[base]}` : base;
    const pick = assigned[i];
    return { label, slotType, pick, player: pick ? playerById.get(pick.playerId) : undefined };
  });
}

const DRAFT_SETUP_KEY = "ffdp.draft-setup";
const KEEPER_SETUP_KEY = "ffdp.pending-keepers";

function SortTh({
  label, sk, sortKey, sortDir, onSort, className,
}: {
  label: string; sk: SortKey; sortKey: SortKey; sortDir: 1 | -1;
  onSort: (k: SortKey) => void; className?: string;
}) {
  const active = sortKey === sk;
  return (
    <th aria-sort={active ? (sortDir === 1 ? "ascending" : "descending") : "none"} className={`select-none px-3 py-2 font-medium ${
        active ? "text-emerald-400" : "text-zinc-500"
      } ${className ?? ""}`}
    >
      <button type="button" onClick={() => onSort(sk)} className="rounded px-1 transition hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-400">
        {label}<span className="ml-0.5 text-[10px]">{active ? (sortDir === 1 ? " ↑" : " ↓") : <span className="text-zinc-700"> ⇅</span>}</span>
      </button>
    </th>
  );
}

export default function MockDraft({ onActiveChange }: { onActiveChange?: (active: boolean) => void }) {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [scoring] = useLocalStorage("ffdp.scoring", DEFAULT_SCORING, validScoring);
  const [roster] = useLocalStorage("ffdp.roster", DEFAULT_ROSTER, validRoster);
  const [method] = useLocalStorage<BaselineMethod>("ffdp.method", "VOLS");

  const [picks, setPicks] = useState<MockPick[]>([]);
  const [userSlot, setUserSlot] = useState(1);
  const [draftMode, setDraftMode] = useState<"cpu" | "manual" | "live">("cpu");
  const [draftStatus, sendDraftEvent] = useReducer(transitionDraft, "setup");
  const started = draftStatus === "running" || draftStatus === "syncing" || draftStatus === "stale" || draftStatus === "complete";

  // Sleeper username lookup
  const [sleeperUsername, setSleeperUsername] = useState("");
  const [sleeperUserId, setSleeperUserId] = useState<string | null>(null);
  const [userDrafts, setUserDrafts] = useState<{ draft_id: string; label: string }[]>([]);
  const [lookingUpUser, setLookingUpUser] = useState(false);
  const [userLookupError, setUserLookupError] = useState<string | null>(null);

  // Sleeper import
  const [draftId, setDraftId] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedTeams, setImportedTeams] = useState<number | null>(null);
  const [importedRounds, setImportedRounds] = useState<number | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [tradedPicks, setTradedPicks] = useState<TradedPick[]>([]);
  const [teamNames, setTeamNames] = useState<Record<number, string>>({});
  const [leagueRosterPositions, setLeagueRosterPositions] = useState<string[]>([]);

  // Keeper setup (for fresh mock drafts before start)
  const [pendingKeepers, setPendingKeepers] = useState<PendingKeeper[]>([]);
  const [keeperSearch, setKeeperSearch] = useState("");
  const [keeperPlayerId, setKeeperPlayerId] = useState<string | null>(null);
  const [keeperSlot, setKeeperSlot] = useState(1);
  const [keeperRound, setKeeperRound] = useState(1);

  // Export / copy state
  const [copiedRoster, setCopiedRoster] = useState(false);

  // View and filter state
  const [viewMode, setViewMode] = useState<"players" | "board" | "scarcity">("players");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [boardFilter, setBoardFilter] = useState<Filter>("ALL");
  const [annotations, setAnnotations] = useLocalStorage<AnnotationStore>("ffdp.annotations", {});
  const watchlist = useMemo(() => new Set(Object.entries(annotations).filter(([key, value]) => key.startsWith(`${SEASON}:`) && value.target).map(([key]) => key.slice(SEASON.length + 1))), [annotations]);

  // Supported live sync uses Sleeper's documented REST endpoints.
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "live" | "error" | "stale">("idle");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const pickingRef = useRef(false);

  // Restore import settings from sessionStorage on mount
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time sessionStorage hydration */
    const raw = sessionStorage.getItem(DRAFT_SETUP_KEY);
    if (raw) {
      try {
        const d = parseStored<Record<string, unknown>>(raw, {}).value as {
          draftId?: string; sleeperUsername?: string; sleeperUserId?: string; importedTeams?: number;
          importedRounds?: number; picks?: MockPick[]; userSlot?: number; tradedPicks?: TradedPick[];
          importSummary?: string; teamNames?: Record<number, string>; leagueRosterPositions?: string[];
        };
        if (d.draftId) setDraftId(d.draftId);
        if (d.sleeperUsername) setSleeperUsername(d.sleeperUsername);
        if (d.sleeperUserId) setSleeperUserId(d.sleeperUserId);
        if (d.importedTeams) setImportedTeams(d.importedTeams);
        if (d.importedRounds) setImportedRounds(d.importedRounds);
        if (d.picks?.length) setPicks(d.picks);
        if (d.userSlot) setUserSlot(d.userSlot);
        if (d.tradedPicks?.length) setTradedPicks(d.tradedPicks);
        if (d.importSummary) setImportSummary(d.importSummary);
        if (d.teamNames) setTeamNames(d.teamNames);
        if (d.leagueRosterPositions) setLeagueRosterPositions(d.leagueRosterPositions);
      } catch { /* ignore malformed storage */ }
    }
    const rawKeepers = sessionStorage.getItem(KEEPER_SETUP_KEY);
    if (rawKeepers) {
      try {
        const ks = parseStored<PendingKeeper[]>(rawKeepers, []).value;
        if (Array.isArray(ks)) setPendingKeepers(ks);
      } catch { /* ignore */ }
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // Persist manual keepers across tab switches
  useEffect(() => {
    if (pendingKeepers.length > 0) {
      sessionStorage.setItem(KEEPER_SETUP_KEY, encodeStored(pendingKeepers, SEASON));
    } else {
      sessionStorage.removeItem(KEEPER_SETUP_KEY);
    }
  }, [pendingKeepers]);

  // Fetch player projections
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
    return () => { cancelled = true; };
  }, []);

  // Keep the full rankPlayers() result (not just `.players`) so the
  // replacement-level baselines are available to pass down to ScarcityChart.
  // Calling with `players ?? []` (instead of an early-return null) keeps
  // `baselines` a real (if all-zero) Baselines object before players load,
  // so downstream code never has to null-check it.
  const rankResult = useMemo(
    () => rankPlayers(players ?? [], scoring, roster, method),
    [players, scoring, roster, method]
  );
  const ranked = rankResult.players;
  const baselines = rankResult.baselines;

  const numTeams = importedTeams ?? roster.teams;
  const numRounds =
    importedRounds ??
    Math.max(10, roster.qb + roster.rb + roster.wr + roster.te + roster.flex + roster.superflex + roster.bench + 2);

  // Which pick numbers are already filled (supports non-sequential keeper picks)
  const pickedNums = useMemo(() => new Set(picks.map((p) => p.pickNumber)), [picks]);

  // Next unfilled pick slot
  const currentPickNum = useMemo(() => {
    for (let n = 1; n <= numTeams * numRounds; n++) {
      if (!pickedNums.has(n)) return n;
    }
    return numTeams * numRounds + 1;
  }, [pickedNums, numTeams, numRounds]);

  const isDone = currentPickNum > numTeams * numRounds;

  // Report active state to parent (for tab-switch guard; only while draft is actively in progress)
  useEffect(() => {
    onActiveChange?.(started && !isDone);
  }, [started, isDone, onActiveChange]);

  const currentRound = isDone ? numRounds : Math.ceil(currentPickNum / numTeams);
  const tradeRecords = useMemo(() => tradedPicks.map((trade) => ({ round: trade.round, roster_id: trade.originalSlot, owner_id: trade.currentSlot })), [tradedPicks]);
  const currentTeamSlot = isDone ? null : ownerForPick(currentPickNum, numTeams, tradeRecords);
  // In live mode the user watches; no slot is ever "their turn"
  const isUserTurn = draftMode !== "live" && !isDone && (draftMode === "manual" || currentTeamSlot === userSlot);

  const teamLabel = (slot: number) => teamNames[slot] || `T${slot}`;

  const draftedIds = useMemo(() => new Set(picks.map((p) => p.playerId)), [picks]);

  const playerById = useMemo(() => {
    const m = new Map<string, RankedPlayer>();
    for (const p of ranked) m.set(p.id, p);
    return m;
  }, [ranked]);

  const rows = useMemo(() => {
    let list = ranked.filter((p) => !draftedIds.has(p.id));
    if (filter !== "ALL") list = list.filter((p) => p.position === filter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.team ?? "").toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      // Watchlisted players float to the top
      const aWatched = watchlist.has(a.id) ? 0 : 1;
      const bWatched = watchlist.has(b.id) ? 0 : 1;
      if (aWatched !== bWatched) return aWatched - bWatched;
      const aAvoid = annotations[annotationKey(SEASON, a.id)]?.avoid ? 1 : 0;
      const bAvoid = annotations[annotationKey(SEASON, b.id)]?.avoid ? 1 : 0;
      if (aAvoid !== bAvoid) return aAvoid - bAvoid;
      switch (sortKey) {
        case "rank": return (a.overallRank - b.overallRank) * sortDir;
        case "proj": return (a.points - b.points) * sortDir;
        case "vor": return (a.vbd - b.vbd) * sortDir;
        case "adp": {
          const va = marketReference(a, scoring, roster).consensus;
          const vb = marketReference(b, scoring, roster).consensus;
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
        case "value": {
          // "Value" = consensus ADP minus overall rank (higher = bigger steal).
          const val = (p: RankedPlayer): number | null => {
            const consensus = marketReference(p, scoring, roster).consensus;
            return consensus === null ? null : consensus - p.overallRank;
          };
          const va = val(a), vb = val(b);
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
        default: return 0;
      }
    });
  }, [ranked, draftedIds, filter, query, sortKey, sortDir, scoring, roster, watchlist, annotations]);

  // Compact available-player list for board view sidebar
  const boardAvailable = useMemo(() => {
    let list = ranked.filter((p) => !draftedIds.has(p.id));
    if (boardFilter !== "ALL") list = list.filter((p) => p.position === boardFilter);
    return list;
  }, [ranked, draftedIds, boardFilter]);

  const myPicks = useMemo(
    () => (draftMode === "cpu" ? picks.filter((p) => p.teamSlot === userSlot) : picks),
    [picks, draftMode, userSlot]
  );
  const myPlayers = useMemo(
    () => myPicks.map((pick) => ({ player: playerById.get(pick.playerId), pick })),
    [myPicks, playerById]
  );

  const draftGrade = useMemo(() => {
    if (!isDone || draftMode !== "cpu") return null;
    const graded = myPicks.flatMap((pick) => {
      // Keepers aren't a drafting decision (you didn't "win" the pick against
      // the market that round), so they don't count toward the grade.
      if (pick.isKeeper) return [];
      const player = playerById.get(pick.playerId);
      if (!player) return [];
      const market = marketReference(player, scoring, roster);
      const value = gradePick(market.consensus, pick.pickNumber);
      return value === null ? [] : [{ pick, player, value, marketAdp: market.consensus }];
    });
    if (graded.length === 0) return null;
    const avgValue = graded.reduce((a, b) => a + b.value, 0) / graded.length;
    const letter = gradeLetter(avgValue);
    const sorted = [...graded].sort((a, b) => b.value - a.value);
    return { letter, avgValue, sorted };
  }, [isDone, draftMode, myPicks, playerById, scoring, roster]);

  // Position availability counts for the draft strip
  const positionCounts = useMemo(
    () =>
      (["QB", "RB", "WR", "TE"] as Position[]).map((pos) => {
        const total = ranked.filter((p) => p.position === pos).length;
        const gone = ranked.filter((p) => p.position === pos && draftedIds.has(p.id)).length;
        return { pos, gone, left: total - gone, pctGone: total > 0 ? gone / total : 0 };
      }),
    [ranked, draftedIds]
  );

  // Structured roster view: only in CPU mode when a league was imported
  const myRosterSlots = useMemo((): RosterSlot[] | null => {
    if (!leagueRosterPositions.length || draftMode !== "cpu") return null;
    const slots = leagueRosterPositions.filter((p) => SHOW_SLOTS.has(p));
    return assignRoster(slots, myPicks, playerById);
  }, [leagueRosterPositions, myPicks, playerById, draftMode]);

  // Watchlist: remaining targets still on the board
  const watchlistRemaining = useMemo(
    () => [...watchlist].filter((id) => !draftedIds.has(id)).length,
    [watchlist, draftedIds]
  );

  // Unfilled starter slots (excludes bench). Only meaningful in CPU mode with a Sleeper import.
  const unfilledStarterSlots = useMemo((): RosterSlot[] => {
    if (!myRosterSlots) return [];
    return myRosterSlots.filter((s) => s.slotType !== "BN" && s.pick === null);
  }, [myRosterSlots]);

  // Best available pick suggestion, weighted by VOR. Requires roster structure from a Sleeper import.
  const bestPickSuggestion = useMemo((): { player: RankedPlayer; isBench: boolean } | null => {
    if (!isUserTurn || draftMode !== "cpu" || !myRosterSlots) return null;
    const available = ranked.filter((p) => !draftedIds.has(p.id) && !annotations[annotationKey(SEASON, p.id)]?.avoid);
    if (available.length === 0) return null;
    const byVor = [...available].sort((a, b) => b.vbd - a.vbd);

    if (unfilledStarterSlots.length > 0) {
      for (const player of byVor) {
        for (const slot of unfilledStarterSlots) {
          const eligible = SLOT_ELIGIBLE[slot.slotType] ?? [];
          if (eligible.includes(player.position)) {
            return { player, isBench: false };
          }
        }
      }
    }

    // All starters filled — suggest the highest-VOR bench pick
    return { player: byVor[0], isBench: true };
  }, [isUserTurn, draftMode, myRosterSlots, ranked, draftedIds, unfilledStarterSlots, annotations]);

  const recommendationContext = useMemo(() => {
    if (!bestPickSuggestion) return null;
    let nextPick = currentPickNum + 1;
    while (nextPick <= numTeams * numRounds && ownerForPick(nextPick, numTeams, tradeRecords) !== userSlot) nextPick++;
    const market = marketReference(bestPickSuggestion.player, scoring, roster);
    const survival = nextPick <= numTeams * numRounds ? survivalEstimate(market.consensus, currentPickNum, nextPick) : null;
    const nextAtPosition = ranked.find((player) => !draftedIds.has(player.id) && player.position === bestPickSuggestion.player.position && player.id !== bestPickSuggestion.player.id);
    const cliff = nextAtPosition ? Math.max(0, bestPickSuggestion.player.points - nextAtPosition.points) : 0;
    const runs = positionalRun(picks, playerById);
    const run = runs.find((item) => item.position === bestPickSuggestion.player.position);
    const score = bestPickSuggestion.player.vbd + cliff * 0.75 + (survival === null ? 0 : (1 - survival) * 8) + (run ? 2 : 0);
    return { nextPick, survival, cliff, run, score, marketLabel: market.label };
  }, [bestPickSuggestion, currentPickNum, numTeams, numRounds, tradeRecords, userSlot, scoring, roster, ranked, draftedIds, picks, playerById]);

  // Keeper search results (setup screen only)
  const keeperSearchResults = useMemo(() => {
    if (!keeperSearch.trim() || keeperPlayerId) return [] as RankedPlayer[];
    const q = keeperSearch.toLowerCase();
    const keeperIds = new Set(pendingKeepers.map((k) => k.playerId));
    return ranked
      .filter(
        (p) =>
          !draftedIds.has(p.id) &&
          !keeperIds.has(p.id) &&
          (p.name.toLowerCase().includes(q) || (p.team ?? "").toLowerCase().includes(q))
      )
      .slice(0, 8);
  }, [ranked, keeperSearch, keeperPlayerId, pendingKeepers, draftedIds]);

  // Keeper value analysis (setup screen only)
  const keeperAnalysis = useMemo(() => {
    if (pendingKeepers.length === 0 || ranked.length === 0) return [];
    return pendingKeepers.map((k) => {
      const player = playerById.get(k.playerId);
      const consensusAdp = player ? marketReference(player, scoring, roster).consensus : null;
      const { pickEquivalent, surplus } = keeperValue(k.round, k.teamSlot, numTeams, consensusAdp);
      let verdict: "keep" | "borderline" | "cut" | null = null;
      if (surplus !== null) {
        if (surplus > 8) verdict = "keep";
        else if (surplus >= 0) verdict = "borderline";
        else verdict = "cut";
      }
      return { keeper: k, player, pickEquivalent, consensusAdp, surplus, verdict };
    });
  }, [pendingKeepers, ranked, playerById, numTeams, scoring, roster]);

  // CPU auto-pick: market-aware, roster-valid, need-aware, and reproducible.
  useEffect(() => {
    if (!started || draftMode !== "cpu" || isUserTurn || isDone || ranked.length === 0) return;
    const timer = setTimeout(() => {
      const available = ranked.filter((p) => !draftedIds.has(p.id) && !annotations[annotationKey(SEASON, p.id)]?.avoid);
      if (available.length === 0 || currentTeamSlot === null) return;

      const teamPlayers = picks.filter((pick) => pick.teamSlot === currentTeamSlot).flatMap((pick) => {
        const player = playerById.get(pick.playerId);
        return player ? [{ id: player.id, position: player.position }] : [];
      });
      const configuredSlots = rosterSlots(roster);
      const best = chooseCpuPick(available, teamPlayers, configuredSlots, (player) => marketReference(player, scoring, roster).consensus, seededRandom(currentPickNum * 1009 + currentTeamSlot));

      if (best) {
        setPicks((prev) => [
          ...prev,
          { pickNumber: currentPickNum, teamSlot: currentTeamSlot, playerId: best.id },
        ]);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [
    started, draftMode, isUserTurn, isDone, ranked, draftedIds,
    currentTeamSlot, currentPickNum, picks, playerById, roster, scoring, annotations,
  ]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [picks.length]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else { setSortKey(key); setSortDir(SORT_DEFAULTS[key]); }
  }

  function pickPlayer(playerId: string) {
    if (!started || !isUserTurn || isDone || currentTeamSlot === null) return;
    if (pickingRef.current) return;
    pickingRef.current = true;
    const teamSlot = draftMode === "manual" ? currentTeamSlot : userSlot;
    setPicks((prev) => {
      const taken = new Set(prev.map((p) => p.pickNumber));
      let pickNum = 1;
      while (taken.has(pickNum)) pickNum++;
      return [...prev, { pickNumber: pickNum, teamSlot, playerId }];
    });
    requestAnimationFrame(() => { pickingRef.current = false; });
  }

  function startDraft() {
    if (pendingKeepers.length > 0) {
      const keeperPicks: MockPick[] = pendingKeepers.map((k) => {
        const player = playerById.get(k.playerId);
        return {
          pickNumber: pickNumberForSlot(k.round, k.teamSlot, numTeams),
          teamSlot: k.teamSlot,
          playerId: k.playerId,
          playerName: player?.name,
          playerPos: player?.position,
          isKeeper: true as const,
        };
      });
      setPicks((prev) => {
        const merged = new Map(prev.map((p) => [p.pickNumber, p]));
        for (const kp of keeperPicks) merged.set(kp.pickNumber, kp);
        return [...merged.values()].sort((a, b) => a.pickNumber - b.pickNumber);
      });
    }
    sendDraftEvent({ type: "READY" });
    sendDraftEvent({ type: "START" });
  }

  function resetDraft() {
    setSyncStatus("idle");
    setSyncError(null);
    setLastSyncAt(null);
    setPicks([]);
    sendDraftEvent({ type: "RESET" });
    setFilter("ALL");
    setQuery("");
    setSortKey("rank");
    setSortDir(1);
    setImportedTeams(null);
    setImportedRounds(null);
    setImportSummary(null);
    setImportError(null);
    setDraftId("");
    setTradedPicks([]);
    setViewMode("players");
    setSleeperUserId(null);
    setUserDrafts([]);
    setUserLookupError(null);
    setPendingKeepers([]);
    setBoardFilter("ALL");
    setTeamNames({});
    setLeagueRosterPositions([]);
    sessionStorage.removeItem(DRAFT_SETUP_KEY);
    sessionStorage.removeItem(KEEPER_SETUP_KEY);
  }

  function exportCsv() {
    const header = "Pick,Round,Team,Player,Position,Team (NFL),Projected Points,VOR,Market ADP,Pick Value,Target,Avoid,Note";
    const escape = (s: string) =>
      s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;

    const sortedPicks = [...picks].sort((a, b) => a.pickNumber - b.pickNumber);
    const csvRows = sortedPicks.map((pick) => {
      const player = playerById.get(pick.playerId);
      const round = Math.ceil(pick.pickNumber / numTeams);
      const team = teamLabel(pick.teamSlot);
      const playerName = player?.name ?? pick.playerName ?? pick.playerId;
      const position = player?.position ?? pick.playerPos ?? "";
      const nflTeam = player?.team ?? "";
      const annotation = annotations[annotationKey(SEASON, pick.playerId)];
      const projPts = player ? player.points.toFixed(1) : "";
      const vor = player
        ? (player.vbd > 0 ? "+" : "") + player.vbd.toFixed(1)
        : "";

      let avgAdpStr = "";
      let valueStr = "";
      if (player) {
        const avg = marketReference(player, scoring, roster).consensus;
        if (avg !== null) {
          avgAdpStr = avg.toFixed(1);
          const val = avg - pick.pickNumber;
          valueStr = (val >= 0 ? "+" : "") + val.toFixed(1);
        }
      }

      return [
        pick.pickNumber,
        round,
        escape(team),
        escape(playerName),
        position,
        escape(nflTeam),
        projPts,
        vor,
        avgAdpStr,
        valueStr,
        annotation?.target ? "yes" : "",
        annotation?.avoid ? "yes" : "",
        escape(annotation?.note ?? ""),
      ].join(",");
    });

    const csv = [header, ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mock-draft-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function copyRoster() {
    const sortedMyPicks = [...myPicks].sort((a, b) => a.pickNumber - b.pickNumber);
    const lines = ["Your Draft Results:"];
    for (const pick of sortedMyPicks) {
      const player = playerById.get(pick.playerId);
      const name = player?.name ?? pick.playerName ?? pick.playerId;
      const pos = player?.position ?? pick.playerPos ?? "?";
      const round = Math.ceil(pick.pickNumber / numTeams);
      lines.push(`Rd ${round} (Pk ${pick.pickNumber}): ${name} — ${pos}`);
    }
    navigator.clipboard.writeText(lines.join("\n")).then(() => {
      setCopiedRoster(true);
      setTimeout(() => setCopiedRoster(false), 2000);
    });
  }

  function addKeeper() {
    if (!keeperPlayerId) return;
    const pickNum = pickNumberForSlot(keeperRound, keeperSlot, numTeams);
    if (pendingKeepers.some((k) => pickNumberForSlot(k.round, k.teamSlot, numTeams) === pickNum)) return;
    if (pendingKeepers.some((k) => k.playerId === keeperPlayerId)) return;
    setPendingKeepers((prev) => [
      ...prev,
      { playerId: keeperPlayerId, teamSlot: keeperSlot, round: keeperRound },
    ]);
    setKeeperSearch("");
    setKeeperPlayerId(null);
  }

  async function connectLiveDraft() {
    if (!draftId.trim()) return;
    setSyncStatus("syncing");
    setSyncError(null);
    try {
      await handleImport();
      setLastSyncAt(Date.now());
      setSyncStatus("live");
      sendDraftEvent({ type: "READY" });
      sendDraftEvent({ type: "SYNC" });
    } catch (error) {
      setSyncStatus("error");
      setSyncError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleLookupUser() {
    const uname = sleeperUsername.trim();
    if (!uname) return;
    setLookingUpUser(true);
    setUserLookupError(null);
    setUserDrafts([]);
    setSleeperUserId(null);
    try {
      const userRes = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(uname)}`);
      if (!userRes.ok) throw new Error(`User "${uname}" not found on Sleeper`);
      const user = await userRes.json();
      if (!user?.user_id) throw new Error(`User "${uname}" not found on Sleeper`);
      const userId: string = user.user_id;

      let draftsData: SleeperDraft[] | null = null;
      let season = SEASON;
      for (const s of [SEASON, String(Number(SEASON) - 1)]) {
        const r = await fetch(`https://api.sleeper.app/v1/user/${userId}/drafts/nfl/${s}`);
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d) && d.length > 0) { draftsData = d; season = s; break; }
        }
      }

      if (!draftsData || draftsData.length === 0) {
        throw new Error(`No NFL drafts found for "${uname}" in ${SEASON} or ${Number(SEASON) - 1}`);
      }

      const snakeDrafts = (
        draftsData as (SleeperDraft & { draft_id: string })[]
      ).filter((d) => d.type === "snake" && d.sport === "nfl");

      if (snakeDrafts.length === 0) {
        throw new Error(`No snake NFL drafts found for "${uname}" in ${season}`);
      }

      const draftList = snakeDrafts.map((d) => ({
        draft_id: d.draft_id,
        label: `${season} · ${d.settings?.teams ?? "?"}T / ${d.settings?.rounds ?? "?"}R · ${d.status}`,
      }));

      setSleeperUserId(userId);
      setUserDrafts(draftList);
      if (draftList.length === 1) setDraftId(draftList[0].draft_id);
    } catch (e) {
      setUserLookupError(e instanceof Error ? e.message : String(e));
    } finally {
      setLookingUpUser(false);
    }
  }

  async function handleImport() {
    const id = draftId.trim();
    if (!id) return;
    setImporting(true);
    setImportError(null);
    setImportSummary(null);
    try {
      const [draftRes, picksRes, tradedRes] = await Promise.all([
        fetch(`https://api.sleeper.app/v1/draft/${id}`),
        fetch(`https://api.sleeper.app/v1/draft/${id}/picks`),
        fetch(`https://api.sleeper.app/v1/draft/${id}/traded_picks`),
      ]);
      if (!draftRes.ok) throw new Error(`Draft not found (${draftRes.status})`);
      if (!picksRes.ok) throw new Error(`Could not fetch picks (${picksRes.status})`);

      const draft: SleeperDraft = await draftRes.json();
      const sleeperPicks: SleeperPick[] = await picksRes.json();
      const rawTradedPicks = tradedRes.ok ? await tradedRes.json() : [];

      // Fetch league details + team names in parallel (non-critical — silently ignored on failure)
      const slotToName: Record<number, string> = {};
      let rosterPositions: string[] = [];
      if (draft.league_id) {
        try {
          const leagueFetch = fetch(`https://api.sleeper.app/v1/league/${draft.league_id}`);
          const usersFetch = draft.draft_order
            ? fetch(`https://api.sleeper.app/v1/league/${draft.league_id}/users`)
            : null;
          const leagueRes = await leagueFetch;
          const usersRes = usersFetch ? await usersFetch : null;
          if (leagueRes.ok) {
            const league = await leagueRes.json();
            if (Array.isArray(league.roster_positions)) rosterPositions = league.roster_positions as string[];
          }
          if (usersRes?.ok && draft.draft_order) {
            const users: Array<{ user_id: string; display_name?: string; metadata?: { team_name?: string } }> = await usersRes.json();
            for (const u of users) {
              const slot = draft.draft_order![u.user_id];
              if (typeof slot === "number") slotToName[slot] = u.metadata?.team_name || u.display_name || "";
            }
          }
        } catch { /* non-critical */ }
      }

      if (draft.type !== "snake") throw new Error(`Only snake drafts are supported (got "${draft.type}")`);
      if (draft.sport !== "nfl") throw new Error(`Only NFL drafts are supported`);

      const teams: number = draft.settings?.teams ?? 12;
      const rounds: number = draft.settings?.rounds ?? 15;

      const imported: MockPick[] = sleeperPicks.map((sp) => ({
        pickNumber: sp.pick_no,
        teamSlot: sp.draft_slot,
        playerId: sp.player_id,
        playerName:
          sp.metadata?.first_name && sp.metadata?.last_name
            ? `${sp.metadata.first_name} ${sp.metadata.last_name}`
            : sp.player_id,
        playerPos: sp.metadata?.position ?? undefined,
        isKeeper: sp.is_keeper === true,
      }));

      // Determine user slot from draft_order
      let newUserSlot = userSlot;
      if (sleeperUserId && draft.draft_order) {
        const slot = draft.draft_order[sleeperUserId];
        if (typeof slot === "number") newUserSlot = slot;
      }

      // Parse traded picks
      const parsedTradedPicks: TradedPick[] = [];
      let tradedPickNote = "";
      if (Array.isArray(rawTradedPicks) && rawTradedPicks.length > 0) {
        const slotToRoster = draft.slot_to_roster_id;
        if (!slotToRoster) {
          tradedPickNote = " · traded picks unavailable (draft not fully configured)";
        } else {
          const rosterToSlot = new Map<number, number>();
          for (const [slotStr, rosterId] of Object.entries(slotToRoster)) {
            rosterToSlot.set(rosterId as number, Number(slotStr));
          }
          for (const tp of rawTradedPicks) {
            const origSlot = rosterToSlot.get(tp.roster_id);
            const currSlot = rosterToSlot.get(tp.owner_id);
            if (origSlot && currSlot && tp.round) {
              parsedTradedPicks.push({ round: tp.round, originalSlot: origSlot, currentSlot: currSlot });
            }
          }
        }
      }

      const keeperCount = imported.filter((p) => p.isKeeper).length;
      const statusLabel = draft.status === "complete" ? "complete" : draft.status === "drafting" ? "in progress" : "pre-draft";
      const keeperNote = keeperCount > 0 ? ` · ${keeperCount} keepers` : "";
      const summary = `Imported ${imported.length} picks from a ${teams}-team ${rounds}-round draft (${statusLabel}${keeperNote})${tradedPickNote}`;
      const ownershipRecords = parsedTradedPicks.map((trade) => ({ round: trade.round, roster_id: trade.originalSlot, owner_id: trade.currentSlot }));
      const ownedImported = imported.map((pick) => ({ ...pick, teamSlot: ownerForPick(pick.pickNumber, teams, ownershipRecords) }));

      setImportedTeams(teams);
      setImportedRounds(rounds);
      setPicks(ownedImported);
      setUserSlot(newUserSlot);
      setTradedPicks(parsedTradedPicks);
      setImportSummary(summary);
      setTeamNames(slotToName);
      setLeagueRosterPositions(rosterPositions);
      if (draftMode === "live") {
        setLastSyncAt(Date.now());
        setSyncStatus("live");
        setSyncError(null);
      }

      // Persist so tab switches don't lose the setup
      sessionStorage.setItem(
        DRAFT_SETUP_KEY,
        encodeStored({
          draftId: id,
          sleeperUsername,
          sleeperUserId,
          importedTeams: teams,
          importedRounds: rounds,
          picks: ownedImported,
          userSlot: newUserSlot,
          tradedPicks: parsedTradedPicks,
          importSummary: summary,
          teamNames: slotToName,
          leagueRosterPositions: rosterPositions,
        }, SEASON)
      );
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    if (!started || draftMode !== "live" || !draftId.trim() || isDone) return;
    let failures = 0;
    const poll = async () => {
      if (document.visibilityState !== "visible") return;
      setSyncStatus("syncing");
      try {
        const response = await fetch(`https://api.sleeper.app/v1/draft/${draftId.trim()}/picks`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Sleeper picks request failed (${response.status})`);
        const sleeperPicks: SleeperPick[] = await response.json();
        setPicks(sleeperPicks.map((sp) => ({
          pickNumber: sp.pick_no, teamSlot: ownerForPick(sp.pick_no, numTeams, tradeRecords), playerId: sp.player_id,
          playerName: sp.metadata?.first_name && sp.metadata?.last_name ? `${sp.metadata.first_name} ${sp.metadata.last_name}` : sp.player_id,
          playerPos: sp.metadata?.position, isKeeper: sp.is_keeper === true,
        })).sort((a, b) => a.pickNumber - b.pickNumber));
        failures = 0;
        setLastSyncAt(Date.now());
        setSyncError(null);
        setSyncStatus("live");
      } catch (error) {
        failures++;
        setSyncError(error instanceof Error ? error.message : String(error));
        setSyncStatus(failures > 1 ? "stale" : "error");
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 8000);
    return () => window.clearInterval(timer);
  }, [started, draftMode, draftId, isDone, numTeams, tradeRecords]);

  // ── Setup screen ──────────────────────────────────────────────────────────
  if (!started) {
    const importedKeepers = picks.filter((p) => p.isKeeper);
    const slotOptions = Array.from({ length: numTeams }, (_, i) => i + 1);
    const roundOptions = Array.from({ length: numRounds }, (_, i) => i + 1);

    return (
      <div className="flex items-start justify-center py-12">
        <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950/80 p-6">
          <h2 className="mb-1 text-lg font-semibold text-zinc-100">Mock Draft Setup</h2>
          <p className="mb-6 text-sm text-zinc-500">
            {numTeams} teams · {numRounds} rounds · snake order
          </p>

          {!players && !error && <p className="mb-4 text-sm text-zinc-500">Loading player data…</p>}
          {error && <p className="mb-4 text-sm text-rose-400">Failed to load players: {error}</p>}

          {/* Sleeper import */}
          <div className="mb-5">
            <label className="mb-1.5 block text-sm font-medium text-zinc-400">
              Import from Sleeper <span className="font-normal text-zinc-600">(optional)</span>
            </label>

            <div className="mb-2 flex gap-2">
              <input
                placeholder="Sleeper username"
                value={sleeperUsername}
                onChange={(e) => setSleeperUsername(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLookupUser()}
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none"
              />
              <button
                onClick={handleLookupUser}
                disabled={!sleeperUsername.trim() || lookingUpUser}
                className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
              >
                {lookingUpUser ? "…" : "Find"}
              </button>
            </div>
            {userLookupError && <p className="mb-1.5 text-xs text-rose-400">{userLookupError}</p>}

            {userDrafts.length > 1 && (
              <div className="mb-2">
                <select
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                >
                  <option value="">Select a draft…</option>
                  {userDrafts.map((d) => (
                    <option key={d.draft_id} value={d.draft_id}>{d.label}</option>
                  ))}
                </select>
              </div>
            )}

            {userDrafts.length === 0 && (
              <div className="mb-2 flex gap-2">
                <input
                  placeholder="or paste Draft ID directly…"
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleImport()}
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            )}

            <button
              onClick={handleImport}
              disabled={!draftId.trim() || importing}
              className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
            >
              {importing ? "Importing…" : "Import Draft"}
            </button>
            {importError && <p className="mt-1.5 text-xs text-rose-400">{importError}</p>}
            {importSummary && <p className="mt-1.5 text-xs text-emerald-400">{importSummary}</p>}
            <p className="mt-1.5 text-xs text-zinc-600">
              Enter your Sleeper username to find drafts, or paste a draft ID directly.
            </p>
          </div>

          {/* Keepers */}
          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-medium text-zinc-400">
              Keepers <span className="font-normal text-zinc-600">(optional)</span>
            </label>

            {/* Imported keepers from Sleeper (read-only) */}
            {importedKeepers.length > 0 ? (
              <div className="rounded-lg border border-zinc-700/50 bg-zinc-900/50 p-2">
                <p className="mb-1.5 text-xs text-zinc-500">{importedKeepers.length} keeper{importedKeepers.length !== 1 ? "s" : ""} from Sleeper import</p>
                <div className="space-y-0.5">
                  {importedKeepers.map((k) => {
                    const rd = Math.ceil(k.pickNumber / numTeams);
                    const player = playerById.get(k.playerId);
                    return (
                      <div key={k.pickNumber} className="flex items-center gap-2 text-xs">
                        <span className="shrink-0 text-zinc-600">Rd {rd} · {teamLabel(k.teamSlot)}</span>
                        <span className="truncate text-zinc-300">{player?.name ?? k.playerName ?? k.playerId}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* Manual keeper entry (fresh drafts) */
              <div>
                {pendingKeepers.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {pendingKeepers.map((k, i) => {
                      const player = playerById.get(k.playerId);
                      const pickNum = pickNumberForSlot(k.round, k.teamSlot, numTeams);
                      return (
                        <div key={i} className="flex items-center gap-2 rounded-lg border border-zinc-700/50 bg-zinc-900/50 px-3 py-1.5 text-xs">
                          <span className="shrink-0 text-zinc-500">Rd {k.round} · {teamLabel(k.teamSlot)} · #{pickNum}</span>
                          <span className="min-w-0 flex-1 truncate text-zinc-200">{player?.name ?? k.playerId}</span>
                          <button
                            onClick={() => setPendingKeepers((prev) => prev.filter((_, j) => j !== i))}
                            className="shrink-0 text-zinc-600 hover:text-zinc-400"
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="relative">
                  <div className="flex gap-1.5">
                    <input
                      placeholder="Search player…"
                      value={keeperSearch}
                      onChange={(e) => { setKeeperSearch(e.target.value); setKeeperPlayerId(null); }}
                      className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-emerald-500 focus:outline-none"
                    />
                    <select
                      value={keeperSlot}
                      onChange={(e) => setKeeperSlot(Number(e.target.value))}
                      className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                    >
                      {slotOptions.map((n) => <option key={n} value={n}>{teamLabel(n)}</option>)}
                    </select>
                    <select
                      value={keeperRound}
                      onChange={(e) => setKeeperRound(Number(e.target.value))}
                      className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                    >
                      {roundOptions.map((n) => <option key={n} value={n}>R{n}</option>)}
                    </select>
                    <button
                      onClick={addKeeper}
                      disabled={!keeperPlayerId}
                      className="shrink-0 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
                    >
                      Add
                    </button>
                  </div>

                  {keeperSearchResults.length > 0 && (
                    <div className="absolute left-0 right-16 top-full z-10 mt-1 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
                      {keeperSearchResults.map((p) => (
                        <button
                          key={p.id}
                          onClick={() => { setKeeperPlayerId(p.id); setKeeperSearch(p.name); }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-800"
                        >
                          <span className={`shrink-0 rounded border px-1 py-px text-[9px] font-bold ${POS_BADGE[p.position]}`}>{p.position}</span>
                          <span className="flex-1 truncate text-zinc-100">{p.name}</span>
                          <span className="shrink-0 text-xs text-zinc-500">{p.team ?? "FA"}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Keeper Value Analysis */}
          {keeperAnalysis.length > 0 && (
            <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
              <h3 className="mb-3 text-sm font-semibold text-zinc-300">Keeper Value Analysis</h3>
              <div className="space-y-2">
                {keeperAnalysis.map(({ keeper, player, pickEquivalent, consensusAdp, surplus, verdict }, i) => {
                  const pos = player?.position;
                  const badgeClass = pos && pos in POS_BADGE ? POS_BADGE[pos] : UNKNOWN_BADGE;
                  const verdictIcon = verdict === "keep" ? "🟢" : verdict === "borderline" ? "🟡" : "🔴";
                  const verdictLabel = verdict === "keep" ? "Keep" : verdict === "borderline" ? "Borderline" : "Cut";
                  return (
                    <div key={i} className="rounded-lg border border-zinc-700/50 bg-zinc-950/60 px-3 py-2.5">
                      <div className="mb-1.5 flex items-center gap-2">
                        {pos && (
                          <span className={`shrink-0 rounded border px-1 py-px text-[9px] font-bold ${badgeClass}`}>{pos}</span>
                        )}
                        <span className="font-medium text-zinc-100">{player?.name ?? keeper.playerId}</span>
                        {verdict && (
                          <span className="ml-auto flex items-center gap-1 text-xs font-medium">
                            {verdictIcon}{" "}
                            <span className={verdict === "keep" ? "text-emerald-400" : verdict === "borderline" ? "text-amber-400" : "text-rose-400"}>
                              {verdictLabel}
                            </span>
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
                        <span className="text-zinc-500">Keep cost</span>
                        <span className="text-zinc-300">Round {keeper.round}</span>
                        <span className="text-zinc-500">Pick equivalent</span>
                        <span className="text-zinc-300">#{pickEquivalent}</span>
                        <span className="text-zinc-500">ADP</span>
                        <span className="text-zinc-300">{consensusAdp !== null ? consensusAdp.toFixed(1) : "—"}</span>
                        <span className="text-zinc-500">ADP surplus</span>
                        <span className={surplus === null ? "text-zinc-500" : surplus > 0 ? "text-emerald-400" : "text-rose-400"}>
                          {surplus !== null
                            ? surplus > 0
                              ? `+${surplus.toFixed(1)} picks of value`
                              : `${surplus.toFixed(1)} picks`
                            : "—"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Draft mode */}
          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-medium text-zinc-400">Draft mode</label>
            <div className="flex rounded-lg border border-zinc-700 p-0.5">
              {(["cpu", "manual", "live"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setDraftMode(m)}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                    draftMode === m ? "bg-emerald-500 text-zinc-950" : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  {m === "cpu" ? "vs CPU" : m === "manual" ? "Manual" : "Live Sync"}
                </button>
              ))}
            </div>
            {draftMode === "live" && (
              <p className="mt-1.5 text-xs text-zinc-500">
                Polls Sleeper&apos;s documented REST draft endpoints every eight seconds while this page is visible.
              </p>
            )}
          </div>

          {draftMode === "cpu" && (
            <div className="mb-6">
              <label className="mb-1.5 block text-sm font-medium text-zinc-400">Your draft slot</label>
              <select
                value={userSlot}
                onChange={(e) => setUserSlot(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
              >
                {Array.from({ length: numTeams }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {teamNames[n] ? `${teamNames[n]} (Slot ${n})` : `Slot ${n} of ${numTeams}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          <p className="mb-4 text-xs text-zinc-600">
            Scoring and roster settings are pulled from your Cheat Sheet configuration.
          </p>

          {draftMode === "live" ? (
            <div>
              <div className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-xs text-amber-400/90">
                REST sync is read-only. The last good draft stays visible if Sleeper is temporarily unavailable.
              </div>
              <button
                onClick={connectLiveDraft}
                disabled={!draftId.trim() || !players || players.length === 0}
                className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
              >
                Start Live REST Sync
              </button>
              {syncError && <p className="mt-1.5 text-xs text-rose-400">{syncError}</p>}
            </div>
          ) : (
            <button
              onClick={startDraft}
              disabled={!players || players.length === 0}
              className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
            >
              {picks.length > 0
                ? `Continue Draft (${picks.length} picks already made)`
                : pendingKeepers.length > 0
                ? `Start Draft (${pendingKeepers.length} keeper${pendingKeepers.length !== 1 ? "s" : ""} set)`
                : "Start Mock Draft"}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Draft screen ──────────────────────────────────────────────────────────
  const colSpan = isUserTurn ? 8 : 7;

  return (
    <div className="flex flex-col gap-4">
      {/* Status bar */}
      <div
        className={`flex items-center gap-4 rounded-xl border px-4 py-3 ${
          isDone
            ? "border-zinc-700 bg-zinc-900/50"
            : isUserTurn
            ? "border-emerald-500/50 bg-emerald-500/10"
            : "border-zinc-800 bg-zinc-900/30"
        }`}
      >
        {isDone ? (
          <span className="font-semibold text-zinc-300">Draft complete — {numTeams * numRounds} picks made</span>
        ) : (
          <>
            <span className="text-sm text-zinc-500">
              Round {currentRound} · Pick {currentPickNum} of {numTeams * numRounds}
            </span>
            {draftMode === "live" ? (
              <span className="text-sm text-zinc-400">{teamLabel(currentTeamSlot!)} picking (watching live)</span>
            ) : draftMode === "manual" ? (
              <span className="font-semibold text-emerald-400">{teamLabel(currentTeamSlot!)} — click a player to pick</span>
            ) : isUserTurn ? (
              <span className="font-semibold text-emerald-400">⚡ YOU&apos;RE ON THE CLOCK — click a player to draft</span>
            ) : (
              <span className="text-sm text-zinc-400">{teamLabel(currentTeamSlot!)} picking…</span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {isDone && (
            <>
              <button
                onClick={exportCsv}
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-400 transition hover:text-zinc-200"
              >
                Export CSV
              </button>
              <button
                onClick={copyRoster}
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-400 transition hover:text-zinc-200"
              >
                {copiedRoster ? "Copied!" : "Copy Roster"}
              </button>
            </>
          )}
          {watchlistRemaining > 0 && (
            <span className="flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-400">
              ★ {watchlistRemaining} target{watchlistRemaining !== 1 ? "s" : ""}
            </span>
          )}
          {draftMode === "live" && (
            <span
              className={`flex items-center gap-1.5 text-xs font-medium ${
                syncStatus === "live"
                  ? "text-emerald-400"
                  : syncStatus === "syncing"
                  ? "text-amber-400"
                  : "text-rose-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  syncStatus === "live"
                    ? "bg-emerald-400 animate-pulse"
                    : syncStatus === "syncing"
                    ? "bg-amber-400 animate-pulse"
                    : "bg-rose-400"
                }`}
              />
              {syncStatus === "live"
                ? `Synced${lastSyncAt ? ` ${new Date(lastSyncAt).toLocaleTimeString()}` : ""}`
                : syncStatus === "syncing"
                ? "Syncing…"
                : syncStatus === "stale"
                ? "Stale — retrying"
                : syncStatus === "error"
                ? "Sync error"
                : "Not syncing"}
            </span>
          )}
          <div className="flex rounded-md border border-zinc-700 p-0.5">
            {(["players", "board", "scarcity"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setViewMode(v)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  viewMode === v ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {v === "players" ? "Players" : v === "board" ? "Board" : "Scarcity"}
              </button>
            ))}
          </div>
          <button
            onClick={resetDraft}
            className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-400 transition hover:text-zinc-200"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Position availability strip */}
      <div className="flex items-center gap-4 rounded-lg border border-zinc-800/50 bg-zinc-900/20 px-4 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-600">Available</span>
        <div className="flex items-center gap-4">
          {positionCounts.map(({ pos, gone, left, pctGone }) => (
            <div key={pos} className="flex items-center gap-1.5 text-xs">
              <span className={`rounded border px-1 py-px text-[9px] font-bold ${POS_BADGE[pos]}`}>{pos}</span>
              <span className={`tabular-nums font-medium ${pctGone >= 0.6 ? "text-amber-400" : "text-zinc-300"}`}>
                {left}
              </span>
              <span className="text-zinc-700">/ {gone + left}</span>
            </div>
          ))}
        </div>
        {!isDone && (
          <span className="ml-auto text-[10px] text-zinc-700">
            {picks.length} of {numTeams * numRounds} picks made
          </span>
        )}
      </div>

      {/* Draft grade panel (CPU mode only, shown after draft completes) */}
      {isDone && draftMode === "cpu" && draftGrade && (
        <div className="rounded-xl border border-zinc-700 bg-zinc-900/60 p-4">
          <div className="flex items-start gap-6">
            {/* Letter grade */}
            <div className="flex shrink-0 flex-col items-center">
              <span
                className={`text-6xl font-bold leading-none ${
                  draftGrade.letter === "A"
                    ? "text-emerald-400"
                    : draftGrade.letter === "B"
                    ? "text-sky-400"
                    : draftGrade.letter === "C"
                    ? "text-zinc-300"
                    : draftGrade.letter === "D"
                    ? "text-amber-400"
                    : "text-rose-400"
                }`}
              >
                {draftGrade.letter}
              </span>
              <span className="mt-1 text-xs font-medium text-zinc-500">Your Draft Grade</span>
            </div>

            {/* Summary + pick list */}
            <div className="min-w-0 flex-1">
              <p className="mb-3 text-sm text-zinc-400">
                Avg pick value:{" "}
                <span
                  className={
                    draftGrade.avgValue >= 0 ? "font-medium text-emerald-400" : "font-medium text-rose-400"
                  }
                >
                  {draftGrade.avgValue >= 0 ? "+" : ""}
                  {draftGrade.avgValue.toFixed(1)} picks{" "}
                  {draftGrade.avgValue >= 0 ? "later than ADP (steals)" : "earlier than ADP (reaches)"}
                </span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {draftGrade.sorted.map(({ pick, player, value }) => (
                  <div
                    key={pick.pickNumber}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-xs"
                  >
                    <span className="tabular-nums text-zinc-600">#{pick.pickNumber}</span>
                    <span
                      className={`shrink-0 rounded border px-1 py-px text-[9px] font-bold ${POS_BADGE[player.position]}`}
                    >
                      {player.position}
                    </span>
                    <span className="text-zinc-200">{player.name}</span>
                    <span
                      className={`tabular-nums font-medium ${
                        value >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {value >= 0 ? "+" : ""}
                      {value.toFixed(1)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main layout */}
      <div className="flex gap-4">
        {/* Left: board, player table, or scarcity chart */}
        {viewMode === "board" ? (
          <div className="min-w-0 flex-1 overflow-x-auto">
            <DraftBoardGrid
              picks={picks}
              tradedPicks={tradedPicks}
              numTeams={numTeams}
              numRounds={numRounds}
              userSlot={userSlot}
              currentPickNum={currentPickNum}
              playerById={playerById}
              draftMode={draftMode}
              teamNames={teamNames}
            />
          </div>
        ) : viewMode === "scarcity" ? (
          <div className="min-w-0 flex-1">
            <ScarcityChart
              ranked={ranked}
              draftedIds={draftedIds}
              numTeams={numTeams}
              numRounds={numRounds}
              currentPickNum={currentPickNum}
              baselines={baselines}
            />
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <div className="flex rounded-lg border border-zinc-800 p-0.5">
                {(["ALL", ...ALL_POSITIONS] as Filter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                      filter === f ? "bg-emerald-500 text-zinc-950" : "text-zinc-400 hover:text-zinc-100"
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
            </div>

            {/* Roster need indicator + best pick — CPU mode, user's turn, league imported */}
            {draftMode === "cpu" && isUserTurn && myRosterSlots && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {unfilledStarterSlots.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Need:</span>
                    {unfilledStarterSlots.map((slot, i) => {
                      const badgeClass =
                        slot.slotType in POS_BADGE
                          ? POS_BADGE[slot.slotType as Position]
                          : UNKNOWN_BADGE;
                      return (
                        <span
                          key={i}
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${badgeClass}`}
                        >
                          {slot.label}
                        </span>
                      );
                    })}
                  </div>
                )}
                {bestPickSuggestion && (
                  <button
                    onClick={() => pickPlayer(bestPickSuggestion.player.id)}
                    title={recommendationContext ? `${recommendationContext.marketLabel}; score ${recommendationContext.score.toFixed(1)} = VOR, tier cliff, next-pick scarcity, and run context` : undefined}
                    className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-1 text-xs transition hover:bg-emerald-500/15"
                  >
                    <span className="text-zinc-500">
                      {bestPickSuggestion.isBench ? "Bench Pick:" : "Best Pick:"}
                    </span>
                    <span className="font-medium text-zinc-100">{bestPickSuggestion.player.name}</span>
                    <span
                      className={`rounded border px-1 py-px text-[9px] font-bold ${POS_BADGE[bestPickSuggestion.player.position]}`}
                    >
                      {bestPickSuggestion.player.position}
                    </span>
                    <span
                      className={`tabular-nums font-medium ${
                        bestPickSuggestion.player.vbd > 0 ? "text-emerald-400" : "text-zinc-500"
                      }`}
                    >
                      {bestPickSuggestion.player.vbd > 0 ? "+" : ""}
                      {bestPickSuggestion.player.vbd.toFixed(1)}
                    </span>
                    {recommendationContext?.survival !== null && recommendationContext?.survival !== undefined && (
                      <span className="text-zinc-500">· {Math.round(recommendationContext.survival * 100)}% to #{recommendationContext.nextPick}</span>
                    )}
                    {recommendationContext && recommendationContext.cliff > 0 && <span className="text-amber-400">· cliff {recommendationContext.cliff.toFixed(1)}</span>}
                    {recommendationContext?.run && <span className="text-sky-400">· {recommendationContext.run.count}/{recommendationContext.run.window} run</span>}
                  </button>
                )}
              </div>
            )}

            <div className="overflow-x-auto rounded-xl border border-zinc-800" tabIndex={0} aria-label="Available players">
              <table className="min-w-[760px] w-full text-sm">
                <thead className="bg-zinc-900/80 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="w-8 px-2 py-2 text-center font-medium text-zinc-500">★</th>
                    <SortTh label="#" sk="rank" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-left" />
                    <th className="px-3 py-2 text-left font-medium text-zinc-500">Player</th>
                    <th className="px-2 py-2 text-center font-medium text-zinc-500">Pos</th>
                    <SortTh label="Proj" sk="proj" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-right" />
                    <SortTh label="VOR" sk="vor" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-right" />
                    <SortTh label="ADP" sk="adp" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} className="text-right" />
                    {isUserTurn && <th className="px-2 py-2 text-center font-medium text-zinc-500">Pick</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p, i) => {
                    const isWatched = watchlist.has(p.id);
                    return (
                    <tr
                      key={p.id}
                      onClick={() => pickPlayer(p.id)}
                      onKeyDown={(event) => {
                        if (isUserTurn && (event.key === "Enter" || event.key === " ")) {
                          event.preventDefault();
                          pickPlayer(p.id);
                        }
                      }}
                      tabIndex={isUserTurn ? 0 : -1}
                      aria-label={isUserTurn ? `Draft ${p.name}` : undefined}
                      className={`border-t border-zinc-800/60 transition ${
                        isUserTurn ? "cursor-pointer hover:bg-emerald-500/10" : "opacity-60"
                      } ${i === 0 && isUserTurn ? "bg-emerald-500/5" : ""} ${
                        isWatched ? "bg-amber-500/5" : ""
                      }`}
                    >
                      <td className={`px-2 py-2 text-center ${isWatched ? "border-l-2 border-amber-400/40" : ""}`}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setAnnotations((prev) => updateAnnotation(prev, SEASON, p.id, { target: !prev[annotationKey(SEASON, p.id)]?.target }));
                          }}
                          aria-label={isWatched ? `Remove ${p.name} from targets` : `Add ${p.name} to targets`}
                          className={`rounded text-base leading-none transition focus-visible:outline-2 focus-visible:outline-emerald-400 ${
                            isWatched ? "text-amber-400" : "text-zinc-600 hover:text-amber-400"
                          }`}
                        >
                          {isWatched ? "★" : "☆"}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-zinc-500 tabular-nums">{p.overallRank}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-zinc-100">{p.name}</div>
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
                        {annotations[annotationKey(SEASON, p.id)]?.note && (
                          <div className="max-w-xs truncate text-[10px] text-amber-300/70">
                            {annotations[annotationKey(SEASON, p.id)].note}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-semibold ${POS_BADGE[p.position]}`}>
                          {p.position}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-200">{p.points.toFixed(1)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums font-medium ${p.vbd > 0 ? "text-emerald-400" : "text-zinc-500"}`}>
                        {p.vbd > 0 ? "+" : ""}{p.vbd.toFixed(1)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                        {marketReference(p, scoring, roster).consensus?.toFixed(1) ?? "—"}
                      </td>
                      {isUserTurn && (
                        <td className="px-2 py-2 text-center">
                          <button
                            onClick={(e) => { e.stopPropagation(); pickPlayer(p.id); }}
                            className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs text-emerald-400 transition hover:bg-emerald-500/10"
                          >
                            Pick
                          </button>
                        </td>
                      )}
                    </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={colSpan} className="px-3 py-8 text-center text-zinc-500">
                        No players available.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Right sidebar — content differs by view mode */}
        {viewMode === "board" ? (
          /* Board sidebar: compact available players + roster */
          <div className="flex w-80 shrink-0 flex-col gap-3">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Available</h3>
                <div className="flex gap-0.5">
                  {(["ALL", "QB", "RB", "WR", "TE", "K", "DEF"] as Filter[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => setBoardFilter(f)}
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition ${
                        boardFilter === f ? "bg-zinc-700 text-zinc-100" : "text-zinc-600 hover:text-zinc-400"
                      }`}
                    >
                      {f === "ALL" ? "All" : f}
                    </button>
                  ))}
                </div>
              </div>
              <div className="max-h-[520px] space-y-px overflow-y-auto">
                {boardAvailable.slice(0, 50).map((p, i) => (
                  <div
                    key={p.id}
                    onClick={() => pickPlayer(p.id)}
                    className={`flex items-center gap-1.5 rounded px-2 py-1.5 text-xs transition ${
                      isUserTurn ? "cursor-pointer hover:bg-emerald-500/10" : "pointer-events-none opacity-50"
                    } ${i === 0 && isUserTurn ? "bg-emerald-500/5" : ""}`}
                  >
                    <span className="w-5 shrink-0 text-right tabular-nums text-zinc-600">{p.overallRank}</span>
                    <span className={`shrink-0 rounded border px-1 py-px text-[9px] font-bold ${POS_BADGE[p.position]}`}>
                      {p.position}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-zinc-200">{p.name}</span>
                    <span className={`shrink-0 tabular-nums text-[10px] ${p.vbd > 0 ? "text-emerald-400" : "text-zinc-500"}`}>
                      {p.vbd > 0 ? "+" : ""}{p.vbd.toFixed(0)}
                    </span>
                  </div>
                ))}
                {boardAvailable.length === 0 && (
                  <p className="py-4 text-center text-xs text-zinc-600">No players.</p>
                )}
              </div>
            </div>

            {/* Compact roster in board view */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {draftMode === "cpu" ? `Your Roster · ${teamLabel(userSlot)}` : "All Picks"}
              </h3>
              {myRosterSlots ? (
                <div className="space-y-px">
                  {myRosterSlots.map((slot, i) => {
                    const pos = (slot.player?.position ?? slot.pick?.playerPos) as Position | undefined;
                    const badgeClass = pos && pos in POS_BADGE ? POS_BADGE[pos] : UNKNOWN_BADGE;
                    return (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="w-8 shrink-0 text-right text-[10px] text-zinc-600">{slot.label}</span>
                        {slot.pick ? (
                          <>
                            {pos && <span className={`shrink-0 rounded border px-1 py-0.5 text-[10px] font-semibold ${badgeClass}`}>{pos}</span>}
                            <span className="truncate text-zinc-200">{slot.player?.name ?? slot.pick.playerName ?? slot.pick.playerId}</span>
                          </>
                        ) : (
                          <span className="text-[10px] text-zinc-800">—</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : myPlayers.length === 0 ? (
                <p className="text-xs text-zinc-600">No picks yet.</p>
              ) : (
                <div className="space-y-1">
                  {myPlayers.map(({ player, pick }, i) => {
                    const pos = player?.position ?? pick.playerPos;
                    const badgeClass = pos && pos in POS_BADGE ? POS_BADGE[pos as Position] : UNKNOWN_BADGE;
                    return (
                      <div key={pick.pickNumber} className="flex items-center gap-2 text-xs">
                        <span className="w-4 shrink-0 text-right text-zinc-600">{i + 1}.</span>
                        {pos && <span className={`shrink-0 rounded border px-1 py-0.5 text-[10px] font-semibold ${badgeClass}`}>{pos}</span>}
                        <span className="truncate text-zinc-200">{player?.name ?? pick.playerName ?? pick.playerId}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Players sidebar: roster + draft log */
          <div className="flex w-64 shrink-0 flex-col gap-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {draftMode === "cpu" ? `Your Roster · ${teamLabel(userSlot)}` : "All Picks"}
              </h3>
              {myRosterSlots ? (
                <div className="space-y-px">
                  {myRosterSlots.map((slot, i) => {
                    const pos = (slot.player?.position ?? slot.pick?.playerPos) as Position | undefined;
                    const badgeClass = pos && pos in POS_BADGE ? POS_BADGE[pos] : UNKNOWN_BADGE;
                    return (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <span className="w-8 shrink-0 text-right text-[10px] text-zinc-600">{slot.label}</span>
                        {slot.pick ? (
                          <>
                            {pos && <span className={`shrink-0 rounded border px-1 py-0.5 text-[10px] font-semibold ${badgeClass}`}>{pos}</span>}
                            <span className="truncate text-zinc-200">{slot.player?.name ?? slot.pick.playerName ?? slot.pick.playerId}</span>
                          </>
                        ) : (
                          <span className="text-[10px] text-zinc-800">—</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : myPlayers.length === 0 ? (
                <p className="text-xs text-zinc-600">No picks yet.</p>
              ) : (
                <div className="space-y-1">
                  {myPlayers.map(({ player, pick }, i) => {
                    const pos = player?.position ?? pick.playerPos;
                    const badgeClass = pos && pos in POS_BADGE ? POS_BADGE[pos as Position] : UNKNOWN_BADGE;
                    return (
                      <div key={pick.pickNumber} className="flex items-center gap-2 text-xs">
                        <span className="w-4 shrink-0 text-right text-zinc-600">{i + 1}.</span>
                        {pos && <span className={`shrink-0 rounded border px-1 py-0.5 text-[10px] font-semibold ${badgeClass}`}>{pos}</span>}
                        <span className="truncate text-zinc-200">{player?.name ?? pick.playerName ?? pick.playerId}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Draft Log</h3>
              <div ref={logRef} className="max-h-96 space-y-0.5 overflow-y-auto">
                {picks.length === 0 ? (
                  <p className="text-xs text-zinc-600">No picks yet.</p>
                ) : (
                  picks.map((pick) => {
                    const player = playerById.get(pick.playerId);
                    const isMe = draftMode === "cpu" && pick.teamSlot === userSlot;
                    const pos = player?.position ?? pick.playerPos;
                    const badgeClass = pos && pos in POS_BADGE ? POS_BADGE[pos as Position] : UNKNOWN_BADGE;
                    return (
                      <div
                        key={pick.pickNumber}
                        className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-xs ${isMe ? "bg-emerald-500/10" : ""}`}
                      >
                        <span className="w-5 shrink-0 text-right tabular-nums text-zinc-600">{pick.pickNumber}.</span>
                        <span className={`shrink-0 max-w-[80px] truncate ${isMe ? "font-medium text-emerald-400" : "text-zinc-500"}`}
                              title={!isMe ? teamLabel(pick.teamSlot) : undefined}>
                          {isMe ? "You" : teamLabel(pick.teamSlot)}
                        </span>
                        {pos && (
                          <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-semibold ${badgeClass}`}>{pos}</span>
                        )}
                        <span className={`truncate ${isMe ? "text-zinc-200" : "text-zinc-400"}`}>
                          {player?.name ?? pick.playerName ?? pick.playerId}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
