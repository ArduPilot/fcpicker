/**
 * Data-layer helpers — manufacturer normalisation, purchase-link precedence
 * and partner status. These back the "who made this and where do I buy it"
 * UI, which depends on folding free-text hwdef manufacturer strings onto a
 * curated registry (data/manufacturers.json) without losing anything when
 * the registry doesn't recognise a name.
 */
import { describe, expect, it } from "vitest";
import {
  asset,
  boardManufacturer,
  isPartnerBoard,
  manufacturerFor,
  manufacturerKey,
  partnerStatus,
  purchaseUrl,
} from "../../src/data";
import type { Board, Manufacturer } from "../../src/types";
import { board, manufacturerIndex } from "../helpers";

describe("asset", () => {
  it("resolves a root-relative path against the deployed base", () => {
    // import.meta.env.BASE_URL is "/" under test (vitest doesn't build for a
    // sub-path deploy), so the root case is all that's checkable here. The
    // "/fcpicker/" sub-path behaviour is baked in at build time via Vite's
    // `base` config and is covered by the e2e suite instead.
    expect(asset("/boards.json")).toBe("/boards.json");
  });

  it("tolerates a path with no leading slash", () => {
    expect(asset("boards.json")).toBe("/boards.json");
  });
});

describe("manufacturerKey", () => {
  it("normalises case and punctuation", () => {
    expect(manufacturerKey("Matek Systems")).toBe("matek systems");
    expect(manufacturerKey("  Speedy-Bee!! ")).toBe("speedy bee");
  });

  it("returns the empty-string key for a missing manufacturer", () => {
    expect(manufacturerKey(null)).toBe("");
    expect(manufacturerKey(undefined)).toBe("");
  });

  it("with the registry index, folds every spelling of Matek onto one key", () => {
    const index = manufacturerIndex();
    const keys = new Set(
      ["Matek", "Mateksys", "Matek Systems"].map((raw) => manufacturerKey(raw, index)),
    );
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("matek");
  });
});

describe("manufacturerFor", () => {
  it("returns the registry entry for a board's manufacturer", () => {
    const index = manufacturerIndex();
    const m = manufacturerFor("Mateksys", index);
    expect(m?.id).toBe("matek");
    expect(m?.name).toBe("Matek Systems");
  });

  it("returns null for a manufacturer the registry doesn't recognise", () => {
    const index = manufacturerIndex();
    expect(manufacturerFor("Totally Unknown Vendor Inc", index)).toBeNull();
  });
});

describe("purchaseUrl", () => {
  it("returns null when there is no manufacturer", () => {
    expect(purchaseUrl(null)).toBeNull();
  });

  it("prefers store_url over everything else", () => {
    const m = mkManufacturer({
      store_url: "https://store.example.com",
      distributors_url: "https://resellers.example.com",
      website: "https://example.com",
    });
    expect(purchaseUrl(m)).toBe("https://store.example.com");
  });

  it("falls back to distributors_url when there is no store", () => {
    const m = mkManufacturer({
      store_url: null,
      distributors_url: "https://resellers.example.com",
      website: "https://example.com",
    });
    expect(purchaseUrl(m)).toBe("https://resellers.example.com");
  });

  it("falls back to website when there is no store or distributor list", () => {
    const m = mkManufacturer({ store_url: null, distributors_url: null, website: "https://example.com" });
    expect(purchaseUrl(m)).toBe("https://example.com");
  });

  it("returns null when the manufacturer has no links at all", () => {
    const m = mkManufacturer({ store_url: null, distributors_url: null, website: null });
    expect(purchaseUrl(m)).toBeNull();
  });

  it("Matek has no direct store, so the real registry entry resolves to the resellers URL", () => {
    const index = manufacturerIndex();
    const matek = manufacturerFor("Matek", index);
    expect(matek?.store_url).toBeNull();
    expect(purchaseUrl(matek)).toBe(matek?.distributors_url);
  });
});

describe("boardManufacturer", () => {
  it("prefers manual.manufacturer over the top-level manufacturer, on real data", () => {
    // Lectron-Pi5-H7's hwdef-derived manufacturer is the short "Lectron"; the
    // curated manual block has the full company name. If precedence ever
    // flipped, this board's card would regress to the shorter name.
    const b = board("Lectron-Pi5-H7");
    expect(b.manufacturer).toBe("Lectron");
    expect(b.manual?.manufacturer).toBe("Lectron Technologies");
    expect(boardManufacturer(b)).toBe("Lectron Technologies");
  });

  it("prefers manual.manufacturer over the top-level manufacturer, synthetically", () => {
    const b = { manufacturer: "Top Level Co", manual: { manufacturer: "Manual Co" } } as Board;
    expect(boardManufacturer(b)).toBe("Manual Co");
  });

  it("falls back to the top-level manufacturer when manual has none", () => {
    const b = { manufacturer: "Top Level Co", manual: { manufacturer: null } } as Board;
    expect(boardManufacturer(b)).toBe("Top Level Co");
  });
});

describe("partnerStatus / isPartnerBoard", () => {
  it("is 'partner' for a real ArduPilot Corporate Partner board", () => {
    const index = manufacturerIndex();
    const b = board("AEROFOX-H7");
    expect(partnerStatus(b, index)).toBe("partner");
    expect(isPartnerBoard(b, index)).toBe(true);
  });

  it("is 'non-partner' for a real board whose maker is a known non-partner", () => {
    const index = manufacturerIndex();
    const b = board("3DRControlZeroG");
    expect(partnerStatus(b, index)).toBe("non-partner");
    expect(isPartnerBoard(b, index)).toBe(false);
  });

  it("is 'unknown' — never 'non-partner' — for a board with no manufacturer at all", () => {
    // "unknown" must never render as a cross in the UI: that would assert a
    // fact (this vendor is not a partner) we have no way to know.
    const index = manufacturerIndex();
    const b = board("bbbmini");
    expect(boardManufacturer(b)).toBeNull();
    expect(partnerStatus(b, index)).toBe("unknown");
    expect(isPartnerBoard(b, index)).toBe(false);
  });
});

function mkManufacturer(overrides: Partial<Manufacturer>): Manufacturer {
  return {
    id: "test",
    name: "Test Co",
    aliases: ["test"],
    website: null,
    store_url: null,
    distributors_url: null,
    country: null,
    verified: false,
    ardupilot_partner: false,
    ...overrides,
  };
}
