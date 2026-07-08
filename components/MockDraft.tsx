"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Player, Position, RankedPlayer } from "@/lib/types";
import { ALL_POSITIONS } from "@/lib/types";
import { rankPlayers, type BaselineMethod } from "@/lib/vbd";
import { adpKeyFor, DEFAULT_ROSTER, DEFAULT_SCORING } from "@/lib/presets";
import { useLocalStorage } from "./useLocalStorage";
import DraftBoardGrid from "./DraftBoardGrid";
import ScarcityChart from "./ScarcityChart";
import { SEASON } from "@/lib/sleeper";

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

const POS_BADGE: Record<Position, string> = {
  QB: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  RB: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  WR: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  TE: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  K: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  DEF: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};

const UNKNOWN_BADGE = "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";

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
// Snapshot of an in-progress draft (after "started" becomes true), so a
// refresh mid-draft doesn't throw away everything.
const ACTIVE_DRAFT_KEY = "ffdp.draft-active";

function teamSlotForPick(pickNum: number, numTeams: number): number {
  const round = Math.ceil(pickNum / numTeams);
  const pos = ((pickNum - 1) % numTeams) + 1;
  return round % 2 === 1 ? pos : numTeams + 1 - pos;
}

// Also used in DraftBoardGrid; kept here for keeper pick-number computation
function pickNumForCell(round: number, slot: number, numTeams: number): number {
  const base = (round - 1) * numTeams;
  return round % 2 === 1 ? base + slot : base + (numTeams + 1 - slot);
}

function SortTh({
  label, sk, sortKey, sortDir, onSort, className,
}: {
  label: string; sk: SortKey; sortKey: SortKey; sortDir: 1 | -1;
  onSort: (k: SortKey) => void; className?: string;
}) {
  const active = sortKey === sk;
  return (
    <th
      onClick={() => onSort(sk)}
      className={`cursor-pointer select-none px-3 py-2 font-medium transition hover:text-zinc-200 ${
        active ? "text-emerald-400" : "text-zinc-500"
      } ${className ?? ""}`}
    >
      {label}
      <span className="ml-0.5 text-[10px]">
        {active ? (sortDir === 1 ? " ↑" : " ↓") : <span className="text-zinc-700"> ⇅</span>}
      </span>
    </th>
  );
}

