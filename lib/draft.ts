import type { Position, RankedPlayer, RosterConfig } from "./types";

/** Sleeper's roster slot names → the positions each accepts. Sleeper exposes
 *  more flex variants than the local RosterConfig models, so this is the
 *  authority for anything driven by an imported league's `roster_positions`. */
export const SLEEPER_SLOT_ELIGIBLE: Record<string, Position[]> = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  BN: ["QB", "RB", "WR", "TE", "K", "DEF"],
};

/** Fill order for a lineup: most restrictive slot first, so a player who can
 *  only go one place isn't displaced by one who could have gone anywhere. */
export const SLEEPER_SLOT_PRIORITY: Record<string, number> = {
  K: 0, DEF: 1, QB: 2, RB: 3, WR: 4, TE: 5,
  WRRB_FLEX: 6, REC_FLEX: 7, FLEX: 8, SUPER_FLEX: 9, BN: 10,
};

/**
 * Greedy lineup fill. Returns, per slot, the index of the player assigned to
 * it (or null). Slots are filled most-restrictive first; within a slot the
 * first unused eligible player wins, so `positions` should be in whatever
 * order the caller wants to prefer (draft order, for a roster display).
 */
export function fillLineupSlots(slotTypes: string[], positions: string[]): (number | null)[] {
  const used = new Set<number>();
  const assigned: (number | null)[] = slotTypes.map(() => null);
  const order = slotTypes
    .map((_, i) => i)
    .sort((a, b) => (SLEEPER_SLOT_PRIORITY[slotTypes[a]] ?? 99) - (SLEEPER_SLOT_PRIORITY[slotTypes[b]] ?? 99));
  for (const si of order) {
    const eligible = new Set<string>(SLEEPER_SLOT_ELIGIBLE[slotTypes[si]] ?? []);
    for (let pi = 0; pi < positions.length; pi++) {
      if (!used.has(pi) && eligible.has(positions[pi])) {
        assigned[si] = pi;
        used.add(pi);
        break;
      }
    }
  }
  return assigned;
}

/**
 * Every roster slot still unfilled across the whole league, as a flat list of
 * slot-type names — the league-wide demand that dynamic VOR baselines measure
 * against (see LiveDraftState in lib/vbd.ts).
 *
 * Counting actual unfilled slots is what makes this different from simply
 * subtracting drafted players from the league's total demand. Those two agree
 * only if every pick filled a starting job; bench stashes and handcuffs break
 * that, and the error compounds through the middle rounds exactly when the
 * baselines matter most.
 */
export function leagueOpenSlots(
  picks: { teamSlot: number; playerId: string }[],
  positionOf: (playerId: string) => string | undefined,
  rosterPositions: string[],
  teams: number,
): string[] {
  const known = rosterPositions.filter((slot) => slot in SLEEPER_SLOT_ELIGIBLE);
  const byTeam = new Map<number, string[]>();
  for (const pick of picks) {
    const position = positionOf(pick.playerId);
    if (!position) continue;
    const list = byTeam.get(pick.teamSlot);
    if (list) list.push(position);
    else byTeam.set(pick.teamSlot, [position]);
  }
  const open: string[] = [];
  for (let slot = 1; slot <= teams; slot++) {
    const assigned = fillLineupSlots(known, byTeam.get(slot) ?? []);
    known.forEach((type, i) => { if (assigned[i] === null) open.push(type); });
  }
  return open;
}

/** Sleeper roster slot name → the RosterConfig field it counts toward.
 *  K/DEF have no RosterConfig field (rankPlayers baselines them at one per
 *  team) and IDP/IR/TAXI slots aren't draftable here, so both are skipped. */
const ROSTER_SLOT_FIELD: Record<string, keyof RosterConfig> = {
  QB: "qb", RB: "rb", WR: "wr", TE: "te",
  FLEX: "flex", WRRB_FLEX: "flex", REC_FLEX: "flex",
  SUPER_FLEX: "superflex", BN: "bench",
};

