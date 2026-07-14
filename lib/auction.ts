import type { Position, RankedPlayer } from "./types";
import { ALL_POSITIONS } from "./types";
import { assignRoster, type RosterSlot } from "./draft";

export interface AuctionBudget { remaining: number; openSlots: number; reservedMinimum: number; spendable: number; maxBid: number; dollarsPerSlot: number }

export function auctionBudget(initial: number, spent: number, rosterSize: number, playersWon: number): AuctionBudget {
  // Persisted state can be malformed (e.g. a non-numeric price sneaks into
  // localStorage); treat non-finite inputs as 0 rather than propagating NaN,
  // which would otherwise make every downstream comparison (e.g. `price >
  // maxBid`) silently evaluate to false and disable the max-bid gate.
  const safeInitial = Number.isFinite(initial) ? initial : 0;
  const safeSpent = Number.isFinite(spent) ? spent : 0;
  const safeRosterSize = Number.isFinite(rosterSize) ? rosterSize : 0;
  const safePlayersWon = Number.isFinite(playersWon) ? playersWon : 0;
  const remaining = safeInitial - safeSpent;
  const openSlots = Math.max(0, safeRosterSize - safePlayersWon);
  const reservedMinimum = openSlots;
  const maxBid = openSlots > 0 ? Math.max(0, remaining - (openSlots - 1)) : 0;
  return { remaining, openSlots, reservedMinimum, spendable: Math.max(0, remaining - reservedMinimum), maxBid, dollarsPerSlot: openSlots ? remaining / openSlots : 0 };
}

export function legalAuctionPurchase(
  price: number, budget: AuctionBudget, roster: { id: string; position: Position }[], nominee: { id: string; position: Position }, slots: RosterSlot[],
): { legal: boolean; reason: string | null } {
  if (!Number.isInteger(price) || price < 1) return { legal: false, reason: "Bid must be a whole dollar of at least $1." };
  // Defense in depth: even if a caller hands us a budget object that wasn't
  // built through auctionBudget() (e.g. reconstructed from malformed
  // persisted state), a non-finite maxBid/openSlots must never silently pass
  // the `price > budget.maxBid` comparison below (NaN comparisons are always
  // false).
  if (!Number.isFinite(budget.maxBid) || !Number.isFinite(budget.openSlots)) {
    return { legal: false, reason: "Budget data is invalid; reset the auction." };
  }
  if (budget.openSlots < 1) return { legal: false, reason: "This roster is full." };
  if (price > budget.maxBid) return { legal: false, reason: `Maximum legal bid is $${budget.maxBid}; $1 must remain for every other open slot.` };
  if (!assignRoster([...roster, nominee], slots).valid) return { legal: false, reason: "This purchase would make the configured roster impossible to complete." };
  return { legal: true, reason: null };
}

/** The set of positions a team could legally nominate a $1 player at, given
 * its current roster and budget. Legality only depends on the team's roster
 * + budget + the candidate's position (never on which specific player is
 * being asked about), so this only needs to test the handful of distinct
 * positions in the game (ALL_POSITIONS) rather than every available player. */
export function legalPositionsForTeam(
  budget: AuctionBudget, roster: { id: string; position: Position }[], slots: RosterSlot[],
): Set<Position> {
  const legal = new Set<Position>();
  for (const position of ALL_POSITIONS) {
    if (legalAuctionPurchase(1, budget, roster, { id: "__probe__", position }, slots).legal) legal.add(position);
  }
  return legal;
}

export function teamAuctionValue(player: RankedPlayer, available: RankedPlayer[], budget: AuctionBudget, legalPositions: Set<Position>): number {
  if (budget.maxBid < 1) return 0;
  const pool = available.reduce((sum, candidate) => legalPositions.has(candidate.position) ? sum + Math.max(0, candidate.vbd) : sum, 0);
  if (player.vbd <= 0 || pool <= 0) return 1;
  const price = 1 + Math.round((Math.max(0, player.vbd) / pool) * budget.spendable);
  return Math.max(1, Math.min(budget.maxBid, price));
}

// ---- Persisted auction state (localStorage) ----
// Malformed/tampered localStorage (e.g. a non-numeric price, or a stray
// object mixed into the array) must be rejected up front rather than flowing
// into budget math where it can produce NaN and silently defeat the max-bid
// gate in legalAuctionPurchase above.

const MAX_TEAMS = 32;
const MIN_TEAMS = 2;
const MAX_BUDGET_PER_TEAM = 10000;

export interface WonPlayer { playerId: string; teamIndex: number; price: number }

export function isValidWonPlayer(value: unknown): value is WonPlayer {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.playerId === "string" && record.playerId.length > 0 &&
    typeof record.teamIndex === "number" && Number.isInteger(record.teamIndex) && record.teamIndex >= 0 && record.teamIndex < MAX_TEAMS &&
    typeof record.price === "number" && Number.isInteger(record.price) && record.price >= 1
  );
}

/** Validator for the persisted "won players" auction state — an array of
 * records, each with a non-empty string player id, an integer teamIndex in
 * range, and an integer price of at least $1. Pass this to useLocalStorage's
 * optional `validate` predicate wherever this shape is loaded. */
export function isValidWonPlayers(value: unknown): value is WonPlayer[] {
  return Array.isArray(value) && value.every(isValidWonPlayer);
}

export interface AuctionSetup { numTeams: number; budgetPerTeam: number; started: boolean }

/** Validator for the persisted auction setup (team count / budget / started
 * flag). Pass this to useLocalStorage's optional `validate` predicate. */
export function isValidAuctionSetup(value: unknown): value is AuctionSetup {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.numTeams === "number" && Number.isInteger(record.numTeams) && record.numTeams >= MIN_TEAMS && record.numTeams <= MAX_TEAMS &&
    typeof record.budgetPerTeam === "number" && Number.isFinite(record.budgetPerTeam) && record.budgetPerTeam >= 1 && record.budgetPerTeam <= MAX_BUDGET_PER_TEAM &&
    typeof record.started === "boolean"
  );
}

export interface ClampedAuctionSetup { numTeams: number; budgetPerTeam: number; adjusted: boolean; messages: string[] }

/** Clamps raw auction-setup form input to the nearest valid bound instead of
 * silently substituting a default (e.g. entering 33 teams should start a
 * 32-team auction, not a silent 12-team fallback), and reports which fields
 * were adjusted so the UI can surface an inline message. */
export function clampAuctionSetupInput(numTeams: number, budgetPerTeam: number, minimumRosterSize: number): ClampedAuctionSetup {
  const messages: string[] = [];

  const teamsValid = Number.isInteger(numTeams) && numTeams >= MIN_TEAMS && numTeams <= MAX_TEAMS;
  const n = Number.isFinite(numTeams) ? Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, Math.round(numTeams))) : 12;
  if (!teamsValid) messages.push(`Number of teams adjusted to ${n} (allowed range ${MIN_TEAMS}-${MAX_TEAMS}).`);

  const minBudget = Math.max(1, minimumRosterSize);
  const budgetValid = Number.isInteger(budgetPerTeam) && budgetPerTeam >= minBudget && budgetPerTeam <= MAX_BUDGET_PER_TEAM;
  const b = Number.isFinite(budgetPerTeam) ? Math.min(MAX_BUDGET_PER_TEAM, Math.max(minBudget, Math.round(budgetPerTeam))) : 200;
  if (!budgetValid) messages.push(`Budget per team adjusted to $${b} (allowed range $${minBudget}-$${MAX_BUDGET_PER_TEAM}).`);

  return { numTeams: n, budgetPerTeam: b, adjusted: messages.length > 0, messages };
}