export default function MockDraft({ onActiveChange }: { onActiveChange?: (active: boolean) => void }) {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [scoring] = useLocalStorage("ffdp.scoring", DEFAULT_SCORING);
  const [roster] = useLocalStorage("ffdp.roster", DEFAULT_ROSTER);
  const [method] = useLocalStorage<BaselineMethod>("ffdp.method", "VOLS");

  const [picks, setPicks] = useState<MockPick[]>([]);
  const [userSlot, setUserSlot] = useState(1);
  const [draftMode, setDraftMode] = useState<"cpu" | "manual" | "live">("cpu");
  const [started, setStarted] = useState(false);

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
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());

  // Live sync — polls Sleeper's documented REST API (no WebSocket; Sleeper's
  // live socket protocol isn't publicly documented, so REST polling is the
  // reliable option even though it's a little less "instant").
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailCountRef = useRef(0);
  const [wsStatus, setWsStatus] = useState<"idle" | "connecting" | "live" | "error" | "disconnected">("idle");
  const [wsError, setWsError] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const pickingRef = useRef(false);

  // Restore import settings from sessionStorage on mount
  useEffect(() => {
    const raw = sessionStorage.getItem(DRAFT_SETUP_KEY);
    if (raw) {
      try {
        const d = JSON.parse(raw);
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
        const ks = JSON.parse(rawKeepers);
        if (Array.isArray(ks)) setPendingKeepers(ks);
      } catch { /* ignore */ }
    }

    // Restore an in-progress draft, if one was left running. This runs after
    // the DRAFT_SETUP_KEY restore above so its `setPicks`/`setUserSlot` calls
    // win for a draft that had already started (the setup snapshot only ever
    // reflects the pre-start import step).
    const rawActive = sessionStorage.getItem(ACTIVE_DRAFT_KEY);
    if (rawActive) {
      try {
        const a = JSON.parse(rawActive);
        if (Array.isArray(a.picks)) setPicks(a.picks);
        if (typeof a.userSlot === "number") setUserSlot(a.userSlot);
        if (Array.isArray(a.watchlist)) setWatchlist(new Set(a.watchlist));
        // Needed so a restored live draft can actually reconnect: a live
        // draft reached via the username lookup (not the Import button)
        // never touches DRAFT_SETUP_KEY, so draftId would otherwise be lost
        // on refresh and the Connect button would have nothing to connect to.
        if (a.draftId) setDraftId(a.draftId);
        if (a.draftMode === "live") {
          // Live mode holds no real connection across a refresh — land back
          // on the setup screen (picks are restored) so the user has to hit
          // Connect again rather than sitting in a "live" state that isn't.
          setDraftMode("live");
          setStarted(false);
        } else if (a.draftMode === "cpu" || a.draftMode === "manual") {
          setDraftMode(a.draftMode);
          if (a.started) setStarted(true);
        }
      } catch { /* ignore malformed storage */ }
    }
  }, []);

  // Persist manual keepers across tab switches
  useEffect(() => {
    if (pendingKeepers.length > 0) {
      sessionStorage.setItem(KEEPER_SETUP_KEY, JSON.stringify(pendingKeepers));
    } else {
      sessionStorage.removeItem(KEEPER_SETUP_KEY);
    }
  }, [pendingKeepers]);

  // Persist the in-progress draft so a refresh mid-draft doesn't lose it.
  // Guarded on `started` so this doesn't fire (and clobber the snapshot with
  // empty initial state) before the mount-restore effect above has run —
  // `started` is false on first render, so this simply no-ops until either
  // the restore effect or the user sets it true. Only resetDraft() clears
  // the stored snapshot; we deliberately never remove it here.
  useEffect(() => {
    if (!started) return;
    sessionStorage.setItem(
      ACTIVE_DRAFT_KEY,
      JSON.stringify({
        picks,
        started,
        draftMode,
        userSlot,
        watchlist: Array.from(watchlist),
        // Only meaningful for draftMode === "live" (see restore effect above)
        draftId,
      })
    );
  }, [started, picks, draftMode, userSlot, watchlist, draftId]);

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

  const ranked = useMemo(() => {
    if (!players) return [] as RankedPlayer[];
    return rankPlayers(players, scoring, roster, method).players;
  }, [players, scoring, roster, method]);

  const numTeams = importedTeams ?? roster.teams;
  const numRounds =
    importedRounds ??
    Math.max(10, roster.qb + roster.rb + roster.wr + roster.te + roster.flex + roster.superflex + roster.bench + 2);
  const adpKey = adpKeyFor(scoring, roster);

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
  const currentTeamSlot = isDone ? null : teamSlotForPick(currentPickNum, numTeams);
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
      switch (sortKey) {
        case "rank": return (a.overallRank - b.overallRank) * sortDir;
        case "proj": return (a.points - b.points) * sortDir;
        case "vor": return (a.vbd - b.vbd) * sortDir;
        case "adp": {
          const va = a.adp[adpKey] >= 999 ? null : a.adp[adpKey];
          const vb = b.adp[adpKey] >= 999 ? null : b.adp[adpKey];
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
        case "value": {
          const val = (p: RankedPlayer): number | null => {
            const sl = p.adp[adpKey] >= 999 ? null : p.adp[adpKey];
            const es = p.adp.espn >= 999 ? null : p.adp.espn;
            const srcs = [sl, es].filter((x): x is number => x !== null);
            if (!srcs.length) return null;
            return srcs.reduce((a, b) => a + b, 0) / srcs.length - p.overallRank;
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
  }, [ranked, draftedIds, filter, query, sortKey, sortDir, adpKey, watchlist]);

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
      const srcs = [player.adp.ppr, player.adp.half, player.adp.std, player.adp.espn]
        .filter((v): v is number => v < 999);
      if (srcs.length === 0) return [];
      const avgAdp = srcs.reduce((a, b) => a + b, 0) / srcs.length;
      // Value = how many picks LATER than the market average you got this
      // player. Positive = steal (you drafted him after the market would
      // have), negative = reach. Using the actual pick number (instead of
      // just "board rank vs ADP") is what makes this measure drafting skill:
      // a big reach at pick 1 now grades worse than the same gap at pick 20.
      const value = pick.pickNumber - avgAdp;
      return [{ pick, player, value }];
    });
    if (graded.length === 0) return null;
    const avgValue = graded.reduce((a, b) => a + b.value, 0) / graded.length;
    let letter: "A" | "B" | "C" | "D" | "F";
    if (avgValue > 5) letter = "A";
    else if (avgValue >= 2) letter = "B";
    else if (avgValue > -2) letter = "C";
    else if (avgValue >= -5) letter = "D";
    else letter = "F";
    const sorted = [...graded].sort((a, b) => b.value - a.value);
    return { letter, avgValue, sorted };
  }, [isDone, draftMode, myPicks, playerById]);

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
    () => Array.from(watchlist).filter((id) => !draftedIds.has(id)).length,
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
    const available = ranked.filter((p) => !draftedIds.has(p.id));
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
  }, [isUserTurn, draftMode, myRosterSlots, ranked, draftedIds, unfilledStarterSlots]);

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
      // Snake-draft pick number for this keeper's own team slot (not the
      // user's slot — a keeper can belong to any team in the league).
      const pickEquivalent = pickNumForCell(k.round, k.teamSlot, numTeams);
      const srcs = player
        ? [player.adp.ppr, player.adp.half, player.adp.std, player.adp.espn].filter(
            (v): v is number => v < 999
          )
        : [];
      const consensusAdp = srcs.length ? srcs.reduce((a, b) => a + b, 0) / srcs.length : null;
      const surplus = consensusAdp === null ? null : pickEquivalent - consensusAdp;
      let verdict: "keep" | "borderline" | "cut" | null = null;
      if (surplus !== null) {
        if (surplus > 8) verdict = "keep";
        else if (surplus >= 0) verdict = "borderline";
        else verdict = "cut";
      }
      return { keeper: k, player, pickEquivalent, consensusAdp, surplus, verdict };
    });
  }, [pendingKeepers, ranked, playerById, numTeams]);

  // CPU auto-pick: ADP-weighted with positional need and jitter
  useEffect(() => {
    if (!started || draftMode !== "cpu" || isUserTurn || isDone || ranked.length === 0) return;
    const timer = setTimeout(() => {
      const available = ranked.filter((p) => !draftedIds.has(p.id));
      if (available.length === 0 || currentTeamSlot === null) return;

      // --- Positional-need adjustment for the CPU team on the clock ---
      // Without this, CPU teams just chase ADP and can end up with 5 QBs
      // or zero QBs. Count what the picking team already has at each spot.
      const teamPicks = picks.filter((pk) => pk.teamSlot === currentTeamSlot);
      const posCounts: Record<string, number> = {};
      for (const pk of teamPicks) {
        const pos = playerById.get(pk.playerId)?.position ?? pk.playerPos;
        if (pos) posCounts[pos] = (posCounts[pos] ?? 0) + 1;
      }
      // Soft roster caps: once a team is at/above the cap for a position,
      // drafting more there gets a big score penalty (score is ascending,
      // i.e. lower = better, so a penalty is added).
      const POS_CAP: Record<string, number> = { QB: 2, TE: 2, K: 1, DEF: 1, RB: 6, WR: 6 };
      const NEED_PENALTY = 200; // dwarfs the ~1-300 ADP scale so the cap actually bites
      // In the last few rounds, still-missing required positions become
      // urgent (no team should finish with zero QB/TE, or no K/DEF at all),
      // so give those a big score boost (subtract, since lower = better).
      const NEED_BOOST = 200;
      const roundsLeft = numRounds - currentRound;

      const best = available
        .map((p) => {
          const adpVal = p.adp[adpKey] < 999 ? p.adp[adpKey] : p.overallRank + 100;
          const jitter = (Math.random() - 0.5) * 8; // ±4 pick variance
          let score = adpVal + jitter;

          const have = posCounts[p.position] ?? 0;
          const cap = POS_CAP[p.position];
          if (cap !== undefined && have >= cap) score += NEED_PENALTY;

          if ((p.position === "QB" || p.position === "TE") && have === 0 && roundsLeft <= 2) {
            score -= NEED_BOOST;
          }
          if ((p.position === "K" || p.position === "DEF") && have === 0 && roundsLeft <= 3) {
            score -= NEED_BOOST;
          }

          return { p, score };
        })
        .sort((a, b) => a.score - b.score)[0]?.p;

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
    currentTeamSlot, currentPickNum, adpKey, picks, playerById, numRounds, currentRound,
  ]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [picks.length]);

  // Clean up the live-draft poll loop on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, []);

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
          pickNumber: pickNumForCell(k.round, k.teamSlot, numTeams),
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
    setStarted(true);
  }

  function resetDraft() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    pollFailCountRef.current = 0;
    setWsStatus("idle");
    setWsError(null);
    setPicks([]);
    setStarted(false);
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
    setWatchlist(new Set());
    sessionStorage.removeItem(DRAFT_SETUP_KEY);
    sessionStorage.removeItem(KEEPER_SETUP_KEY);
    sessionStorage.removeItem(ACTIVE_DRAFT_KEY);
  }

  function exportCsv() {
    const header = "Pick,Round,Team,Player,Position,Team (NFL),Projected Points,VOR,Avg ADP,Value";
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
      const projPts = player ? player.points.toFixed(1) : "";
      const vor = player
        ? (player.vbd > 0 ? "+" : "") + player.vbd.toFixed(1)
        : "";

      let avgAdpStr = "";
      let valueStr = "";
      if (player) {
        const sl = player.adp[adpKey] >= 999 ? null : player.adp[adpKey];
        const es = player.adp.espn >= 999 ? null : player.adp.espn;
        const srcs = [sl, es].filter((x): x is number => x !== null);
        if (srcs.length > 0) {
          const avg = srcs.reduce((a, b) => a + b, 0) / srcs.length;
          avgAdpStr = avg.toFixed(1);
          const val = avg - player.overallRank;
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
    const pickNum = pickNumForCell(keeperRound, keeperSlot, numTeams);
    if (pendingKeepers.some((k) => pickNumForCell(k.round, k.teamSlot, numTeams) === pickNum)) return;
    if (pendingKeepers.some((k) => k.playerId === keeperPlayerId)) return;
    setPendingKeepers((prev) => [
      ...prev,
      { playerId: keeperPlayerId, teamSlot: keeperSlot, round: keeperRound },
    ]);
    setKeeperSearch("");
    setKeeperPlayerId(null);
  }

  function connectLiveDraft() {
    const id = draftId.trim();
    if (!id) return;

    // Stop any previous poll loop before starting a new one
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    setWsStatus("connecting");
    setWsError(null);
    pollFailCountRef.current = 0;

    // Sleeper doesn't publish its live-draft push protocol, so instead of
    // guessing at a WebSocket wire format we just poll the same documented
    // REST endpoints handleImport() already uses. Simple, and it works.
    const poll = async () => {
      try {
        const picksRes = await fetch(`https://api.sleeper.app/v1/draft/${id}/picks`);
        if (!picksRes.ok) throw new Error(`Could not fetch picks (${picksRes.status})`);
        const sleeperPicks: SleeperPick[] = await picksRes.json();

        const newPicks: MockPick[] = sleeperPicks.map((sp) => ({
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

        setPicks((prev) => {
          // Merge by pick number — Sleeper is the source of truth, so a
          // pick already seen just gets refreshed rather than duplicated.
          const merged = new Map(prev.map((p) => [p.pickNumber, p]));
          for (const np of newPicks) merged.set(np.pickNumber, np);
          return [...merged.values()].sort((a, b) => a.pickNumber - b.pickNumber);
        });

        // A successful fetch means we're connected, regardless of past failures
        pollFailCountRef.current = 0;
        setWsStatus("live");
        setWsError(null);

        // Separately check whether the draft has finished, and stop polling if so
        const draftRes = await fetch(`https://api.sleeper.app/v1/draft/${id}`);
        if (draftRes.ok) {
          const draft: SleeperDraft = await draftRes.json();
          if (draft.status === "complete") {
            if (pollRef.current) {
              clearInterval(pollRef.current);
              pollRef.current = null;
            }
            setWsStatus("idle");
          }
        }
      } catch (err) {
        pollFailCountRef.current += 1;
        // Only flip to an error state after a few misses in a row — a single
        // dropped request every 5s shouldn't alarm the user
        if (pollFailCountRef.current >= 3) {
          setWsStatus("error");
          setWsError(
            `Could not reach Sleeper: ${err instanceof Error ? err.message : String(err)}`
          );
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      }
    };

    // Fetch once immediately so the status flips to "live" right away,
    // then keep polling every ~5 seconds while connected.
    poll();
    pollRef.current = setInterval(poll, 5000);

    // The draft screen mounts as soon as setStarted(true) fires;
    // existing imported picks are preserved (merge logic above handles overlap)
    setStarted(true);
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
      let slotToName: Record<number, string> = {};
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
      let parsedTradedPicks: TradedPick[] = [];
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

      setImportedTeams(teams);
      setImportedRounds(rounds);
      setPicks(imported);
      setUserSlot(newUserSlot);
      setTradedPicks(parsedTradedPicks);
      setImportSummary(summary);
      setTeamNames(slotToName);
      setLeagueRosterPositions(rosterPositions);

      // Persist so tab switches don't lose the setup
      sessionStorage.setItem(
        DRAFT_SETUP_KEY,
        JSON.stringify({
          draftId: id,
          sleeperUsername,
          sleeperUserId,
          importedTeams: teams,
          importedRounds: rounds,
          picks: imported,
          userSlot: newUserSlot,
          tradedPicks: parsedTradedPicks,
          importSummary: summary,
          teamNames: slotToName,
          leagueRosterPositions: rosterPositions,
        })
      );
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

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
                      const pickNum = pickNumForCell(k.round, k.teamSlot, numTeams);
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
                Connects to a live Sleeper draft — read-only, picks refresh automatically every few seconds.
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
              <button
                onClick={connectLiveDraft}
                disabled={!draftId.trim() || !players || players.length === 0}
                className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
              >
                Connect to Live Draft
              </button>
              {wsError && <p className="mt-1.5 text-xs text-rose-400">{wsError}</p>}
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
                wsStatus === "live"
                  ? "text-emerald-400"
                  : wsStatus === "connecting"
                  ? "text-amber-400"
                  : "text-rose-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  wsStatus === "live"
                    ? "bg-emerald-400 animate-pulse"
                    : wsStatus === "connecting"
                    ? "bg-amber-400 animate-pulse"
                    : "bg-rose-400"
                }`}
              />
              {wsStatus === "live"
                ? "Live"
                : wsStatus === "connecting"
                ? "Connecting…"
                : wsStatus === "error"
                ? "Connection error"
                : "Disconnected"}
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
                  </button>
                )}
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-zinc-800">
              <table className="w-full text-sm">
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
                            setWatchlist((prev) => {
                              const next = new Set(prev);
                              if (next.has(p.id)) next.delete(p.id);
                              else next.add(p.id);
                              return next;
                            });
                          }}
                          className={`text-base leading-none transition ${
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
                        {p.adp[adpKey] < 999 ? p.adp[adpKey].toFixed(1) : "—"}
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