/**
 * Turn an imported league's actual roster_positions into a RosterConfig.
 *
 * VOR replacement levels are entirely a function of league size and starter
 * counts, so computing them from a locally saved config while the draft runs
 * on an imported league produces baselines for the wrong league — most
 * visibly in superflex, where a 1-QB config baselines QB at QB13 instead of
 * ~QB21 and understates every quarterback by a full tier. The same config
 * also selects the ADP format (see adpKeyFor), so a stale `superflex: 0`
 * additionally reads 1-QB ADP for a superflex draft.
 *
 * Falls back to `base` if the league listed no slots we recognize, so an
 * unusual (e.g. all-IDP) roster can't collapse every baseline to zero.
 */
export function rosterConfigFromLeague(positions: string[], base: RosterConfig): RosterConfig {
  const derived: RosterConfig = { ...base, qb: 0, rb: 0, wr: 0, te: 0, flex: 0, superflex: 0, bench: 0 };
  let counted = 0;
  for (const slot of positions) {
    const field = ROSTER_SLOT_FIELD[slot];
    if (!field) continue;
    derived[field]++;
    counted++;
  }
  return counted > 0 ? derived : base;
}

const isSpecialist = (position: Position) => position === "K" || position === "DEF";
const isFlexible = (slot: string) =>
  slot === "FLEX" || slot === "WRRB_FLEX" || slot === "REC_FLEX" || slot === "SUPER_FLEX";

/** Score bonus, in projected-points units, for filling an open starter slot at
 *  full urgency. A dedicated slot is worth more than a flexible one because
 *  only one position can ever fill it. */
const NEED_BONUS_DEDICATED = 25;
const NEED_BONUS_FLEXIBLE = 12;

/**
 * Effective startable capacity per position, for the depth discount only (see
 * depthValueFactor). Dedicated slots count as one guaranteed start each.
 *
 * Flexible slots are *shared*, so they are credited fractionally rather than
 * counted in full toward every position they accept: a single FLEX cannot start
 * a third RB and a third WR and a second TE at once, yet crediting it fully to
 * each — the old behavior — is exactly what made a second TE (or a
 * superflex-less second QB) look like a free starter and top the board.
 *
 * Each flexible slot spreads one starter's worth of credit across its eligible
 * positions, with one deliberate exception: SUPER_FLEX credits QB in full,
 * because in practice a superflex is a second quarterback slot. That keeps a
 * second QB at full value in superflex while a shared FLEX only nudges it.
 *
 * The result is fractional on purpose; depthValueFactor takes a real-valued
 * capacity. A position with no eligible slot still comes out at zero, so the
 * "can't field one" guard there is unaffected.
 */
const FLEX_CAPACITY_CREDIT: Record<string, Partial<Record<Position, number>>> = {
  FLEX: { RB: 1 / 3, WR: 1 / 3, TE: 1 / 3 },
  WRRB_FLEX: { RB: 1 / 2, WR: 1 / 2 },
  REC_FLEX: { WR: 1 / 2, TE: 1 / 2 },
  SUPER_FLEX: { QB: 1, RB: 1 / 4, WR: 1 / 4, TE: 1 / 4 },
};

export function depthCapacityByPosition(lineupSlotTypes: string[]): Record<Position, number> {
  const capacity: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const slot of lineupSlotTypes) {
    if (slot === "BN") continue;
    const flexCredit = FLEX_CAPACITY_CREDIT[slot];
    if (flexCredit) {
      for (const [position, credit] of Object.entries(flexCredit)) {
        capacity[position as Position] += credit;
      }
    } else if (slot in capacity) {
      // A dedicated slot (QB/RB/WR/TE/K/DEF) is one guaranteed start.
      capacity[slot as Position] += 1;
    }
  }
  return capacity;
}

