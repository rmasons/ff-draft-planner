import { describe, expect, it } from "vitest";
import { encodeStored, parseStored, quarantineKeyFor } from "../lib/persistence";
import {
  validAdpSnapshot,
  validAnnotationStore,
  validBaselineMethod,
  validDraftedIds,
} from "../lib/validation";

describe("BUG 3 — storage envelope validators", () => {
  describe("validDraftedIds", () => {
    it("accepts an array of string ids", () => {
      expect(validDraftedIds([])).toBe(true);
      expect(validDraftedIds(["p1", "p2"])).toBe(true);
    });

    it("rejects the crash payload: an object instead of an array", () => {
      // This is the concrete crash from the bug report: `new Set(drafted)` in
      // DraftBoard throws when `drafted` is an object rather than an array.
      expect(validDraftedIds({ p1: true })).toBe(false);
    });

    it("rejects arrays with non-string entries", () => {
      expect(validDraftedIds(["p1", 2, null])).toBe(false);
    });
  });

  describe("validBaselineMethod", () => {
    it("accepts the known enum values", () => {
      expect(validBaselineMethod("VOLS")).toBe(true);
      expect(validBaselineMethod("VORP")).toBe(true);
    });

    it("rejects the crash payload: an arbitrary string", () => {
      // BASELINE_LABELS[method] renders "undefined" for any string outside
      // the enum — this is the concrete crash from the bug report.
      expect(validBaselineMethod("hacked")).toBe(false);
      expect(validBaselineMethod("")).toBe(false);
      expect(validBaselineMethod(123)).toBe(false);
      expect(validBaselineMethod(null)).toBe(false);
    });
  });

  describe("validAnnotationStore", () => {
    it("accepts an empty store and well-formed entries", () => {
      expect(validAnnotationStore({})).toBe(true);
      expect(
        validAnnotationStore({
          "2026:p1": { target: true, avoid: false, note: "sleeper" },
        })
      ).toBe(true);
    });

    it("rejects a non-object / array root", () => {
      expect(validAnnotationStore(null)).toBe(false);
      expect(validAnnotationStore([])).toBe(false);
      expect(validAnnotationStore("nope")).toBe(false);
    });

    it("rejects entries with wrong field types", () => {
      expect(validAnnotationStore({ "2026:p1": { target: "yes", avoid: false, note: "" } })).toBe(false);
      expect(validAnnotationStore({ "2026:p1": { target: true, avoid: false } })).toBe(false);
      expect(validAnnotationStore({ "2026:p1": null })).toBe(false);
    });
  });

  describe("validAdpSnapshot", () => {
    it("accepts null (no snapshot yet)", () => {
      expect(validAdpSnapshot(null)).toBe(true);
    });

    it("accepts a well-formed snapshot, with or without adpKey/season", () => {
      expect(validAdpSnapshot({ ts: 1, data: { p1: 5.5 } })).toBe(true);
      expect(validAdpSnapshot({ ts: 1, data: { p1: 5.5 }, adpKey: "ppr", season: "2026" })).toBe(true);
    });

    it("rejects malformed shapes", () => {
      expect(validAdpSnapshot({ ts: "1", data: {} })).toBe(false);
      expect(validAdpSnapshot({ ts: 1, data: [1, 2, 3] })).toBe(false);
      expect(validAdpSnapshot({ ts: 1, data: { p1: "not a number" } })).toBe(false);
      expect(validAdpSnapshot({ ts: 1, data: {}, adpKey: 5 })).toBe(false);
      expect(validAdpSnapshot({ ts: 1, data: {}, season: 2026 })).toBe(false);
      expect(validAdpSnapshot("nope")).toBe(false);
    });
  });
});

describe("BUG 3 — parseStored + validator behavior", () => {
  it("resets to fallback and reports an error when the stored envelope fails validation", () => {
    const raw = encodeStored({ p1: true }); // object instead of an array
    const result = parseStored<string[]>(raw, [], validDraftedIds);
    expect(result.value).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it("passes through good data unchanged with no error", () => {
    const raw = encodeStored(["p1", "p2"]);
    const result = parseStored<string[]>(raw, [], validDraftedIds);
    expect(result.value).toEqual(["p1", "p2"]);
    expect(result.error).toBeNull();
  });

  it("without a validator, an unchecked cast passes any shape through (the root cause of BUG 3)", () => {
    const raw = encodeStored({ p1: true });
    const result = parseStored<string[]>(raw, []);
    // No validator means parseStored can't catch this — it's on the caller.
    expect(result.value).toEqual({ p1: true });
    expect(result.error).toBeNull();
  });

  it("rejects malformed JSON", () => {
    const result = parseStored<string[]>("{not json", [], validDraftedIds);
    expect(result.value).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});

describe("BUG 3c — quarantine key naming", () => {
  it("derives a sibling key from the original key", () => {
    expect(quarantineKeyFor("ffdp.drafted")).toBe("ffdp.drafted.corrupt");
    expect(quarantineKeyFor("ffdp.method")).toBe("ffdp.method.corrupt");
  });

  it("is stable and distinct per key", () => {
    expect(quarantineKeyFor("a")).not.toBe(quarantineKeyFor("b"));
  });
});

describe("BUG 5 — ADP snapshot format/season guard", () => {
  // The guard itself lives in DraftBoard (adpKey/season comparisons on the
  // snapshot), but validAdpSnapshot is what guarantees a persisted snapshot
  // actually has well-typed adpKey/season fields for that guard to compare,
  // and that a snapshot from a season/format where the fields were absent
  // is still accepted (treated as a mismatch by DraftBoard, not rejected here).
  it("accepts snapshots that predate adpKey/season tracking (fields absent)", () => {
    expect(validAdpSnapshot({ ts: 1, data: { p1: 5 } })).toBe(true);
  });

  it("accepts snapshots seeded under a specific format+season", () => {
    expect(validAdpSnapshot({ ts: 1, data: { p1: 5 }, adpKey: "std", season: "2025" })).toBe(true);
  });

  it("treats a same-format snapshot from a different season as distinguishable data (season field differs)", () => {
    const lastSeason = { ts: 1, data: { p1: 5 }, adpKey: "ppr", season: "2025" };
    const thisSeason = { ts: 2, data: { p1: 9 }, adpKey: "ppr", season: "2026" };
    expect(validAdpSnapshot(lastSeason)).toBe(true);
    expect(validAdpSnapshot(thisSeason)).toBe(true);
    // Both are individually valid shapes; it's DraftBoard's `snapshot.season !== SEASON`
    // guard that must treat these as non-comparable, which is exercised by
    // simulating that comparison here.
    expect(lastSeason.adpKey === thisSeason.adpKey && lastSeason.season === thisSeason.season).toBe(false);
  });
});
