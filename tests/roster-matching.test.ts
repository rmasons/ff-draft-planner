import { describe, expect, it } from "vitest";
import { assignRoster, eligibleForSlot, rosterSlots, type RosterSlot } from "../lib/draft";
import { DEFAULT_ROSTER } from "../lib/presets";
import type { Position } from "../lib/types";

const at = (positions: Position[]) => positions.map((position, i) => ({ id: `p${i}`, position }));

/** Reference implementation: exhaustive search, correct by construction but
 *  exponential. Only ever run here, on inputs small enough to finish. */
function canSeatAll(positions: Position[], slots: RosterSlot[]): boolean {
  const used = new Array<boolean>(slots.length).fill(false);
  const place = (i: number): boolean => {
    if (i === positions.length) return true;
    for (let s = 0; s < slots.length; s++) {
      if (used[s] || !eligibleForSlot(positions[i], slots[s])) continue;
      used[s] = true;
      if (place(i + 1)) return true;
      used[s] = false;
    }
    return false;
  };
  return place(0);
}

describe("assignRoster", () => {
  const lineup: RosterSlot[] = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF"];

  it("fills specific slots before flexible ones", () => {
    const { valid, assignments, openSlots } = assignRoster(at(["RB"]), ["RB", "FLEX", "BN"]);
    expect(valid).toBe(true);
    expect(assignments).toEqual(["p0", null, null]);
    expect(openSlots).toEqual(["FLEX", "BN"]);
  });

  it("displaces a seated player when that is the only way to fit everyone", () => {
    // The lone RB slot goes to the first back; the second has to reach FLEX.
    const { valid, assignments } = assignRoster(at(["RB", "RB"]), ["RB", "FLEX"]);
    expect(valid).toBe(true);
    expect(assignments).toEqual(["p0", "p1"]);
  });

  it("routes a quarterback past FLEX into SUPER_FLEX", () => {
    const { valid, assignments } = assignRoster(at(["QB", "QB"]), ["QB", "FLEX", "SUPER_FLEX"]);
    expect(valid).toBe(true);
    expect(assignments).toEqual(["p0", null, "p1"]);
  });

  it("rejects a lineup that cannot seat everyone", () => {
    const result = assignRoster(at(["K", "K"]), ["K", "FLEX", "SUPER_FLEX"]);
    expect(result.valid).toBe(false);
    expect(result.assignments).toEqual([null, null, null]);
    expect(result.openSlots).toEqual([]);
  });

  it("rejects more players than slots", () => {
    expect(assignRoster(at(["RB", "WR", "TE"]), ["FLEX", "BN"]).valid).toBe(false);
  });

  it("seats a full 10-slot lineup", () => {
    const roster = at(["QB", "QB", "RB", "RB", "WR", "WR", "TE", "RB", "K", "DEF"]);
    const { valid, openSlots } = assignRoster(roster, lineup);
    expect(valid).toBe(true);
    expect(openSlots).toEqual([]);
  });

  it("agrees with exhaustive search across every small lineup", () => {
    const positions: Position[] = ["QB", "RB", "WR", "TE", "K", "DEF"];
    const slotSets: RosterSlot[][] = [
      ["QB", "FLEX"],
      ["RB", "FLEX", "SUPER_FLEX"],
      ["WR", "WR", "FLEX"],
      ["QB", "RB", "WR", "TE", "FLEX", "SUPER_FLEX"],
      ["K", "DEF", "BN"],
      ["FLEX", "SUPER_FLEX", "BN"],
    ];
    for (const slots of slotSets) {
      // Every roster of up to 3 players drawn from all six positions.
      for (let a = 0; a < positions.length; a++) {
        for (let b = 0; b < positions.length; b++) {
          for (let c = 0; c < positions.length; c++) {
            for (const roster of [[positions[a]], [positions[a], positions[b]], [positions[a], positions[b], positions[c]]]) {
              const label = `${roster.join("+")} into ${slots.join("/")}`;
              const result = assignRoster(at(roster), slots);
              expect(result.valid, label).toBe(canSeatAll(roster, slots));
              if (!result.valid) continue;
              // Whatever it produced must actually be legal and complete.
              const seated = result.assignments.filter((x): x is string => x !== null);
              expect(new Set(seated).size, label).toBe(roster.length);
              result.assignments.forEach((id, i) => {
                if (id !== null) expect(eligibleForSlot(roster[Number(id.slice(1))], slots[i]), label).toBe(true);
              });
            }
          }
        }
      }
    }
  });

  it("stays fast on the nearly-full rosters that used to hang", () => {
    // 16 slots holding 13-16 players: the exponential matcher did not finish
    // this in five minutes, freezing CPU picks in the final rounds.
    const slots = rosterSlots({ ...DEFAULT_ROSTER, qb: 1, rb: 2, wr: 2, te: 1, flex: 1, bench: 7 });
    const deep: Position[] = ["QB", "RB", "RB", "WR", "WR", "TE", "RB", "WR", "QB", "TE", "RB", "WR", "WR", "QB", "K", "DEF"];
    const started = Date.now();
    for (let held = 13; held <= 16; held++) {
      expect(assignRoster(at(deep.slice(0, held)), slots).valid, `${held} players`).toBe(true);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });
});