/**
 * What the next player at a position is worth to *this* roster, 1 down to 0.
 *
 * League-wide VOR says how scarce a player is; it says nothing about whether
 * you can use them. Those come apart badly when the league under-drafts a
 * position: if eight teams still need a quarterback in round 11, every
 * remaining quarterback is genuinely scarce and scores well — and a seventh
 * one still cannot start for you.
 *
 * Value holds at full while you could still start the player, then decays
 * linearly to nothing as your holdings go from a full complement to double it.
 * That scales with the lineup: a 1-QB league tolerates about one backup, a
 * three-receiver lineup tolerates about three. Zero means another one is of no
 * use at all, and selectSuggestedPick drops those from consideration rather
 * than scoring them — a discounted-to-zero player would otherwise still beat
 * the sub-replacement (negative VOR) players who are all that's left late, and
 * win the pick anyway.
 */
export function depthValueFactor(held: number, startable: number): number {
  if (startable <= 0) return 0; // can't field one at all
  const beyondStarters = Math.max(0, held + 1 - startable);
  return Math.max(0, 1 - beyondStarters / (startable + 1));
}

export interface SuggestionContext {
  /** Slot types still unfilled in this team's starting lineup. */
  openStarterSlotTypes: string[];
  /** Picks this team still owns, counting the one on the clock. */
  picksRemaining: number;
  /** How many of each position the lineup can start (see depthCapacityByPosition).
   *  Positions absent here get no depth discount. */
  startable?: Partial<Record<Position, number>>;
  /** How many of each position this team already rosters. */
  held?: Partial<Record<Position, number>>;
}

export interface Suggestion {
  player: RankedPlayer;
  /** The suggested player does not fill any open starter slot. */
  isBench: boolean;
  /** Every remaining pick has to fill a starter, so the choice was constrained
   *  to players who do. */
  forced: boolean;
  /** Roster-need weight applied, 0 (draft the best player) to 1 (fill a hole). */
  needWeight: number;
}

/**
 * Pick the player to recommend, given what's available and which starter slots
 * are still open. `scoreOf` supplies the draft-context score (VOR plus tier
 * cliff, next-pick survival, and positional-run pressure); higher wins.
 *
 * Roster need is a weight on that score, not a filter. Filtering to
 * starter-eligible players sounds right but barely bites: with a FLEX open
 * every RB/WR/TE qualifies, so for most of a draft it excludes nobody, and
 * where it does bite it is absolute — a marginally useful third quarterback
 * outranks an elite bench stash purely because a slot has its name on it. The
 * weight instead scales with urgency: with a full complement of picks left,
 * need is worth almost nothing and the best player wins; as picks run out it
 * grows, until every remaining pick has to fill a starter and the old hard
 * filter is reinstated so the draft cannot end with an empty slot.
 *
 * Surplus depth is discounted the other way, by depthValueFactor — league-wide
 * scarcity is not the same as usefulness to this roster.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. Rank K/DEF by raw VOR. They are baselined against one starter per team
 *    (see rankPlayers), so their VOR sits on a completely different scale from
 *    the skill positions — DEF1 carries roughly +20 against DEF13 all draft
 *    long, while static skill VOR decays toward 0 as the board thins. Sorting
 *    everything together by VOR therefore locks onto the top defense from
 *    about round 6 on and never lets go, since the CPU's early-specialist
 *    penalty means nobody ever drafts it away. rankPlayers dodges this by
 *    forcing K/DEF to the bottom of overallRank and chooseCpuPick by charging
 *    that penalty; here, a specialist is only ever a candidate for its own
 *    open starter slot, and only once the skill starters are full. It is never
 *    suggested as a bench stash.
 *
 * 2. Take the first eligible player and stop. Every candidate is scored, so a
 *    tier cliff or low survival odds can promote a slightly lower-VOR player.
 */
