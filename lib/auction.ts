import type { Position, RankedPlayer } from "./types";
import { assignRoster, type RosterSlot } from "./draft";

export interface AuctionBudget { remaining: number; openSlots: number; reservedMinimum: number; spendable: number; maxBid: number; dollarsPerSlot: number }

export function auctionBudget(initial: number, spent: number, rosterSize: number, playersWon: number): AuctionBudget {
  const remaining = initial - spent;
  const openSlots = Math.max(0, rosterSize - playersWon);
  const reservedMinimum = openSlots;
  const maxBid = openSlots > 0 ? Math.max(0, remaining - (openSlots - 1)) : 0;
  return { remaining, openSlots, reservedMinimum, spendable: Math.max(0, remaining - reservedMinimum), maxBid, dollarsPerSlot: openSlots ? remaining / openSlots : 0 };
}

export function legalAuctionPurchase(
  price: number, budget: AuctionBudget, roster: { id: string; position: Position }[], nominee: { id: string; position: Position }, slots: RosterSlot[],
): { legal: boolean; reason: string | null } {
  if (!Number.isInteger(price) || price < 1) return { legal: false, reason: "Bid must be a whole dollar of at least $1." };
  if (budget.openSlots < 1) return { legal: false, reason: "This roster is full." };
  if (price > budget.maxBid) return { legal: false, reason: `Maximum legal bid is $${budget.maxBid}; $1 must remain for every other open slot.` };
  if (!assignRoster([...roster, nominee], slots).valid) return { legal: false, reason: "This purchase would make the configured roster impossible to complete." };
  return { legal: true, reason: null };
}

export function teamAuctionValue(player: RankedPlayer, available: RankedPlayer[], budget: AuctionBudget, legalPositions: Set<Position>): number {
  if (budget.maxBid < 1) return 0;
  const pool = available.reduce((sum, candidate) => legalPositions.has(candidate.position) ? sum + Math.max(0, candidate.vbd) : sum, 0);
  if (player.vbd <= 0 || pool <= 0) return 1;
  const price = 1 + Math.round((Math.max(0, player.vbd) / pool) * budget.spendable);
  return Math.max(1, Math.min(budget.maxBid, price));
}

