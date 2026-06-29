"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Player, Position, RankedPlayer } from "@/lib/types";
import { ALL_POSITIONS } from "@/lib/types";
import { rankPlayers, type BaselineMethod } from "@/lib/vbd";
import { adpKeyFor, DEFAULT_ROSTER, DEFAULT_SCORING } from "@/lib/presets";
import { useLocalStorage } from "./useLocalStorage";
import DraftBoardGrid from "./DraftBoardGrid";
import { SEASON } from "@/lib/sleeper";

interface MockPick {
  pickNumber: number;
  teamSlot: number;
  playerId: string;
  // Fallback display info for players not found in our ranked list (e.g. from Sleeper import)
  playerName?: string;
  playerPos?: string;
  isKeeper?: boolean;
}

interface TradedPick {
  round: number;
  originalSlot: number;
  currentSlot: number;
}

interface SleeperDraft {
  type: string;
  sport: string;
  status: string;
  settings?: { teams?: number; rounds?: number };
  draft_order?: Record<string, number> | null;
  slot_to_roster_id?: Record<string, number> | null;
}

type Filter = "ALL" | Position;
type SortKey = "rank" | "proj" | "vor" | "adp" | "value";

const SORT_DEFAULTS: Record<SortKey, 1 | -1> = {
  rank: 1,
  proj: -1,
  vor: -1,
  adp: 1,
  value: -1,
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

function teamSlotForPick(pickNum: number, numTeams: number): number {
  const round = Math.ceil(pickNum / numTeams);
  const pos = ((pickNum - 1) % numTeams) + 1;
  return round % 2 === 1 ? pos : numTeams + 1 - pos;
}

function SortTh({
  label,
  sk,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  sk: SortKey;
  sortKey: SortKey;
  sortDir: 1 | -1;
  onSort: (k: SortKey) => void;
  className?: string;
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
        {active ? (
          sortDir === 1 ? " ↑" : " ↓"
        ) : (
          <span className="text-zinc-700"> ⇅</span>
        )}
      </span>
    </th>
  );
}

export default function MockDraft() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [scoring] = useLocalStorage("ffdp.scoring", DEFAULT_SCORING);
  const [roster] = useLocalStorage("ffdp.roster", DEFAULT_ROSTER);
  const [method] = useLocalStorage<BaselineMethod>("ffdp.method", "VOLS");

  const [picks, setPicks] = useState<MockPick[]>([]);
  const [userSlot, setUserSlot] = useState(1);
  const [draftMode, setDraftMode] = useState<"cpu" | "manual">("cpu");
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

  // View mode (players table vs board grid)
  const [viewMode, setViewMode] = useState<"players" | "board">("players");

  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const logRef = useRef<HTMLDivElement>(null);

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
    return rankPlayers(players, scoring, roster, method).players;
  }, [players, scoring, roster, method]);

  // Imported values override roster config for draft simulation
  const numTeams = importedTeams ?? roster.teams;
  const numRounds =
    importedRounds ??
    Math.max(
      10,
      roster.qb +
        roster.rb +
        roster.wr +
        roster.te +
        roster.flex +
        roster.superflex +
        roster.bench +
        2
    );
  const adpKey = adpKeyFor(scoring, roster);

  const currentPickNum = picks.length + 1;
  const isDone = picks.length >= numTeams * numRounds;
  const currentRound = isDone
    ? numRounds
    : Math.ceil(currentPickNum / numTeams);
  const currentTeamSlot = isDone
    ? null
    : teamSlotForPick(currentPickNum, numTeams);
  const isUserTurn =
    !isDone && (draftMode === "manual" || currentTeamSlot === userSlot);

  const draftedIds = useMemo(
    () => new Set(picks.map((p) => p.playerId)),
    [picks]
  );

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
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.team ?? "").toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case "rank":
          return (a.overallRank - b.overallRank) * sortDir;
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
          const val = (p: RankedPlayer): number | null => {
            const sl = p.adp[adpKey] >= 999 ? null : p.adp[adpKey];
            const es = p.adp.espn >= 999 ? null : p.adp.espn;
            const srcs = [sl, es].filter((x): x is number => x !== null);
            if (!srcs.length) return null;
            return srcs.reduce((a, b) => a + b, 0) / srcs.length - p.overallRank;
          };
          const va = val(a);
          const vb = val(b);
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return (va - vb) * sortDir;
        }
        default:
          return 0;
      }
    });
  }, [ranked, draftedIds, filter, query, sortKey, sortDir, adpKey]);

  // CPU auto-pick: fires whenever it's not the user's turn (cpu mode only)
  useEffect(() => {
    if (
      !started ||
      draftMode !== "cpu" ||
      isUserTurn ||
      isDone ||
      ranked.length === 0
    )
      return;
    const timer = setTimeout(() => {
      const best = ranked.find((p) => !draftedIds.has(p.id));
      if (best && currentTeamSlot !== null) {
        setPicks((prev) => [
          ...prev,
          {
            pickNumber: prev.length + 1,
            teamSlot: currentTeamSlot,
            playerId: best.id,
          },
        ]);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [
    started,
    draftMode,
    isUserTurn,
    isDone,
    ranked,
    draftedIds,
    currentTeamSlot,
  ]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [picks.length]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(SORT_DEFAULTS[key]);
    }
  }

  function pickPlayer(playerId: string) {
    if (!started || !isUserTurn || isDone || currentTeamSlot === null) return;
    const teamSlot = draftMode === "manual" ? currentTeamSlot : userSlot;
    setPicks((prev) => [
      ...prev,
      { pickNumber: prev.length + 1, teamSlot, playerId },
    ]);
  }

  function resetDraft() {
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
  }

  async function handleLookupUser() {
    const uname = sleeperUsername.trim();
    if (!uname) return;
    setLookingUpUser(true);
    setUserLookupError(null);
    setUserDrafts([]);
    setSleeperUserId(null);
    try {
      const userRes = await fetch(
        `https://api.sleeper.app/v1/user/${encodeURIComponent(uname)}`
      );
      if (!userRes.ok) throw new Error(`User "${uname}" not found on Sleeper`);
      const user = await userRes.json();
      if (!user?.user_id) throw new Error(`User "${uname}" not found on Sleeper`);
      const userId: string = user.user_id;
      setSleeperUserId(userId);

      // Try current season, fall back to prior
      let draftsData: SleeperDraft[] | null = null;
      let season = SEASON;
      for (const s of [SEASON, String(Number(SEASON) - 1)]) {
        const r = await fetch(
          `https://api.sleeper.app/v1/user/${userId}/drafts/nfl/${s}`
        );
        if (r.ok) {
          const d = await r.json();
          if (Array.isArray(d) && d.length > 0) {
            draftsData = d;
            season = s;
            break;
          }
        }
      }

      if (!draftsData || draftsData.length === 0) {
        throw new Error(`No NFL drafts found for "${uname}" in ${SEASON} or ${Number(SEASON) - 1}`);
      }

      const snakeDrafts = (draftsData as (SleeperDraft & { draft_id: string; settings?: { teams?: number; rounds?: number } })[]).filter(
        (d) => d.type === "snake" && d.sport === "nfl"
      );

      if (snakeDrafts.length === 0) {
        throw new Error(`No snake NFL drafts found for "${uname}" in ${season}`);
      }

      const draftList = snakeDrafts.map((d) => ({
        draft_id: d.draft_id,
        label: `${season} · ${d.settings?.teams ?? "?"}T / ${d.settings?.rounds ?? "?"}R · ${d.status}`,
      }));

      setUserDrafts(draftList);

      // Auto-fill if only one draft
      if (draftList.length === 1) {
        setDraftId(draftList[0].draft_id);
      }
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

      if (draft.type !== "snake") {
        throw new Error(`Only snake drafts are supported (got "${draft.type}")`);
      }
      if (draft.sport !== "nfl") {
        throw new Error(`Only NFL drafts are supported`);
      }

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

      setImportedTeams(teams);
      setImportedRounds(rounds);
      setPicks(imported);

      // Auto-detect user's draft slot from draft_order
      if (sleeperUserId && draft.draft_order) {
        const slot = draft.draft_order[sleeperUserId];
        if (typeof slot === "number") setUserSlot(slot);
      }

      // Parse traded picks: convert roster_id → draft slot via inverted slot_to_roster_id
      if (Array.isArray(rawTradedPicks) && rawTradedPicks.length > 0) {
        const slotToRoster = draft.slot_to_roster_id ?? {};
        // Invert: roster_id → slot (number)
        const rosterToSlot = new Map<number, number>();
        for (const [slotStr, rosterId] of Object.entries(slotToRoster)) {
          rosterToSlot.set(rosterId as number, Number(slotStr));
        }

        const parsed: TradedPick[] = [];
        for (const tp of rawTradedPicks) {
          const origSlot = rosterToSlot.get(tp.roster_id);
          const currSlot = rosterToSlot.get(tp.owner_id);
          if (origSlot && currSlot && tp.round) {
            parsed.push({ round: tp.round, originalSlot: origSlot, currentSlot: currSlot });
          }
        }
        setTradedPicks(parsed);
      } else {
        setTradedPicks([]);
      }

      const keeperCount = imported.filter((p) => p.isKeeper).length;
      const statusLabel =
        draft.status === "complete"
          ? "complete"
          : draft.status === "drafting"
          ? "in progress"
          : "pre-draft";
      const keeperNote = keeperCount > 0 ? ` · ${keeperCount} keepers` : "";
      setImportSummary(
        `Imported ${imported.length} picks from a ${teams}-team ${rounds}-round draft (${statusLabel}${keeperNote})`
      );
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  const myPicks =
    draftMode === "cpu" ? picks.filter((p) => p.teamSlot === userSlot) : picks;
  const myPlayers = myPicks.map((pick) => ({
    player: playerById.get(pick.playerId),
    pick,
  }));

  // ── Setup screen ──────────────────────────────────────────────────────────
  if (!started) {
    const effectiveTeams = importedTeams ?? roster.teams;
    const effectiveRounds = importedRounds ?? numRounds;

    return (
      <div className="flex items-start justify-center py-12">
        <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950/80 p-6">
          <h2 className="mb-1 text-lg font-semibold text-zinc-100">
            Mock Draft Setup
          </h2>
          <p className="mb-6 text-sm text-zinc-500">
            {effectiveTeams} teams · {effectiveRounds} rounds · snake order
          </p>

          {!players && !error && (
            <p className="mb-4 text-sm text-zinc-500">Loading player data…</p>
          )}
          {error && (
            <p className="mb-4 text-sm text-rose-400">
              Failed to load players: {error}
            </p>
          )}

          {/* Sleeper import */}
          <div className="mb-5">
            <label className="mb-1.5 block text-sm font-medium text-zinc-400">
              Import from Sleeper{" "}
              <span className="font-normal text-zinc-600">(optional)</span>
            </label>

            {/* Username lookup */}
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
            {userLookupError && (
              <p className="mb-1.5 text-xs text-rose-400">{userLookupError}</p>
            )}

            {/* Draft picker (shown after username lookup) */}
            {userDrafts.length > 1 && (
              <div className="mb-2">
                <select
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
                >
                  <option value="">Select a draft…</option>
                  {userDrafts.map((d) => (
                    <option key={d.draft_id} value={d.draft_id}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Manual draft ID (shown when no username or as fallback) */}
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
            {importError && (
              <p className="mt-1.5 text-xs text-rose-400">{importError}</p>
            )}
            {importSummary && (
              <p className="mt-1.5 text-xs text-emerald-400">{importSummary}</p>
            )}
            <p className="mt-1.5 text-xs text-zinc-600">
              Enter your Sleeper username to find drafts, or paste a draft ID directly.
            </p>
          </div>

          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-medium text-zinc-400">
              Draft mode
            </label>
            <div className="flex rounded-lg border border-zinc-700 p-0.5">
              {(["cpu", "manual"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setDraftMode(m)}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                    draftMode === m
                      ? "bg-emerald-500 text-zinc-950"
                      : "text-zinc-400 hover:text-zinc-100"
                  }`}
                >
                  {m === "cpu" ? "vs CPU" : "Manual (fill all picks)"}
                </button>
              ))}
            </div>
          </div>

          {draftMode === "cpu" && (
            <div className="mb-6">
              <label className="mb-1.5 block text-sm font-medium text-zinc-400">
                Your draft slot
              </label>
              <select
                value={userSlot}
                onChange={(e) => setUserSlot(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none"
              >
                {Array.from({ length: effectiveTeams }, (_, i) => i + 1).map(
                  (n) => (
                    <option key={n} value={n}>
                      Slot {n} of {effectiveTeams}
                    </option>
                  )
                )}
              </select>
            </div>
          )}

          <p className="mb-4 text-xs text-zinc-600">
            Scoring and roster settings are pulled from your Cheat Sheet
            configuration.
          </p>

          <button
            onClick={() => setStarted(true)}
            disabled={!players}
            className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-400 disabled:opacity-40"
          >
            {picks.length > 0
              ? `Continue Draft (${picks.length} picks already made)`
              : "Start Mock Draft"}
          </button>
        </div>
      </div>
    );
  }

  // ── Draft screen ──────────────────────────────────────────────────────────
  const colSpan = isUserTurn ? 7 : 6;

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
          <span className="font-semibold text-zinc-300">
            Draft complete — {numTeams * numRounds} picks made
          </span>
        ) : (
          <>
            <span className="text-sm text-zinc-500">
              Round {currentRound} · Pick {currentPickNum} of{" "}
              {numTeams * numRounds}
            </span>
            {draftMode === "manual" ? (
              <span className="font-semibold text-emerald-400">
                Team {currentTeamSlot} — click a player to pick
              </span>
            ) : isUserTurn ? (
              <span className="font-semibold text-emerald-400">
                ⚡ YOU&apos;RE ON THE CLOCK — click a player to draft
              </span>
            ) : (
              <span className="text-sm text-zinc-400">
                Team {currentTeamSlot} picking…
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Players / Board toggle */}
          <div className="flex rounded-md border border-zinc-700 p-0.5">
            {(["players", "board"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setViewMode(v)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                  viewMode === v
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {v === "players" ? "Players" : "Board"}
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

      {/* Main layout */}
      <div className="flex gap-4">
        {/* Board view */}
        {viewMode === "board" && (
          <div className="min-w-0 flex-1">
            <DraftBoardGrid
              picks={picks}
              tradedPicks={tradedPicks}
              numTeams={numTeams}
              numRounds={numRounds}
              userSlot={userSlot}
              currentPickNum={currentPickNum}
              playerById={playerById}
              draftMode={draftMode}
            />
          </div>
        )}

        {/* Available players table */}
        {viewMode === "players" && <div className="min-w-0 flex-1">
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
          </div>

          <div className="overflow-hidden rounded-xl border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900/80 text-xs uppercase tracking-wide">
                <tr>
                  <SortTh
                    label="#"
                    sk="rank"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                    className="text-left"
                  />
                  <th className="px-3 py-2 text-left font-medium text-zinc-500">
                    Player
                  </th>
                  <th className="px-2 py-2 text-center font-medium text-zinc-500">
                    Pos
                  </th>
                  <SortTh
                    label="Proj"
                    sk="proj"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                    className="text-right"
                  />
                  <SortTh
                    label="VOR"
                    sk="vor"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                    className="text-right"
                  />
                  <SortTh
                    label="ADP"
                    sk="adp"
                    sortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                    className="text-right"
                  />
                  {isUserTurn && (
                    <th className="px-2 py-2 text-center font-medium text-zinc-500">
                      Pick
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((p, i) => (
                  <tr
                    key={p.id}
                    onClick={() => pickPlayer(p.id)}
                    className={`border-t border-zinc-800/60 transition ${
                      isUserTurn
                        ? "cursor-pointer hover:bg-emerald-500/10"
                        : "opacity-60"
                    } ${i === 0 && isUserTurn ? "bg-emerald-500/5" : ""}`}
                  >
                    <td className="px-3 py-2 text-zinc-500 tabular-nums">
                      {p.overallRank}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-zinc-100">{p.name}</div>
                      <div className="text-xs text-zinc-500">
                        {p.team ?? "FA"}
                        {p.bye ? ` · Bye ${p.bye}` : ""}
                        {p.injuryStatus ? (
                          <span className="ml-1 text-amber-500">
                            {p.injuryStatus}
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
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                      {p.adp[adpKey] < 999 ? p.adp[adpKey].toFixed(1) : "—"}
                    </td>
                    {isUserTurn && (
                      <td className="px-2 py-2 text-center">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            pickPlayer(p.id);
                          }}
                          className="rounded-md border border-emerald-500/40 px-2 py-1 text-xs text-emerald-400 transition hover:bg-emerald-500/10"
                        >
                          Pick
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={colSpan}
                      className="px-3 py-8 text-center text-zinc-500"
                    >
                      No players available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>}

        {/* Right sidebar */}
        <div className="flex w-64 shrink-0 flex-col gap-4">
          {/* Roster / picks panel */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {draftMode === "cpu"
                ? `Your Roster · Slot ${userSlot}`
                : "All Picks"}
            </h3>
            {myPlayers.length === 0 ? (
              <p className="text-xs text-zinc-600">No picks yet.</p>
            ) : (
              <div className="space-y-1">
                {myPlayers.map(({ player, pick }, i) => {
                  const pos = player?.position ?? pick.playerPos;
                  const badgeClass =
                    pos && pos in POS_BADGE
                      ? POS_BADGE[pos as Position]
                      : UNKNOWN_BADGE;
                  return (
                    <div
                      key={pick.pickNumber}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className="w-4 shrink-0 text-right text-zinc-600">
                        {i + 1}.
                      </span>
                      {pos && (
                        <span
                          className={`shrink-0 rounded border px-1 py-0.5 text-[10px] font-semibold ${badgeClass}`}
                        >
                          {pos}
                        </span>
                      )}
                      <span className="truncate text-zinc-200">
                        {player?.name ?? pick.playerName ?? pick.playerId}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Draft log */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Draft Log
            </h3>
            <div ref={logRef} className="max-h-96 space-y-0.5 overflow-y-auto">
              {picks.length === 0 ? (
                <p className="text-xs text-zinc-600">No picks yet.</p>
              ) : (
                picks.map((pick) => {
                  const player = playerById.get(pick.playerId);
                  const isMe =
                    draftMode === "cpu" && pick.teamSlot === userSlot;
                  const pos = player?.position ?? pick.playerPos;
                  const badgeClass =
                    pos && pos in POS_BADGE
                      ? POS_BADGE[pos as Position]
                      : UNKNOWN_BADGE;
                  return (
                    <div
                      key={pick.pickNumber}
                      className={`flex items-center gap-1.5 rounded px-1.5 py-1 text-xs ${
                        isMe ? "bg-emerald-500/10" : ""
                      }`}
                    >
                      <span className="w-5 shrink-0 text-right tabular-nums text-zinc-600">
                        {pick.pickNumber}.
                      </span>
                      <span
                        className={`shrink-0 ${
                          isMe ? "font-medium text-emerald-400" : "text-zinc-500"
                        }`}
                      >
                        {isMe ? "You" : `T${pick.teamSlot}`}
                      </span>
                      {pos && (
                        <span
                          className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-semibold ${badgeClass}`}
                        >
                          {pos}
                        </span>
                      )}
                      <span
                        className={`truncate ${
                          isMe ? "text-zinc-200" : "text-zinc-400"
                        }`}
                      >
                        {player?.name ?? pick.playerName ?? pick.playerId}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Sleeper draft pick shape (only the fields we need)
interface SleeperPick {
  pick_no: number;
  draft_slot: number;
  player_id: string;
  is_keeper: true | null;
  metadata?: {
    first_name?: string;
    last_name?: string;
    position?: string;
  };
}