export function selectSuggestedPick(
  available: RankedPlayer[],
  context: SuggestionContext,
  scoreOf: (player: RankedPlayer) => number,
): Suggestion | null {
  if (available.length === 0) return null;
  const { openStarterSlotTypes, picksRemaining } = context;

  const openTypes = new Set(openStarterSlotTypes);
  const skillStarterOpen = openStarterSlotTypes.some((slot) => slot !== "K" && slot !== "DEF");
  const specialistDraftable = (player: RankedPlayer) =>
    !isSpecialist(player.position) || (!skillStarterOpen && openTypes.has(player.position));

  /** The best open starter slot this player could fill, or null for none. */
  const slotFor = (player: RankedPlayer): string | null => {
    let flexible: string | null = null;
    for (const slot of openStarterSlotTypes) {
      if (!(SLEEPER_SLOT_ELIGIBLE[slot] ?? []).includes(player.position)) continue;
      if (!isFlexible(slot)) return slot;
      flexible ??= slot;
    }
    return flexible;
  };

  const depthFactor = (player: RankedPlayer) => {
    const startable = context.startable?.[player.position];
    return startable === undefined
      ? 1
      : depthValueFactor(context.held?.[player.position] ?? 0, startable);
  };

  const eligible = available.filter(specialistDraftable);
  if (eligible.length === 0) return null;

  // Every pick left has a starter slot waiting for it: fall back to a hard
  // constraint so a bench stash can't cost the user a starting spot.
  const forced = openStarterSlotTypes.length > 0 && picksRemaining <= openStarterSlotTypes.length;
  const starterCandidates = eligible.filter((player) => slotFor(player) !== null);
  const base = forced && starterCandidates.length > 0 ? starterCandidates : eligible;
  // Drop positions this roster can no longer use, unless doing so leaves
  // nothing (a lineup with every position saturated still has to pick).
  const withRoom = base.filter((player) => depthFactor(player) > 0 || slotFor(player) !== null);
  const pool = withRoom.length > 0 ? withRoom : base;

  const needWeight = openStarterSlotTypes.length === 0
    ? 0
    : Math.min(1, openStarterSlotTypes.length / Math.max(1, picksRemaining));

  const totalFor = (player: RankedPlayer) => {
    const slot = slotFor(player);
    // The need bonus is not discounted: an open slot is worth filling at face
    // value, and a player who fills one is by definition not surplus depth.
    const bonus = slot === null ? 0 : isFlexible(slot) ? NEED_BONUS_FLEXIBLE : NEED_BONUS_DEDICATED;
    const score = scoreOf(player);
    // Only surplus value is discounted — scaling a negative score toward zero
    // would make a saturated position look better rather than worse.
    return (score > 0 ? score * depthFactor(player) : score) + needWeight * bonus;
  };

  let best = pool[0];
  let bestTotal = totalFor(best);
  for (let i = 1; i < pool.length; i++) {
    const total = totalFor(pool[i]);
    if (total > bestTotal) { bestTotal = total; best = pool[i]; }
  }
  return { player: best, isBench: slotFor(best) === null, forced, needWeight };
}

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

/**
 * Pick numbers from `fromPick` onward that a team still gets to make, in
 * order. Pick numbers already in `filled` are skipped: a keeper consumes a
 * slot in the order without being a pick anyone makes, so counting it would
 * both overstate how many picks a team has left and point "who survives to my
 * next pick" at a pick that never happens.
 */
export function remainingPicksForSlot(
  fromPick: number,
  teams: number,
  rounds: number,
  trades: TradedPickLike[],
  slot: number,
  filled: ReadonlySet<number>,
): number[] {
  const picks: number[] = [];
  for (let n = Math.max(1, fromPick); n <= teams * rounds; n++) {
    if (!filled.has(n) && ownerForPick(n, teams, trades) === slot) picks.push(n);
  }
  return picks;
}

export type RosterSlot = "QB" | "RB" | "WR" | "TE" | "FLEX" | "SUPER_FLEX" | "K" | "DEF" | "BN";
export interface RosterAssignment { valid: boolean; assignments: (string | null)[]; openSlots: RosterSlot[] }

/**
 * The slot template for one team. K and DEF are controlled independently —
 * Sleeper leagues can roster one without the other, and a single flag for both
 * gives such a league a slot it can never start (and, through the baselines, a
 * league-wide demand of one per team for a position nobody drafts).
 * `includeDef` defaults to `includeK` so the two-argument form still means
 * "both" or "neither".
 */
