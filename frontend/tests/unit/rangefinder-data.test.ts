/**
 * Rangefinder catalog data invariants — the frontend-contract counterpart of
 * tests/test_rangefinders.py. Rangefinder pages are pre-rendered and linked
 * exactly like board pages, from the real 44-device rangefinders.json, so
 * the same bugs a board can have (a blank label, a colliding detail-route
 * id, a device indistinguishable from another in the list) apply here too.
 */
import { describe, expect, it } from "vitest";
import { allRangefinders } from "../helpers";

describe("display_name / class_name", () => {
  it("is non-empty for every rangefinder", () => {
    const bad = allRangefinders().filter((r) => !r.display_name?.trim() || !r.class_name?.trim());
    expect(bad.map((r) => r.slug)).toEqual([]);
  });
});

describe("detail-route id", () => {
  it("is unique across the catalog (that string is the /rangefinder/ URL)", () => {
    const ids = allRangefinders().map((r) => `${r.kind}-${r.slug}`);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });
});

describe("type_ids", () => {
  it("has only positive integer param_values", () => {
    const bad = allRangefinders().flatMap((r) =>
      r.type_ids
        .filter((t) => !Number.isInteger(t.param_value) || t.param_value <= 0)
        .map((t) => `${r.slug}:${t.enum}=${t.param_value}`),
    );
    expect(bad).toEqual([]);
  });
});

describe("kind vs directionality", () => {
  it("proximity devices are omnidirectional and rangefinder devices are unidirectional", () => {
    // Checked against the real catalog first: every current proximity device
    // is omnidirectional and every current rangefinder device is
    // unidirectional — a 1:1 correlation in practice, though nothing in the
    // schema forces it. Assert what is actually true today so a future
    // device that breaks the correlation is a visible decision, not a
    // silent one.
    const badProximity = allRangefinders()
      .filter((r) => r.kind === "proximity" && r.directionality !== "omnidirectional")
      .map((r) => r.slug);
    const badRangefinder = allRangefinders()
      .filter((r) => r.kind === "rangefinder" && r.directionality !== "unidirectional")
      .map((r) => r.slug);
    expect(badProximity).toEqual([]);
    expect(badRangefinder).toEqual([]);
  });
});

describe("manual.product_url", () => {
  it("is an absolute https URL when set", () => {
    const bad = allRangefinders()
      .filter((r) => r.manual?.product_url && !/^https:\/\//.test(r.manual.product_url))
      .map((r) => [r.slug, r.manual?.product_url]);
    expect(bad).toEqual([]);
  });
});

describe("display_name uniqueness", () => {
  it("has no two devices sharing a display_name", () => {
    const names = allRangefinders().map((r) => r.display_name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });
});
