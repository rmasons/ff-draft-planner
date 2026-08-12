"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { validAnnotationStore, validRoster, validScoring } from "@/lib/validation";
import { encodeStored, parseStored } from "@/lib/persistence";
import { marketReference } from "@/lib/market";
import { fetchLeagueKeepers, inferKeeperRoundConvention, type KeeperRoundConvention } from "@/lib/sleeper-league";
import {
  assignKeeperRounds,
  chooseCpuPickOrBestAvailable,
  fillLineupSlots,
  gradeLetter,
  gradePick,
  keeperAdjustedAdp,
  keeperConflict,
  keeperValue,
  leagueOpenSlots,
  mergeImportedKeepers,
  mergeKeepersNonDestructive,
  ownerForPick,
  pickNumberForSlot,
  pollBackoffDelay,
  positionalRun,
  remainingPicksForSlot,
  rosterConfigFromLeague,
  rosterSlots,
  seededRandom,
  selectSuggestedPick,
  depthCapacityByPosition,
  SLEEPER_SLOT_ELIGIBLE,
  survivalEstimate,
  transitionDraft,
  type KeeperCandidate,
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
  /**
   * False only for keepers imported from Sleeper's roster mechanism, which
   * carries no draft round. Such a keeper's round is a placeholder the user
   * must set — its cost, and therefore the whole keep/cut verdict, is
   * meaningless until they do.
   */
  roundConfirmed?: boolean;
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

const SLOT_ELIGIBLE = SLEEPER_SLOT_ELIGIBLE;
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
  // A restored pick may carry only Sleeper's raw `playerPos` metadata.
  const positions = myPicks.map((pick) => playerById.get(pick.playerId)?.position ?? pick.playerPos ?? "");
  const assigned = fillLineupSlots(rosterPositions, positions).map((pi) => (pi === null ? null : myPicks[pi]));

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

/** Renders inferred keeper rounds for the import status line, e.g. "round 14"
 *  for a single round or "rounds 13–14" (en dash) for a contiguous range.
 *  `rounds` is always ascending and contiguous by construction — see
 *  inferKeeperRoundConvention's trailing-block validation. */
function keeperRoundsPhrase(rounds: number[]): string {
  if (rounds.length <= 1) return `round ${rounds[0]}`;
  return `rounds ${rounds[0]}–${rounds[rounds.length - 1]}`;
}

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
  const [keeperError, setKeeperError] = useState<string | null>(null);
  const [keeperImporting, setKeeperImporting] = useState(false);
  const [keeperImportError, setKeeperImportError] = useState<string | null>(null);
  const [keeperImportSummary, setKeeperImportSummary] = useState<string | null>(null);

  // Export / copy state
  const [copiedRoster, setCopiedRoster] = useState(false);

  // View and filter state
  const [viewMode, setViewMode] = useState<"players" | "board" | "scarcity">("players");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [boardFilter, setBoardFilter] = useState<Filter>("ALL");
  // Same key/validator DraftBoard uses (lib/validation.ts) — without the validator,
  // a malformed record slips past hydration and the watchlist memo below throws
  // on the first entry missing `target`/`note`, taking down the whole screen.
  const [annotations, setAnnotations] = useLocalStorage<AnnotationStore>("ffdp.annotations", {}, validAnnotationStore);
  const watchlist = useMemo(() => new Set(Object.entries(annotations).filter(([key, value]) => key.startsWith(`${SEASON}:`) && value.target).map(([key]) => key.slice(SEASON.length + 1))), [annotations]);

  // Supported live sync uses Sleeper's documented REST endpoints.
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "live" | "error" | "stale">("idle");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const pickingRef = useRef(false);
  // Manual "Refresh now" control for the live-sync poll below; the effect
  // that owns the actual poll loop keeps this pointed at its latest closure.
  const livePollRef = useRef<() => void>(() => {});

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
    // Restore an in-progress draft, if one was left running. This runs after
    // the DRAFT_SETUP_KEY restore above so its `setPicks`/`setUserSlot` calls
    // win for a draft that had already started (the setup snapshot only ever
    // reflects the pre-start import step).
    const rawActive = sessionStorage.getItem(ACTIVE_DRAFT_KEY);
    if (rawActive) {
      try {
        const a = parseStored<Record<string, unknown>>(rawActive, {}).value as {
          picks?: MockPick[]; userSlot?: number; draftId?: string;
          draftMode?: "cpu" | "manual" | "live"; started?: boolean;
        };
        if (Array.isArray(a.picks)) setPicks(a.picks);
        if (typeof a.userSlot === "number") setUserSlot(a.userSlot);
        // Redundant with DRAFT_SETUP_KEY (handleImport writes draftId there
        // too) but kept here so the active-draft snapshot is self-contained
        // and this restore doesn't have to depend on the other one running.
        if (a.draftId) setDraftId(a.draftId);
        if (a.draftMode === "live") {
          // Live mode holds no real connection across a refresh — land back
          // on the setup screen (picks are restored) so the user has to hit
          // Connect again rather than sitting in a "live" state that isn't.
          // `started` is derived from draftStatus below, and draftStatus's
          // default ("setup") is simply left untouched here.
          setDraftMode("live");
        } else if (a.draftMode === "cpu" || a.draftMode === "manual") {
          setDraftMode(a.draftMode);
          // `started` has no setter of its own — it's derived from
          // draftStatus (a useReducer below), so drive it through the same
          // READY -> START sequence startDraft() uses.
          if (a.started) {
            sendDraftEvent({ type: "READY" });
            sendDraftEvent({ type: "START" });
          }
        }
      } catch { /* ignore malformed storage */ }
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

  // Persist the in-progress draft so a refresh mid-draft doesn't lose it.
  // Guarded on `started` so this doesn't fire (and clobber the snapshot with
  // empty initial state) before the mount-restore effect above has run —
  // `started` is false on first render, so this simply no-ops until either
  // the restore effect or the user starts a draft. Only resetDraft() clears
  // the stored snapshot; we deliberately never remove it here.
  useEffect(() => {
    if (!started) return;
    sessionStorage.setItem(
      ACTIVE_DRAFT_KEY,
      encodeStored({
        picks,
        started,
        draftMode,
        userSlot,
        // Only meaningful for draftMode === "live" (see restore effect above)
        draftId,
      }, SEASON)
    );
  }, [started, picks, draftMode, userSlot, draftId]);

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

  // The roster shape everything config-derived is computed from: VOR
  // baselines, ADP format, CPU roster legality, and the pick grid. Prefers the
  // imported league's real shape over the Cheat Sheet config, which is only a
  // stand-in for "no league imported yet".
  const effectiveRoster = useMemo(() => {
    const base = importedTeams ? { ...roster, teams: importedTeams } : roster;
    return leagueRosterPositions.length > 0 ? rosterConfigFromLeague(leagueRosterPositions, base) : base;
  }, [roster, importedTeams, leagueRosterPositions]);

  // Sleeper leagues can skip K and/or DEF, and can skip one without the other;
  // don't make the CPU fill a slot the league doesn't have.
  const leagueHasK = useMemo(
    () => leagueRosterPositions.length === 0 || leagueRosterPositions.includes("K"),
    [leagueRosterPositions]
  );
  const leagueHasDef = useMemo(
    () => leagueRosterPositions.length === 0 || leagueRosterPositions.includes("DEF"),
    [leagueRosterPositions]
  );

  const numTeams = effectiveRoster.teams;
  const numRounds =
    importedRounds ??
    Math.max(10, effectiveRoster.qb + effectiveRoster.rb + effectiveRoster.wr + effectiveRoster.te + effectiveRoster.flex + effectiveRoster.superflex + effectiveRoster.bench + 2);

  // Position lookup built from the raw pool, not from `ranked` — the live
  // draft state feeds rankPlayers, so it can't depend on its output. Falls
  // back to a pick's own metadata for anyone missing from the pool.
  const positionById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of players ?? []) m.set(p.id, p.position);
    for (const pick of picks) if (!m.has(pick.playerId) && pick.playerPos) m.set(pick.playerId, pick.playerPos);
    return m;
  }, [players, picks]);

  // One team's roster template: the imported league's if there is one.
  const leagueSlotTemplate = useMemo(
    (): string[] =>
      leagueRosterPositions.length > 0 ? leagueRosterPositions : rosterSlots(effectiveRoster, leagueHasK, leagueHasDef),
    [leagueRosterPositions, effectiveRoster, leagueHasK, leagueHasDef]
  );

  // Dynamic replacement level, once there's a board to measure against.
  // Preseason (and on the Cheat Sheet) baselines stay static — there's no
  // draft to be relative to.
  const liveDraftState = useMemo(() => {
    if (!started || picks.length === 0) return undefined;
    return {
      drafted: new Set(picks.map((p) => p.playerId)),
      openSlots: leagueOpenSlots(picks, (id) => positionById.get(id), leagueSlotTemplate, numTeams),
    };
  }, [started, picks, positionById, leagueSlotTemplate, numTeams]);

  // Keep the full rankPlayers() result (not just `.players`) so the
  // replacement-level baselines are available to pass down to ScarcityChart.
  // Calling with `players ?? []` (instead of an early-return null) keeps
  // `baselines` a real (if all-zero) Baselines object before players load,
  // so downstream code never has to null-check it.
  const rankResult = useMemo(
    () => rankPlayers(players ?? [], scoring, effectiveRoster, method, liveDraftState),
    [players, scoring, effectiveRoster, method, liveDraftState]
  );
  const ranked = rankResult.players;
  const baselines = rankResult.baselines;

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

  // Report active state to parent (for tab-switch guard; only while draft is actively in progress).
  // Cleanup reports inactive on unmount — without it, confirming "Leave the mock
  // draft?" unmounts this component but leaves AppShell's draftActive stuck true,
  // so the confirm fires again on every future tab switch even with no draft
  // running. The cleanup also re-runs on every dependency change (not just
  // unmount), but that's harmless here: it fires false then the effect body
  // immediately fires the real value again, so the net effect for a live
  // dependency change is unchanged — only a genuine unmount leaves the "false"
  // as the final word.
  useEffect(() => {
    onActiveChange?.(started && !isDone);
    return () => onActiveChange?.(false);
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
          const va = marketReference(a, scoring, effectiveRoster).consensus;
          const vb = marketReference(b, scoring, effectiveRoster).consensus;
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
        case "value": {
          // "Value" = consensus ADP minus overall rank (higher = bigger steal).
          const val = (p: RankedPlayer): number | null => {
            const consensus = marketReference(p, scoring, effectiveRoster).consensus;
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
  }, [ranked, draftedIds, filter, query, sortKey, sortDir, scoring, effectiveRoster, watchlist, annotations]);

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

  // Published ADPs of every kept player in the league. Kept players are off
  // the board, so the pool the market's published ADP implied no longer
  // exists; keeperAdjustedAdp uses this to slide available players' ADPs
  // earlier for grading, survival odds, and the CSV value column.
  const keeperAdps = useMemo(() => {
    const out: number[] = [];
    for (const p of picks) {
      if (!p.isKeeper) continue;
      const player = playerById.get(p.playerId);
      if (!player) continue;
      const adp = marketReference(player, scoring, effectiveRoster).consensus;
      if (adp !== null) out.push(adp);
    }
    return out;
  }, [picks, playerById, scoring, effectiveRoster]);

  const draftGrade = useMemo(() => {
    if (!isDone || draftMode !== "cpu") return null;
    const graded = myPicks.flatMap((pick) => {
      // Keepers aren't a drafting decision (you didn't "win" the pick against
      // the market that round), so they don't count toward the grade.
      if (pick.isKeeper) return [];
      const player = playerById.get(pick.playerId);
      if (!player) return [];
      const rawAdp = marketReference(player, scoring, effectiveRoster).consensus;
      const value = gradePick(keeperAdjustedAdp(rawAdp, keeperAdps), pick.pickNumber);
      return value === null ? [] : [{ pick, player, value, marketAdp: rawAdp }];
    });
    if (graded.length === 0) return null;
    const avgValue = graded.reduce((a, b) => a + b.value, 0) / graded.length;
    const letter = gradeLetter(avgValue);
    const sorted = [...graded].sort((a, b) => b.value - a.value);
    return { letter, avgValue, sorted };
  }, [isDone, draftMode, myPicks, playerById, scoring, effectiveRoster, keeperAdps]);

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

  // How many of each position the user already rosters, for the depth discount.
  const heldByPosition = useMemo(() => {
    const counts: Partial<Record<Position, number>> = {};
    for (const { player } of myPlayers) {
      if (player) counts[player.position] = (counts[player.position] ?? 0) + 1;
    }
    return counts;
  }, [myPlayers]);

  // Unfilled starter slots (excludes bench). Only meaningful in CPU mode with a Sleeper import.
  const unfilledStarterSlots = useMemo((): RosterSlot[] => {
    if (!myRosterSlots) return [];
    return myRosterSlots.filter((s) => s.slotType !== "BN" && s.pick === null);
  }, [myRosterSlots]);

  // Picks the user still gets to make, starting with the one on the clock.
  // Both the count and "which pick comes next" read off this one list so they
  // can't disagree about whether an already-filled (keeper) slot counts.
  const userRemainingPicks = useMemo(
    () => remainingPicksForSlot(currentPickNum, numTeams, numRounds, tradeRecords, userSlot, pickedNums),
    [currentPickNum, numTeams, numRounds, tradeRecords, userSlot, pickedNums]
  );
  const nextUserPickNum = useMemo(
    (): number | null => userRemainingPicks.find((n) => n > currentPickNum) ?? null,
    [userRemainingPicks, currentPickNum]
  );
  const userPicksRemaining = userRemainingPicks.length;

  // Positional runs in the recent live picks, keyed by position.
  const runsByPosition = useMemo(() => {
    const m = new Map<Position, { position: Position; count: number; window: number }>();
    for (const r of positionalRun(picks, playerById)) m.set(r.position, r);
    return m;
  }, [picks, playerById]);

  // Undrafted players grouped by position, each list best-first. `ranked` is
  // VBD-descending, and within one position VBD is just points minus a shared
  // constant, so each list comes out points-descending — which makes
  // `list[i + 1]` the next-best remaining option at that player's position.
  const availableByPosition = useMemo(() => {
    const byPos = new Map<Position, RankedPlayer[]>();
    const indexOf = new Map<string, number>();
    for (const p of ranked) {
      if (draftedIds.has(p.id)) continue;
      let list = byPos.get(p.position);
      if (!list) { list = []; byPos.set(p.position, list); }
      indexOf.set(p.id, list.length);
      list.push(p);
    }
    return { byPos, indexOf };
  }, [ranked, draftedIds]);

  /**
   * Score one candidate the way the recommendation claims to: VOR, plus the
   * tier cliff behind them, plus how unlikely they are to survive to the
   * user's next pick, plus positional-run pressure.
   */
  const evaluateCandidate = useCallback((player: RankedPlayer) => {
    const market = marketReference(player, scoring, effectiveRoster);
    const survival = nextUserPickNum === null ? null
      : survivalEstimate(keeperAdjustedAdp(market.consensus, keeperAdps), currentPickNum, nextUserPickNum);
    const list = availableByPosition.byPos.get(player.position);
    const index = availableByPosition.indexOf.get(player.id);
    const nextAtPosition = list !== undefined && index !== undefined ? list[index + 1] : undefined;
    const cliff = nextAtPosition ? Math.max(0, player.points - nextAtPosition.points) : 0;
    const run = runsByPosition.get(player.position);
    const score = player.vbd + cliff * 0.75 + (survival === null ? 0 : (1 - survival) * 8) + (run ? 2 : 0);
    return { nextPick: nextUserPickNum, survival, cliff, run, score, marketLabel: market.label };
  }, [scoring, effectiveRoster, nextUserPickNum, currentPickNum, availableByPosition, runsByPosition, keeperAdps]);

  // Best pick suggestion. Requires roster structure from a Sleeper import;
  // see selectSuggestedPick for why K/DEF are gated and why every candidate
  // is scored rather than taking the first eligible one.
  const bestPickSuggestion = useMemo(() => {
    if (!isUserTurn || draftMode !== "cpu" || !myRosterSlots) return null;
    const available = ranked.filter((p) => !draftedIds.has(p.id) && !annotations[annotationKey(SEASON, p.id)]?.avoid);
    return selectSuggestedPick(
      available,
      {
        openStarterSlotTypes: unfilledStarterSlots.map((s) => s.slotType),
        picksRemaining: userPicksRemaining,
        startable: depthCapacityByPosition(myRosterSlots.map((s) => s.slotType)),
        held: heldByPosition,
      },
      (player) => evaluateCandidate(player).score
    );
  }, [isUserTurn, draftMode, myRosterSlots, ranked, draftedIds, unfilledStarterSlots, annotations, evaluateCandidate, userPicksRemaining, heldByPosition]);

  const recommendationContext = useMemo(
    () => (bestPickSuggestion ? evaluateCandidate(bestPickSuggestion.player) : null),
    [bestPickSuggestion, evaluateCandidate]
  );

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
      const consensusAdp = player ? marketReference(player, scoring, effectiveRoster).consensus : null;
      // A rosters-imported keeper sits at a placeholder round 1 until the user
      // sets its real cost, and every part of this verdict is a function of
      // that cost — so reporting one would be inventing a recommendation out
      // of a number Sleeper never gave us. Round 1 is also the most expensive
      // slot, which would bias every unconfirmed row toward "Cut". Withhold
      // the whole valuation instead; the row reappears the moment a round is
      // picked. See the roundConfirmed comment on PendingKeeper.
      const confirmed = k.roundConfirmed !== false;
      const { pickEquivalent, surplus } = confirmed
        ? keeperValue(k.round, k.teamSlot, numTeams, consensusAdp)
        : { pickEquivalent: null, surplus: null };
      let verdict: "keep" | "borderline" | "cut" | null = null;
      if (surplus !== null) {
        if (surplus > 8) verdict = "keep";
        else if (surplus >= 0) verdict = "borderline";
        else verdict = "cut";
      }
      return { keeper: k, player, pickEquivalent, consensusAdp, surplus, verdict, confirmed };
    });
  }, [pendingKeepers, ranked, playerById, numTeams, scoring, effectiveRoster]);

  // CPU auto-pick: market-aware, roster-valid, need-aware, and reproducible.
  useEffect(() => {
    if (!started || draftMode !== "cpu" || isUserTurn || isDone || ranked.length === 0) return;
    const timer = setTimeout(() => {
      let available = ranked.filter((p) => !draftedIds.has(p.id) && !annotations[annotationKey(SEASON, p.id)]?.avoid);
      // The user's "avoid" list is a personal do-not-draft preference; it must
      // never be able to starve CPU opponents into a stall. If filtering by it
      // empties the pool, ignore it and let the CPU pick from anyone undrafted.
      if (available.length === 0) {
        available = ranked.filter((p) => !draftedIds.has(p.id));
      }
      if (available.length === 0 || currentTeamSlot === null) return;

      const teamPlayers = picks.filter((pick) => pick.teamSlot === currentTeamSlot).flatMap((pick) => {
        const player = playerById.get(pick.playerId);
        return player ? [{ id: player.id, position: player.position }] : [];
      });
      const configuredSlots = rosterSlots(effectiveRoster, leagueHasK, leagueHasDef);
      // Fall back to best-available (bench-anything) once the roster's slots
      // are full — e.g. an imported league with more rounds than the local
      // roster config has slots for — so the CPU always has a legal pick and
      // the draft can't stall waiting on a pick that will never come.
      const best = chooseCpuPickOrBestAvailable(available, teamPlayers, configuredSlots, (player) => marketReference(player, scoring, effectiveRoster).consensus, seededRandom(currentPickNum * 1009 + currentTeamSlot));

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
    currentTeamSlot, currentPickNum, picks, playerById, effectiveRoster, leagueHasK, leagueHasDef, scoring, annotations,
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
    // A keeper imported from Sleeper's rosters mechanism (no round in the
    // source data — see fetchLeagueKeepers) defaults to round 1 until the
    // user sets a real one. Starting with that placeholder still in place
    // would silently draft it at the wrong pick and grade it against a
    // meaningless keeper-value verdict, so this blocks the same way the
    // pick-collision guard below does: stay on the setup screen, surface the
    // error, don't start.
    const unconfirmed = pendingKeepers.filter((k) => k.roundConfirmed === false).length;
    if (unconfirmed > 0) {
      setKeeperError(
        `${unconfirmed} keeper${unconfirmed !== 1 ? "s" : ""} still need${unconfirmed === 1 ? "s" : ""} a round set — Sleeper didn't publish one. Set ${unconfirmed !== 1 ? "them" : "it"} above before starting.`
      );
      return;
    }
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
      // Never let a keeper silently clobber an existing (e.g. imported) pick
      // at the same pickNumber — a naive Map.set merge would otherwise
      // overwrite it with no trace. Skip colliding keepers and surface a
      // visible message instead of merging destructively.
      const { merged, skipped } = mergeKeepersNonDestructive(picks, keeperPicks);
      if (skipped.length > 0) {
        // Stay on the setup screen so the message is actually seen — once
        // the draft starts, the setup screen (and this error) is gone.
        setKeeperError(
          `${skipped.length} keeper${skipped.length !== 1 ? "s" : ""} collided with an existing pick at that slot and ${skipped.length !== 1 ? "were" : "was"} not applied. Remove or reassign ${skipped.length !== 1 ? "them" : "it"}, then start again.`
        );
        return;
      }
      setPicks(merged);
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
    setKeeperError(null);
    setKeeperImporting(false);
    setKeeperImportError(null);
    setKeeperImportSummary(null);
    setBoardFilter("ALL");
    setTeamNames({});
    setLeagueRosterPositions([]);
    sessionStorage.removeItem(DRAFT_SETUP_KEY);
    sessionStorage.removeItem(KEEPER_SETUP_KEY);
    sessionStorage.removeItem(ACTIVE_DRAFT_KEY);
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
        const rawAdp = marketReference(player, scoring, effectiveRoster).consensus;
        if (rawAdp !== null) {
          avgAdpStr = rawAdp.toFixed(1);
          const val = gradePick(keeperAdjustedAdp(rawAdp, keeperAdps), pick.pickNumber);
          if (val !== null) valueStr = (val >= 0 ? "+" : "") + val.toFixed(1);
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
    setKeeperError(null);
    // Manual entry always has a real, user-chosen round, so it's confirmed
    // by construction — see keeperConflict for why that flag matters.
    const candidate: KeeperCandidate = { playerId: keeperPlayerId, teamSlot: keeperSlot, round: keeperRound, roundConfirmed: true };
    const others: KeeperCandidate[] = pendingKeepers.map((k) => ({
      playerId: k.playerId, teamSlot: k.teamSlot, round: k.round, roundConfirmed: k.roundConfirmed !== false,
    }));
    const conflict = keeperConflict(candidate, others, picks, numTeams);
    if (conflict === "collision-pending-keeper") {
      setKeeperError(`Round ${keeperRound} for ${teamLabel(keeperSlot)} is already assigned to another keeper.`);
      return;
    }
    // Existing picks (e.g. from a Sleeper import, or a draft reset back to
    // setup with picks already made) — without this check, startDraft's
    // merge would silently collide with that pick.
    if (conflict === "collision-existing-pick") {
      const pickNum = pickNumberForSlot(keeperRound, keeperSlot, numTeams);
      setKeeperError(`Pick #${pickNum} (Round ${keeperRound}, ${teamLabel(keeperSlot)}) is already taken by an existing pick.`);
      return;
    }
    if (conflict === "duplicate-pending-keeper") {
      setKeeperError("That player is already set as a keeper.");
      return;
    }
    if (conflict === "duplicate-drafted-player") {
      setKeeperError("That player has already been drafted.");
      return;
    }
    setPendingKeepers((prev) => [
      ...prev,
      { playerId: keeperPlayerId, teamSlot: keeperSlot, round: keeperRound, roundConfirmed: true },
    ]);
    setKeeperSearch("");
    setKeeperPlayerId(null);
  }

  // Bulk keeper import from Sleeper — see fetchLeagueKeepers for the two
  // source mechanisms. mergeImportedKeepers runs the batch through the same
  // keeperConflict validator addKeeper uses, so an imported candidate is
  // rejected for exactly the same reasons a manual add would be: already
  // pending, already drafted, or a pick-number collision (only checked once
  // its round is confirmed).
  async function handleImportKeepers() {
    const id = draftId.trim();
    if (!id) return;
    setKeeperImporting(true);
    setKeeperImportError(null);
    setKeeperImportSummary(null);
    try {
      const result = await fetchLeagueKeepers(id);

      // Board-sourced keepers already carry a real round, so there's
      // nothing to infer. Rosters-sourced keepers never do (see
      // fetchLeagueKeepers) — try to fill them in from this league's own
      // keeper-round convention (see inferKeeperRoundConvention) before
      // merging. A failure here just means no convention was found; it must
      // never fail the import itself.
      let convention: KeeperRoundConvention | null = null;
      let importedKeepers = result.keepers;
      if (result.source === "rosters") {
        try {
          convention = await inferKeeperRoundConvention(id);
        } catch {
          convention = null;
        }
        importedKeepers = assignKeeperRounds(
          result.keepers,
          convention?.rounds ?? null,
          (playerId) => playerById.get(playerId)?.points ?? 0
        );
      }

      const { keepers, added, upgraded, skipped } = mergeImportedKeepers(
        pendingKeepers.map((k) => ({
          playerId: k.playerId, teamSlot: k.teamSlot, round: k.round, roundConfirmed: k.roundConfirmed !== false,
        })),
        importedKeepers,
        picks,
        numTeams
      );
      setPendingKeepers(keepers);

      const skippedNote = skipped > 0 ? ` · ${skipped} skipped (already drafted or duplicated)` : "";
      const upgradedNote = upgraded > 0 ? ` · ${upgraded} round${upgraded !== 1 ? "s" : ""} filled in from the board` : "";
      const countLabel = `${added} keeper${added !== 1 ? "s" : ""}`;
      const summary =
        result.source === "board"
          ? `Imported ${countLabel} from the draft board.${upgradedNote}${skippedNote}`
          : convention
            // sourceSeason is best-effort — the prior league's detail fetch is
            // allowed to fail without losing the convention itself.
            ? `Imported ${countLabel} from league rosters · rounds set from your ${convention.sourceSeason || "previous"} draft, where keepers took ${keeperRoundsPhrase(convention.priorRounds)}.${skippedNote}`
            : `Imported ${countLabel} from league rosters — Sleeper doesn't publish keeper rounds, so set each round below.${skippedNote}`;
      setKeeperImportSummary(summary);
    } catch (e) {
      setKeeperImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setKeeperImporting(false);
    }
  }

  async function connectLiveDraft() {
    if (!draftId.trim()) return;
    setSyncStatus("syncing");
    setSyncError(null);
    // handleImport swallows its own errors (setImportError, no throw) so the
    // setup screen's plain "Import Draft" button can rely on it never
    // rejecting. That means a try/catch here would never fire for a bad
    // draft ID — connectLiveDraft must check handleImport's return value
    // instead of relying on an exception to know the import failed.
    const errorMessage = await handleImport();
    if (errorMessage) {
      setSyncStatus("error");
      setSyncError(errorMessage);
      return;
    }
    setLastSyncAt(Date.now());
    setSyncStatus("live");
    sendDraftEvent({ type: "READY" });
    sendDraftEvent({ type: "SYNC" });
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

  // Returns null on success, or the error message on failure. Never throws —
  // callers that only want fire-and-forget behavior (the setup screen's
  // "Import Draft" button) can ignore the return value, while callers that
  // need to know whether the import actually succeeded (connectLiveDraft)
  // can check it instead of relying on a rejected promise.
  async function handleImport(): Promise<string | null> {
    const id = draftId.trim();
    if (!id) return null;
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
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setImportError(message);
      return message;
    } finally {
      setImporting(false);
    }
  }

  useEffect(() => {
    if (!started || draftMode !== "live" || !draftId.trim() || isDone) return;
    let cancelled = false;
    let seq = 0;
    let failures = 0;
    let timer: number | undefined;
    // Tracks whether this live-mode session has completed a poll attempt yet,
    // so only the first poll (and manual refreshes) flip the pill to "Syncing…".
    // Without this, every routine 8s background tick also set "syncing" for the
    // duration of the fetch, making a healthy connection flap between "Synced"
    // and "Syncing…" and greying out "Refresh now" on a fixed cadence.
    let hasPolledOnce = false;
    // 8s -> 16s -> 32s, capped, reset to 8s as soon as a poll succeeds.
    const nextDelay = () => pollBackoffDelay(failures);
    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      timer = window.setTimeout(() => { void poll(); }, delayMs);
    };

    const poll = async (manual = false) => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") {
        scheduleNext(nextDelay());
        return;
      }
      // Tag this request so a response that resolves after a *later* poll
      // has already started (e.g. a slow tick-N response landing after
      // tick-N+1, or a manual refresh overlapping the interval poll) gets
      // discarded instead of clobbering newer data with a stale snapshot.
      const mySeq = ++seq;
      // Only surface "syncing" for a manual refresh or the very first poll of
      // this live session — routine background ticks stay silent so a healthy
      // connection reads as steady "Synced HH:MM:SS" instead of flapping.
      if (manual || !hasPolledOnce) setSyncStatus("syncing");
      hasPolledOnce = true;
      try {
        const response = await fetch(`https://api.sleeper.app/v1/draft/${draftId.trim()}/picks`, { cache: "no-store" });
        if (!response.ok) throw new Error(`Sleeper picks request failed (${response.status})`);
        const sleeperPicks: SleeperPick[] = await response.json();
        if (cancelled || mySeq !== seq) return;
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
        if (cancelled || mySeq !== seq) return;
        failures++;
        setSyncError(error instanceof Error ? error.message : String(error));
        setSyncStatus(failures > 1 ? "stale" : "error");
      } finally {
        if (!cancelled && mySeq === seq) scheduleNext(nextDelay());
      }
    };

    // Manual "Refresh now" hook: clear whatever's pending and poll immediately.
    // Passes manual=true so the user always gets "Syncing…" feedback for a
    // click, even if a background tick already flipped hasPolledOnce.
    livePollRef.current = () => {
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
      void poll(true);
    };

    scheduleNext(8000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      livePollRef.current = () => {};
    };
  }, [started, draftMode, draftId, isDone, numTeams, tradeRecords]);

  // ── Setup screen ──────────────────────────────────────────────────────────
  if (!started) {
    const importedKeepers = picks.filter((p) => p.isKeeper);
    const slotOptions = Array.from({ length: numTeams }, (_, i) => i + 1);
    const roundOptions = Array.from({ length: numRounds }, (_, i) => i + 1);
    const unconfirmedKeeperCount = pendingKeepers.filter((k) => k.roundConfirmed === false).length;

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
                {draftId.trim() && (
                  <div className="mb-2">
                    <button
                      onClick={handleImportKeepers}
                      disabled={keeperImporting}
                      className="w-full rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
                    >
                      {keeperImporting ? "Importing keepers…" : "Import keepers from Sleeper"}
                    </button>
                    {keeperImportError && <p className="mt-1.5 text-xs text-rose-400">{keeperImportError}</p>}
                    {keeperImportSummary && <p className="mt-1.5 text-xs text-emerald-400">{keeperImportSummary}</p>}
                  </div>
                )}

                {pendingKeepers.length > 0 && (
                  <div className="mb-2 space-y-1">
                    {pendingKeepers.map((k, i) => {
                      const player = playerById.get(k.playerId);
                      const pickNum = pickNumberForSlot(k.round, k.teamSlot, numTeams);
                      const confirmed = k.roundConfirmed !== false;
                      return (
                        <div
                          key={i}
                          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs ${
                            confirmed ? "border-zinc-700/50 bg-zinc-900/50" : "border-amber-500/30 bg-amber-500/5"
                          }`}
                        >
                          <span className="min-w-0 flex-1 truncate text-zinc-200">{player?.name ?? k.playerId}</span>
                          <select
                            value={k.teamSlot}
                            onChange={(e) => {
                              const teamSlot = Number(e.target.value);
                              setPendingKeepers((prev) => prev.map((p, j) => (j === i ? { ...p, teamSlot } : p)));
                            }}
                            className="shrink-0 rounded border border-zinc-700 bg-zinc-900 px-1 py-1 text-zinc-100 focus:border-emerald-500 focus:outline-none"
                          >
                            {slotOptions.map((n) => <option key={n} value={n}>{teamLabel(n)}</option>)}
                          </select>
                          <select
                            value={k.round}
                            onChange={(e) => {
                              const round = Number(e.target.value);
                              // Editing the round is how the user resolves an
                              // unconfirmed (rosters-imported) row — see the
                              // roundConfirmed doc comment on PendingKeeper.
                              setPendingKeepers((prev) => prev.map((p, j) => (j === i ? { ...p, round, roundConfirmed: true } : p)));
                            }}
                            className={`shrink-0 rounded border bg-zinc-900 px-1 py-1 focus:outline-none ${
                              confirmed ? "border-zinc-700 text-zinc-100 focus:border-emerald-500" : "border-amber-500/50 text-amber-400 focus:border-amber-400"
                            }`}
                          >
                            {roundOptions.map((n) => <option key={n} value={n}>R{n}</option>)}
                          </select>
                          <span className="shrink-0 text-zinc-600">#{pickNum}</span>
                          {!confirmed && <span className="shrink-0 font-medium text-amber-400">set round</span>}
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
                {keeperError && <p className="mt-1.5 text-xs text-rose-400">{keeperError}</p>}
              </div>
            )}
          </div>

          {/* Keeper Value Analysis */}
          {keeperAnalysis.length > 0 && (
            <div className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
              <h3 className="mb-3 text-sm font-semibold text-zinc-300">Keeper Value Analysis</h3>
              <div className="space-y-2">
                {keeperAnalysis.map(({ keeper, player, pickEquivalent, consensusAdp, surplus, verdict, confirmed }, i) => {
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
                        {!confirmed && (
                          <span className="ml-auto shrink-0 text-xs font-medium text-amber-400">Set a round to value</span>
                        )}
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
                        <span className={confirmed ? "text-zinc-300" : "text-zinc-500"}>
                          {confirmed ? `Round ${keeper.round}` : "—"}
                        </span>
                        <span className="text-zinc-500">Pick equivalent</span>
                        <span className={pickEquivalent !== null ? "text-zinc-300" : "text-zinc-500"}>
                          {pickEquivalent !== null ? `#${pickEquivalent}` : "—"}
                        </span>
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
                ? unconfirmedKeeperCount > 0
                  ? `Start Draft (${unconfirmedKeeperCount} keeper round${unconfirmedKeeperCount !== 1 ? "s" : ""} need${unconfirmedKeeperCount === 1 ? "s" : ""} to be set)`
                  : `Start Draft (${pendingKeepers.length} keeper${pendingKeepers.length !== 1 ? "s" : ""} set)`
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
          {draftMode === "live" && (
            <button
              onClick={() => livePollRef.current()}
              disabled={syncStatus === "syncing"}
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-400 transition hover:text-zinc-200 disabled:opacity-40"
            >
              Refresh now
            </button>
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
                    title={
                      recommendationContext
                        ? `${recommendationContext.marketLabel}; score ${recommendationContext.score.toFixed(1)} = VOR, tier cliff, next-pick scarcity, and run context` +
                          (bestPickSuggestion.forced
                            ? "; every remaining pick must fill a starter"
                            : `; roster need weighted ${Math.round(bestPickSuggestion.needWeight * 100)}%`) +
                          (rankResult.dynamic ? "; replacement level is live" : "")
                        : undefined
                    }
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
                    {recommendationContext?.survival != null && recommendationContext.nextPick != null && (
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
                        // Ignore keys that bubbled up from a nested control (the star/target
                        // button, the Pick button): activating those must not also draft the row.
                        if (event.target !== event.currentTarget) return;
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
                        {marketReference(p, scoring, effectiveRoster).consensus?.toFixed(1) ?? "—"}
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