export function rosterSlots(config: RosterConfig, includeK = true, includeDef = includeK): RosterSlot[] {
  const repeat = (slot: RosterSlot, count: number) => Array.from({ length: Math.max(0, count) }, () => slot);
  return [
    ...repeat("QB", config.qb), ...repeat("RB", config.rb), ...repeat("WR", config.wr),
    ...repeat("TE", config.te), ...repeat("FLEX", config.flex), ...repeat("SUPER_FLEX", config.superflex),
    ...repeat("K", includeK ? 1 : 0), ...repeat("DEF", includeDef ? 1 : 0), ...repeat("BN", config.bench),
  ];
}

export function eligibleForSlot(position: Position, slot: RosterSlot): boolean {
  if (slot === "BN") return true;
  if (slot === "FLEX") return position === "RB" || position === "WR" || position === "TE";
  if (slot === "SUPER_FLEX") return position === "QB" || position === "RB" || position === "WR" || position === "TE";
  return position === slot;
}

const SLOT_ASSIGN_PRIORITY: Record<RosterSlot, number> = {
  QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0, FLEX: 1, SUPER_FLEX: 2, BN: 3,
};

/**
 * Seat every player in an eligible slot, or report that it can't be done.
 * Specific slots are filled before flexible ones, so a team holding one back
 * shows its RB slot filled and its FLEX open rather than the reverse.
 *
 * This is bipartite matching (slots to players) by augmenting paths — Kuhn's
 * algorithm. The obvious alternative, recursive try-every-player-per-slot with
 * backtracking, is exponential: it re-explores the same slot/player
 * combinations along every branch, and a nearly-full roster is precisely the
 * case with the most branches. A 16-slot lineup holding 13 players did not
 * finish in five minutes, which in a 16-round league froze the CPU draft in
 * the last rounds. Augmenting paths cap the work at slots × players² — a few
 * thousand operations for any real lineup.
 *
 * Greedy assignment would also be fast, and is in fact correct for today's
 * slot types, but only because their eligibility sets happen to nest. That
 * stops holding the moment someone adds Sleeper's WRRB_FLEX and REC_FLEX,
 * which overlap without nesting, and the failure would be a silently wrong
 * "roster full" rather than anything obvious. Matching doesn't care.
 */
