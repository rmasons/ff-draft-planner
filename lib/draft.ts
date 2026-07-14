import type { Position, RankedPlayer, RosterConfig } from "./types";

export interface DraftPickLike {
  pickNumber: number;
  teamSlot: number;
  playerId: string;
  isKeeper?: boolean;
}

export interface TradedPickLike {
  round: number;
  roster_id: number;
  owner_id: number;
}

export function teamSlotForPick(pickNumber: number, teams: number): number {
  const round = Math.ceil(pickNumber / teams);
  const position = ((pickNumber - 1) % teams) + 1;
  return round % 2 ? position : teams + 1 - position;
}

export function pickNumberForSlot(round: number, slot: number, teams: number): number {
  const offset = round % 2 ? slot : teams + 1 - slot;
  return (round - 1) * teams + offset;
}

export function originalSlotForPick(pickNumber: number, teams: number): number {
  return teamSlotForPick(pickNumber, teams);
}

/** Last duplicate trade record wins, matching the newest snapshot entry. */
export function ownerForPick(pickNumber: number, teams: number, trades: TradedPickLike[]): number {
  const round = Math.ceil(pickNumber / teams);
  const original = originalSlotForPick(pickNumber, teams);
  let owner = original;
  for (const trade of trades) {
    if (trade.round === round && trade.roster_id === original && trade.owner_id > 0) owner = trade.owner_id;
  }
  return owner;
}

export type RosterSlot = "QB" | "RB" | "WR" | "TE" | "FLEX" | "SUPER_FLEX" | "K" | "DEF" | "BN";
export interface RosterAssignment { valid: boolean; assignments: (string | null)[]; openSlots: RosterSlot[] }

export function rosterSlots(config: RosterConfig, includeKDef = true): RosterSlot[] {
  const repeat = (slot: RosterSlot, count: number) => Array.from({ length: Math.max(0, count) }, () => slot);
  return [
    ...repeat("QB", config.qb), ...repeat("RB", config.rb), ...repeat("WR", config.wr),
    ...repeat("TE", config.te), ...repeat("FLEX", config.flex), ...repeat("SUPER_FLEX", config.superflex),
    ...(includeKDef ? (["K", "DEF"] as RosterSlot[]) : []), ...repeat("BN", config.bench),
  ];
}

export function eligibleForSlot(position: Position, slot: RosterSlot): boolean {
  if (slot === "BN") return true;
  if (slot === "FLEX") return position === "RB" || position === "WR" || position === "TE";
  if (slot === "SUPER_FLEX") return position === "QB" || position === "RB" || position === "WR" || position === "TE";
  return position === slot;
}

/** Small deterministic bipartite matcher. Specific slots are tried before flexible slots. */
export function assignRoster(players: { id: string; position: Position }[], slots: RosterSlot[]): RosterAssignment {
  if (players.length > slots.length) return { valid: false, assignments: slots.map(() => null), openSlots: [] };
  const order = slots.map((slot, index) => ({ slot, index })).sort((a, b) => {
    const priority: Record<RosterSlot, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0, FLEX: 1, SUPER_FLEX: 2, BN: 3 };
    return priority[a.slot] - priority[b.slot];
  });
  const assignments: (string | null)[] = slots.map(() => null);
  const used = new Set<string>();
  function solve(index: number): boolean {
    if (index === order.length) return used.size === players.length;
    const current = order[index];
    for (const player of players) {
      if (!used.has(player.id) && eligibleForSlot(player.position, current.slot)) {
        used.add(player.id); assignments[current.index] = player.id;
        if (solve(index + 1)) return true;
        used.delete(player.id); assignments[current.index] = null;
      }
    }
    return solve(index + 1);
  }
  const valid = solve(0);
  return { valid, assignments, openSlots: valid ? slots.filter((_, index) => assignments[index] === null) : [] };
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function chooseCpuPick(
  candidates: RankedPlayer[], current: { id: string; position: Position }[], slots: RosterSlot[],
  market: (player: RankedPlayer) => number | null, random: () => number,
): RankedPlayer | null {
  const legal = candidates.filter((candidate) => assignRoster([...current, candidate], slots).valid);
  if (!legal.length) return null;
  const currentAssignment = assignRoster(current, slots);
  return legal.map((player) => {
    const needed = currentAssignment.openSlots.some((slot) => slot !== "BN" && eligibleForSlot(player.position, slot));
    const earlySpecialistPenalty = (player.position === "K" || player.position === "DEF") && current.length < Math.max(1, slots.length - 4) ? 80 : 0;
    const tierBonus = Math.max(0, 4 - player.tier) * 0.8;
    return { player, score: (market(player) ?? player.overallRank + 80) - (needed ? 10 : 0) - tierBonus + earlySpecialistPenalty + (random() - 0.5) * 8 };
  }).sort((a, b) => a.score - b.score)[0].player;
}

export function gradePick(marketAdp: number | null, pickNumber: number): number | null {
  return marketAdp === null ? null : marketAdp - pickNumber;
}

export function gradeLetter(average: number): "A" | "B" | "C" | "D" | "F" {
  return average > 5 ? "A" : average >= 2 ? "B" : average > -2 ? "C" : average >= -5 ? "D" : "F";
}

export function keeperValue(round: number, teamSlot: number, teams: number, marketAdp: number | null) {
  const pickEquivalent = pickNumberForSlot(round, teamSlot, teams);
  return { pickEquivalent, surplus: marketAdp === null ? null : pickEquivalent - marketAdp };
}

export function positionalRun(picks: DraftPickLike[], players: Map<string, { position: Position }>, window = 6, threshold = 4) {
  const recent = picks.filter((pick) => !pick.isKeeper).sort((a, b) => a.pickNumber - b.pickNumber).slice(-window);
  const counts = new Map<Position, number>();
  for (const pick of recent) {
    const pos = players.get(pick.playerId)?.position;
    if (pos) counts.set(pos, (counts.get(pos) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= threshold).map(([position, count]) => ({ position, count, window: recent.length }));
}

export function survivalEstimate(adp: number | null, currentPick: number, nextPick: number): number | null {
  if (adp === null || nextPick <= currentPick) return null;
  const spread = Math.max(6, adp * 0.12);
  const z = (nextPick - adp) / spread;
  return Math.max(0.02, Math.min(0.98, 1 / (1 + Math.exp(z * 1.7))));
}

export type DraftStatus = "setup" | "ready" | "running" | "syncing" | "stale" | "complete";
export type DraftEvent = { type: "READY" } | { type: "START" } | { type: "SYNC" } | { type: "STALE" } | { type: "COMPLETE" } | { type: "RESET" };
export function transitionDraft(status: DraftStatus, event: DraftEvent): DraftStatus {
  if (event.type === "RESET") return "setup";
  const allowed: Record<DraftStatus, Partial<Record<DraftEvent["type"], DraftStatus>>> = {
    setup: { READY: "ready" }, ready: { START: "running", SYNC: "syncing" },
    running: { SYNC: "syncing", STALE: "stale", COMPLETE: "complete" },
    syncing: { START: "running", STALE: "stale", COMPLETE: "complete" },
    stale: { SYNC: "syncing", START: "running", COMPLETE: "complete" }, complete: {},
  };
  return allowed[status][event.type] ?? status;
}

