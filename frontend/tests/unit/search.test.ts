/**
 * Search matching — the regression suite for the bug that started all this:
 * "Matek H743" returned zero results because the query was substring-matched
 * against a solid slug ("MatekH743"), so any separator broke it.
 */
import { describe, expect, it } from "vitest";
import { matchesQuery, searchFold, searchHaystack } from "../../src/selector-filter";
import { allBoards, board } from "../helpers";

describe("searchFold", () => {
  it("strips every separator so spaced input can match a solid slug", () => {
    expect(searchFold("Matek H743")).toBe("matekh743");
    expect(searchFold("H743-SLIM")).toBe("h743slim");
    expect(searchFold("  Speedy_Bee  F4 ")).toBe("speedybeef4");
  });

  it("is idempotent — folding an already-folded string changes nothing", () => {
    const once = searchFold("Pixhawk 6X Pro");
    expect(searchFold(once)).toBe(once);
  });
});

describe("matchesQuery", () => {
  const b = board("MatekH743");

  it("finds a board when the query carries separators the slug does not", () => {
    // The original bug: every one of these returned 0 results.
    for (const q of ["Matek H743", "matek-h743", "MATEK H743", "  matek   h743  "]) {
      expect(matchesQuery(b, q), `query ${q}`).toBe(true);
    }
  });

  it("matches a retail variant name that appears nowhere else in the data", () => {
    // H743-SLIM has no hwdef of its own; it exists only in manual.variants.
    expect(matchesQuery(b, "H743-SLIM")).toBe(true);
    expect(matchesQuery(b, "h743 wlite")).toBe(true);
  });

  it("requires every token, so extra words narrow rather than widen", () => {
    expect(matchesQuery(b, "matek h743")).toBe(true);
    expect(matchesQuery(b, "matek h743 nonsense")).toBe(false);
  });

  it("treats an empty or whitespace query as matching everything", () => {
    expect(matchesQuery(b, "")).toBe(true);
    expect(matchesQuery(b, "   ")).toBe(true);
  });

  it("does not match an unrelated board", () => {
    expect(matchesQuery(board("CubeOrange"), "matek h743")).toBe(false);
  });
});

describe("searchHaystack", () => {
  it("includes slug, manufacturer, marketing name and variant aliases", () => {
    const hay = searchHaystack(board("MatekH743"));
    expect(hay).toContain("matekh743");
    expect(hay).toContain("matek");
    expect(hay).toContain("h743slim");
  });

  it("is non-empty for every board in the catalog", () => {
    const empty = allBoards().filter((b) => searchHaystack(b).trim() === "");
    expect(empty.map((b) => b.slug)).toEqual([]);
  });
});