export function assignRoster(players: { id: string; position: Position }[], slots: RosterSlot[]): RosterAssignment {
  const unassignable: RosterAssignment = { valid: false, assignments: slots.map(() => null), openSlots: [] };
  if (players.length > slots.length) return unassignable;

  // Fill order: specific slots first, bench last.
  const order = slots
    .map((_, index) => index)
    .sort((a, b) => SLOT_ASSIGN_PRIORITY[slots[a]] - SLOT_ASSIGN_PRIORITY[slots[b]]);

  const slotForPlayer = new Array<number>(players.length).fill(-1);

  /** Seat this slot, displacing earlier ones only if they can move. */
  const seat = (slotIndex: number, tried: boolean[]): boolean => {
    // An unseated player first: displacing someone who is already comfortable
    // is never necessary here, and shuffling for no reason would reorder a
    // roster display that has not changed.
    for (let p = 0; p < players.length; p++) {
      if (tried[p] || slotForPlayer[p] !== -1) continue;
      if (!eligibleForSlot(players[p].position, slots[slotIndex])) continue;
      tried[p] = true;
      slotForPlayer[p] = slotIndex;
      return true;
    }
    for (let p = 0; p < players.length; p++) {
      if (tried[p] || !eligibleForSlot(players[p].position, slots[slotIndex])) continue;
      tried[p] = true;
      if (seat(slotForPlayer[p], tried)) {
        slotForPlayer[p] = slotIndex;
        return true;
      }
    }
    return false;
  };

  // A slot, once seated, is never left empty again — so taking them in
  // priority order is what keeps specific slots ahead of flexible ones.
  let seated = 0;
  for (const slotIndex of order) {
    if (seated === players.length) break; // everyone has a seat
    if (seat(slotIndex, new Array<boolean>(players.length).fill(false))) seated++;
  }
  if (seated !== players.length) return unassignable;

  const assignments: (string | null)[] = slots.map(() => null);
  slotForPlayer.forEach((slotIndex, p) => { assignments[slotIndex] = players[p].id; });
  return { valid: true, assignments, openSlots: slots.filter((_, index) => assignments[index] === null) };
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

/**
 * Same as chooseCpuPick, but never returns null while candidates remain.
 *
 * chooseCpuPick (and assignRoster underneath it) returns null once a team's
 * pick count reaches its configured slot count — e.g. an imported league with
 * more rounds than the local roster config has slots for. Without a fallback
 * the CPU has nothing legal to draft, no pick gets recorded, and callers that
 * re-arm a timer waiting for a pick will do so forever. Falling back to the
 * best-available player (bench-anything) keeps the draft progressing; it's
 * the least surprising behavior since every extra round is effectively bench
 * depth anyway.
 */
export function chooseCpuPickOrBestAvailable(
  candidates: RankedPlayer[], current: { id: string; position: Position }[], slots: RosterSlot[],
  market: (player: RankedPlayer) => number | null, random: () => number,
): RankedPlayer | null {
  const legal = chooseCpuPick(candidates, current, slots, market, random);
  if (legal) return legal;
  if (!candidates.length) return null;
  return [...candidates].sort(
    (a, b) => (market(a) ?? a.overallRank) - (market(b) ?? b.overallRank)
  )[0];
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

export interface KeeperCandidate {
  playerId: string;
  teamSlot: number;
  round: number;
  /** False for a keeper whose round Sleeper never supplied (see
   *  fetchLeagueKeepers in lib/sleeper-league.ts) and the user hasn't fixed
   *  yet. See keeperConflict for why this changes which rules apply. */
  roundConfirmed: boolean;
}

interface KeeperExistingPick {
  pickNumber: number;
  playerId: string;
  isKeeper?: boolean;
}

export type KeeperConflict =
  | "collision-pending-keeper"
  | "collision-existing-pick"
  | "duplicate-pending-keeper"
  | "duplicate-drafted-player";

/**
 * Single source of truth for "can this keeper candidate be added" — shared
 * by MockDraft's one-at-a-time manual "Add" form and its bulk Sleeper
 * import, so the two paths can never disagree about what counts as a
 * collision. Returns the first conflict found, or null if the candidate is
 * clear to add.
 *
 * Pick-number collisions (via pickNumberForSlot) are only checked when the
 * candidate's round is confirmed. A keeper imported from Sleeper's rosters
 * mechanism (as opposed to the draft board) carries no round at all, so
 * every such candidate defaults to round 1 until the user sets one for
 * real — and would then all compute the *same* pickNumberForSlot and
 * "collide" with each other, for a reason that has nothing to do with an
 * actual scheduling conflict. The duplicate-player checks still apply
 * unconditionally: the same player can never legitimately be two keepers,
 * regardless of what round either claims.
 */
export function keeperConflict(
  candidate: KeeperCandidate,
  otherKeepers: KeeperCandidate[],
  existingPicks: KeeperExistingPick[],
  numTeams: number,
): KeeperConflict | null {
  if (candidate.roundConfirmed) {
    const pickNum = pickNumberForSlot(candidate.round, candidate.teamSlot, numTeams);
    if (otherKeepers.some((k) => k.roundConfirmed && pickNumberForSlot(k.round, k.teamSlot, numTeams) === pickNum)) {
      return "collision-pending-keeper";
    }
    if (existingPicks.some((p) => p.pickNumber === pickNum && !p.isKeeper)) {
      return "collision-existing-pick";
    }
  }
  if (otherKeepers.some((k) => k.playerId === candidate.playerId)) return "duplicate-pending-keeper";
  if (existingPicks.some((p) => p.playerId === candidate.playerId)) return "duplicate-drafted-player";
  return null;
}

/** A keeper as it arrives from Sleeper, before defaults are applied. */
export interface ImportedKeeper {
  playerId: string;
  teamSlot: number | null;
  round: number | null;
}

/**
 * Folds a batch of Sleeper-imported keepers into the pending list, applying
 * the same `keeperConflict` rules a manual add goes through. Returns the
 * whole new list plus a per-outcome tally for the status line.
 *
 * A missing `teamSlot` or `round` becomes 1, with `roundConfirmed: false`
 * marking the round as a placeholder rather than a real keep cost.
 *
 * The one case that is neither "add" nor "skip" is an *upgrade*: a player
 * already pending from an earlier rosters-mechanism import carries a
 * placeholder round, and once Sleeper materializes the draft board the same
 * player comes back with a real one. Rejecting that as a duplicate would
 * discard the only authoritative cost the API will ever hand us and leave
 * the user to guess it. So a confirmed round overwrites an unconfirmed one —
 * never the reverse, since a round the user set by hand outranks a default.
 */
export function mergeImportedKeepers(
  pending: KeeperCandidate[],
  incoming: ImportedKeeper[],
  existingPicks: KeeperExistingPick[],
  numTeams: number,
): { keepers: KeeperCandidate[]; added: number; upgraded: number; skipped: number } {
  // Copied so the conflict checks below see each accepted candidate as they
  // go — two incoming rows can collide with each other, not just with the
  // rows that were already pending.
  const keepers: KeeperCandidate[] = pending.map((k) => ({ ...k }));
  let added = 0;
  let upgraded = 0;
  let skipped = 0;

  for (const raw of incoming) {
    const candidate: KeeperCandidate = {
      playerId: raw.playerId,
      teamSlot: raw.teamSlot ?? 1,
      round: raw.round ?? 1,
      roundConfirmed: raw.round !== null,
    };
    const existing = keepers.find((k) => k.playerId === candidate.playerId);
    if (existing && !existing.roundConfirmed && candidate.roundConfirmed) {
      existing.teamSlot = candidate.teamSlot;
      existing.round = candidate.round;
      existing.roundConfirmed = true;
      upgraded++;
      continue;
    }
    if (keeperConflict(candidate, keepers, existingPicks, numTeams)) { skipped++; continue; }
    keepers.push(candidate);
    added++;
  }
  return { keepers, added, upgraded, skipped };
}

/**
 * Fills in `round` for keepers whose round Sleeper never supplied (the
 * rosters mechanism — see fetchLeagueKeepers in lib/sleeper-league.ts),
 * using a per-league "keepers occupy the same N rounds every year"
 * convention inferred by inferKeeperRoundConvention there. This is a
 * best-effort inference layered on top of the real data, not a fact
 * recovered from Sleeper — the API has no way to say which round a
 * roster-mechanism keeper actually costs. All this can do is place it
 * consistently with how the league has always run its keeper rounds.
 *
 * Grouping is by `teamSlot`: within a team, the round-less keepers are
 * sorted by `valueOf` DESCENDING and paired with `conventionRounds`
 * ASCENDING, so the highest-valued keeper takes the earliest (most
 * "expensive") round. That pairing is arbitrary, not recovered — checking
 * it against a real league's multi-year history found no reliable
 * within-team ordering rule at all (the better-valued keeper sat in the
 * LATER round more often than the earlier one, 8 of 12 teams). Given no
 * real signal to sort by, this deliberately picks the pessimistic pairing:
 * charging the best keeper the steepest cost can only understate a
 * keeper's surplus value, never overstate it, so a wrong guess here biases
 * toward "set them free and re-check" rather than talking the user into a
 * bad keep.
 *
 * A `teamSlot: null` group (no known team) is left entirely alone — with no
 * team to reason about, there's no way to know which of that team's rounds
 * are even free. A team with more round-less keepers than convention rounds
 * available gets its surplus left at `round: null` too; those keepers stay
 * unconfirmed for the user to resolve by hand, same as if no convention had
 * been found. And any convention round a team already holds via a
 * board-confirmed `round` (present in the input, never touched by this
 * function) is skipped for that team, so an inference can never collide
 * with authoritative data.
 *
 * Ties in `valueOf` break on `playerId` so that re-running an import over
 * the same data always produces the same assignment.
 */
export function assignKeeperRounds(
  keepers: ImportedKeeper[],
  conventionRounds: number[] | null,
  valueOf: (playerId: string) => number,
): ImportedKeeper[] {
  if (!conventionRounds || conventionRounds.length === 0) {
    return keepers.map((k) => ({ ...k }));
  }
  const ascendingRounds = [...conventionRounds].sort((a, b) => a - b);

  // Rounds each team already holds via a confirmed (board) round, so an
  // inferred round can never be assigned on top of real data.
  const takenByTeam = new Map<number, Set<number>>();
  for (const k of keepers) {
    if (k.teamSlot !== null && k.round !== null) {
      let taken = takenByTeam.get(k.teamSlot);
      if (!taken) { taken = new Set(); takenByTeam.set(k.teamSlot, taken); }
      taken.add(k.round);
    }
  }

  // Round-less keepers, grouped by team. teamSlot: null keepers are excluded
  // here (and therefore left untouched below) — see the doc comment above.
  const byTeam = new Map<number, ImportedKeeper[]>();
  for (const k of keepers) {
    if (k.round !== null || k.teamSlot === null) continue;
    let group = byTeam.get(k.teamSlot);
    if (!group) { group = []; byTeam.set(k.teamSlot, group); }
    group.push(k);
  }

  const assignedRound = new Map<ImportedKeeper, number>();
  for (const [teamSlot, teamKeepers] of byTeam) {
    const taken = takenByTeam.get(teamSlot);
    const availableRounds = taken ? ascendingRounds.filter((r) => !taken.has(r)) : ascendingRounds;
    const byValueDesc = [...teamKeepers].sort((a, b) => {
      const diff = valueOf(b.playerId) - valueOf(a.playerId);
      return diff !== 0 ? diff : a.playerId.localeCompare(b.playerId);
    });
    // Surplus keepers (more round-less keepers than rounds available) fall
    // off the end of availableRounds and are simply never assigned here,
    // leaving their round null.
    byValueDesc.forEach((keeper, i) => {
      if (i < availableRounds.length) assignedRound.set(keeper, availableRounds[i]);
    });
  }

  return keepers.map((k) => {
    const round = assignedRound.get(k);
    return round === undefined ? { ...k } : { ...k, round };
  });
}

/**
 * Merge keeper picks into an existing pick list keyed by pickNumber, without
 * ever silently overwriting a real (non-keeper) pick already at that slot —
 * e.g. an imported pick colliding with a keeper's computed pickNumber. A
 * naive `Map.set` merge (the previous behavior) has no way to tell "replace
 * this placeholder" from "destroy this real pick"; this keeps the ones that
 * collide with a non-keeper pick out of the merge and reports them back as
 * `skipped` so the caller can surface that to the user.
 */
export function mergeKeepersNonDestructive<T extends { pickNumber: number; isKeeper?: boolean }>(
  existing: T[], keeperPicks: T[]
): { merged: T[]; accepted: T[]; skipped: T[] } {
  const byPickNum = new Map(existing.map((p) => [p.pickNumber, p]));
  const accepted: T[] = [];
  const skipped: T[] = [];
  for (const kp of keeperPicks) {
    const current = byPickNum.get(kp.pickNumber);
    if (current && !current.isKeeper) skipped.push(kp);
    else accepted.push(kp);
  }
  if (accepted.length === 0) return { merged: existing, accepted, skipped };
  const merged = new Map(existing.map((p) => [p.pickNumber, p]));
  for (const kp of accepted) merged.set(kp.pickNumber, kp);
  return { merged: [...merged.values()].sort((a, b) => a.pickNumber - b.pickNumber), accepted, skipped };
}

/** Exponential backoff for a polling loop: base, base*2, base*4, ... capped. Resets to `base` at failures=0. */
export function pollBackoffDelay(failures: number, base = 8000, cap = 32000): number {
  return Math.min(base * 2 ** Math.max(0, failures), cap);
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

