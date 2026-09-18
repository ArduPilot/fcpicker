/**
 * Approximate search matching.
 *
 * Opt-in, because an exact search is predictable and quietly returning
 * near-misses is worse when you already know what you are looking for. The
 * value is in rescuing a query that would otherwise return nothing at all.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  filtersFromParams,
  filtersToParams,
  fuzzyContains,
  fuzzyTolerance,
  matchesQuery,
  type Filters,
} from "../../src/selector-filter";
import { allBoards, board } from "../helpers";

describe("fuzzyTolerance", () => {
  it("allows nothing for very short tokens", () => {
    // At three characters an allowance of one matches most of the catalog,
    // which turns a shortlist into noise.
    expect(fuzzyTolerance("h7")).toBe(0);
    expect(fuzzyTolerance("f40")).toBe(0);
  });

  it("scales with token length", () => {
    expect(fuzzyTolerance("h743")).toBe(1);
    expect(fuzzyTolerance("pixhawk")).toBe(1);
    expect(fuzzyTolerance("speedybeef405")).toBe(2);
  });
});

describe("fuzzyContains", () => {
  it("treats an adjacent swap as one mistake, not two", () => {
    // The whole reason this is Damerau rather than plain Levenshtein:
    // transposition is the most common typing error, and charging two for it
    // would exhaust a short token's budget on a single fumbled keystroke.
    expect(fuzzyContains("pixhawk6x", "pixhwak", 1)).toBe(true);
    expect(fuzzyContains("matekh743", "h734", 1)).toBe(true);
  });

  it("finds the token anywhere in the haystack, not just at the start", () => {
    expect(fuzzyContains("holybro kakuteh7 wing", "kakuteh7", 0)).toBe(true);
    expect(fuzzyContains("holybro kakuteh7 wing", "kakueth7", 1)).toBe(true);
  });

  it("still refuses a token that is simply wrong", () => {
    expect(fuzzyContains("matekh743", "cuborange", 2)).toBe(false);
  });

  it("falls back to exact containment when no errors are allowed", () => {
    expect(fuzzyContains("matekh743", "h743", 0)).toBe(true);
    expect(fuzzyContains("matekh743", "h734", 0)).toBe(false);
  });
});

describe("matchesQuery with fuzzy enabled", () => {
  // Each of these returns nothing at all without it.
  it.each([
    ["Pixhwak 6X", "Pixhawk6X"],
    ["Matek H734", "MatekH743"],
    ["Kakuet H7", "KakuteH7"],
    ["Cube Ornage", "CubeOrange"],
  ])("rescues %s", (query, expected) => {
    const boards = allBoards();
    expect(boards.filter((b) => matchesQuery(b, query, false))).toHaveLength(0);
    expect(boards.filter((b) => matchesQuery(b, query, true)).map((b) => b.slug))
      .toContain(expected);
  });

  it("does not change what an exact query already found", () => {
    // Turning it on must never remove a result, only add.
    const boards = allBoards();
    for (const q of ["MatekH743", "matek h743", "H743-SLIM", "cube orange"]) {
      const exact = boards.filter((b) => matchesQuery(b, q, false)).map((b) => b.slug);
      const fuzzy = boards.filter((b) => matchesQuery(b, q, true)).map((b) => b.slug);
      expect(fuzzy, `query ${q}`).toEqual(expect.arrayContaining(exact));
    }
  });

  it("is off by default", () => {
    expect(matchesQuery(board("MatekH743"), "Matek H734")).toBe(false);
  });
});

describe("filter URL round-trip", () => {
  it("writes nothing for a default filter set", () => {
    // A plain listing should stay at a bare "/" rather than a wall of
    // parameters that all just repeat the defaults.
    expect(filtersToParams(DEFAULTS).toString()).toBe("");
  });

  it("restores every kind of filter value", () => {
    const f: Filters = {
      ...DEFAULTS,
      query: "matek h743",
      fuzzy: true,
      mcus: ["STM32 H7", "STM32 F7"],
      vehicles: ["copter", "plane"],
      uart: 6,
      partnersOnly: true,
      aiWeightMin: 20,
      manufacturers: ["matek", "holybro"],
    };
    expect(filtersFromParams(filtersToParams(f))).toEqual(f);
  });

  it("treats an absent parameter as the default, not as empty", () => {
    // manufacturers defaults to null ("everything ticked"), which is not the
    // same as [] ("nothing ticked") — conflating them would hide every board.
    const back = filtersFromParams(new URLSearchParams("query=cube"));
    expect(back.manufacturers).toBeNull();
    expect(back.query).toBe("cube");
    expect(back.mcus).toEqual([]);
  });
});
