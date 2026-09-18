/**
 * The Selector's filtering core, kept out of the component file.
 *
 * Pure logic over a Board — no JSX — so it can be unit-tested without mounting
 * the page. It also keeps Selector.tsx exporting only components, which is
 * what React Fast Refresh requires.
 */
import {
  boardManufacturer,
  isPartnerBoard,
  manufacturerKey,
  mcuFamilyLabel,
  type ManufacturerIndex,
} from "./data";
import type { Board, VehicleType } from "./types";

// Physical maximum number of IMU slots any ArduPilot autopilot ships with.
// Counts above this are capped; the raw value is exposed for the overcount
// flag so the user knows the data needs review.
export const MAX_IMU_SLOTS = 3;

function imuSlotCountRaw(b: Board): number {
  const slots = new Set<string>();
  let unslotted = 0;
  for (const s of b.imus) {
    if (s.slot) slots.add(s.slot);
    else unslotted += 1;
  }
  return slots.size + unslotted;
}

// Displayed IMU count.
//
// A human-set `manual.imu_count` is trusted as-is: it is the verified answer
// for boards that genuinely carry more IMU footprints than ArduPilot will
// instantiate (the QioTek Zealot and VUAV V7pro hwdefs each declare four
// chip-selects). Only an unverified parse is clamped, and tools/sanity_check.py
// fails the build when a parse exceeds the ceiling without an override — so
// that clamp should never actually fire.
export function imuSlotCount(b: Board): number {
  if (b.manual?.imu_count != null) return b.manual.imu_count;
  return Math.min(imuSlotCountRaw(b), MAX_IMU_SLOTS);
}

export interface Filters {
  query: string;
  // Allow approximate matches in the search box. Off by default.
  fuzzy: boolean;
  // Ticked manufacturer keys (see manufacturerKey). null = everything ticked,
  // i.e. no filter. "" is the key for boards with no manufacturer.
  manufacturers: string[] | null;
  platform: string;
  // Selected MCU family labels. Empty = no filter. A board has exactly one
  // family, so these are OR'd (unlike vehicles, which are AND'd).
  mcus: string[];
  vehicles: VehicleType[];
  uart: number;
  i2c: number;
  spi: number;
  can: number;
  pwm: number;
  usb: number;
  powerInputs: number;
  imus: number;
  canfd: boolean;
  ethernet: boolean;
  sdcard: boolean;
  sbusOut: boolean;
  iomcu: boolean;
  bdshot: boolean;
  minFlash: number;
  includeDiscontinued: boolean;
  // Show only boards whose maker is an ArduPilot Corporate Partner.
  partnersOnly: boolean;
  // Rank partner boards above non-partners, before the column sort applies.
  // Opt-in: the default listing stays a neutral spec comparison.
  partnersFirst: boolean;
  // Experimental — filters over the unverified, AI-gathered `ai` spec block.
  // Off by default; the controls are disabled until aiEnabled is turned on.
  aiEnabled: boolean;
  // Numeric bounds: null = no bound on that side.
  aiWeightMin: number | null;
  aiWeightMax: number | null;
  aiSizeMin: number | null;
  aiSizeMax: number | null;
  aiVoltMin: number | null;
  aiVoltMax: number | null;
  // Mounting-hole pattern, e.g. "30.5x30.5"; "ANY" = no filter.
  aiMount: string;
  // Minimum number of BEC outputs listed for the board.
  aiBecMin: number;
  aiHasOsd: boolean;
  aiHasWireless: boolean;
  aiHasBlackbox: boolean;
}

export const DEFAULTS: Filters = {
  query: "",
  fuzzy: false,
  manufacturers: null,
  platform: "ANY",
  mcus: [],
  vehicles: [],
  uart: 0,
  i2c: 0,
  spi: 0,
  can: 0,
  pwm: 0,
  usb: 0,
  powerInputs: 0,
  imus: 1,
  canfd: false,
  ethernet: false,
  sdcard: false,
  sbusOut: false,
  iomcu: false,
  bdshot: false,
  minFlash: 0,
  includeDiscontinued: false,
  partnersOnly: false,
  partnersFirst: false,
  aiEnabled: false,
  aiWeightMin: null,
  aiWeightMax: null,
  aiSizeMin: null,
  aiSizeMax: null,
  aiVoltMin: null,
  aiVoltMax: null,
  aiMount: "ANY",
  aiBecMin: 0,
  aiHasOsd: false,
  aiHasWireless: false,
  aiHasBlackbox: false,
};

// true when v lies inside [lo, hi] (either bound may be absent).
function inBounds(v: number, lo: number | null, hi: number | null): boolean {
  return (lo == null || v >= lo) && (hi == null || v <= hi);
}

// true when the board supports bidirectional DShot directly or via a sibling
// "<slug>-bdshot" firmware target.
export const hasBdshot = (b: Board) => b.io.bdshot || b.bdshot_target != null;

// Fold a string to its searchable form: lowercase, with every separator
// removed. Slugs are written solid ("MatekH743") while people type the product
// name with spaces and hyphens ("Matek H743", "H743-SLIM"), so both sides have
// to lose their separators before they can be compared.
export function searchFold(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Everything a board can be found by. Variant names matter most: a retail
// product like the H743-SLIM has no hwdef of its own, so this is the only
// place its name appears.
export function searchHaystack(b: Board): string {
  const parts: string[] = [b.slug, b.name, boardManufacturer(b) ?? "", b.bdshot_target?.slug ?? ""];
  if (b.ai?.marketing_name) parts.push(b.ai.marketing_name);
  if (b.ai?.family) parts.push(b.ai.family);
  for (const v of b.manual?.variants ?? []) {
    parts.push(v.name, ...v.aliases);
  }
  return parts.map(searchFold).join(" ");
}

// How many single-character mistakes a token may contain before it stops
// matching. Short tokens get none: at three characters an allowance of one
// would match almost anything, and the results become noise rather than a
// shortlist.
export function fuzzyTolerance(token: string): number {
  if (token.length < 4) return 0;
  if (token.length < 8) return 1;
  return 2;
}

// Approximate substring search: is `token` present in `hay` within `maxErrors`
// edits — insertion, deletion, substitution, or a swap of two adjacent
// characters?
//
// The swap matters more than it looks. Transposition is the most common typing
// mistake by some distance ("pixhwak", "h734", "ornage"), and plain Levenshtein
// charges two edits for one, so a single fumbled keystroke would blow the whole
// budget for a short token. Including it (Damerau-Levenshtein) is what makes
// this useful rather than merely present.
//
// The table's first row stays at zero, which lets a match begin at any offset —
// so this finds the token *inside* the haystack rather than comparing the two
// whole strings. Board names are short and there are a few hundred of them, so
// the quadratic cost is irrelevant in practice.
export function fuzzyContains(hay: string, token: string, maxErrors: number): boolean {
  if (maxErrors <= 0) return hay.includes(token);
  if (token.length === 0) return true;
  if (hay.length === 0) return false;

  const width = token.length + 1;
  // Three rows: two back (for transposition), one back, and the current one.
  let twoBack = new Array<number>(width).fill(0);
  let prev = Array.from({ length: width }, (_, j) => j);
  const cur = new Array<number>(width);

  for (let i = 1; i <= hay.length; i += 1) {
    cur[0] = 0; // a match may begin anywhere in the haystack
    for (let j = 1; j <= width - 1; j += 1) {
      const cost = hay[i - 1] === token[j - 1] ? 0 : 1;
      let best = Math.min(prev[j - 1] + cost, prev[j] + 1, cur[j - 1] + 1);
      if (
        i > 1 && j > 1 &&
        hay[i - 1] === token[j - 2] &&
        hay[i - 2] === token[j - 1]
      ) {
        best = Math.min(best, twoBack[j - 2] + 1); // adjacent swap costs one
      }
      cur[j] = best;
    }
    if (cur[width - 1] <= maxErrors) return true;
    twoBack = prev;
    prev = cur.slice();
  }
  return false;
}

// Every whitespace-separated token must appear, so "matek h743" narrows rather
// than widening — each token is matched against the folded haystack, which is
// why a query with separators still finds a solid slug.
//
// With `fuzzy` on, a token may also match approximately, which turns a typo
// ("pixhwak") into a result instead of an empty list. Off by default: exact
// matching is predictable, and a search that quietly returns near-misses is
// worse when you knew exactly what you were looking for.
export function matchesQuery(b: Board, query: string, fuzzy = false): boolean {
  const tokens = query.trim().split(/\s+/).map(searchFold).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = searchHaystack(b);
  return tokens.every((t) =>
    hay.includes(t) || (fuzzy && fuzzyContains(hay, t, fuzzyTolerance(t))),
  );
}

export function passes(b: Board, f: Filters, mfrIndex?: ManufacturerIndex): boolean {
  if (!f.includeDiscontinued && b.manual?.discontinued) return false;
  if (f.partnersOnly && !(mfrIndex && isPartnerBoard(b, mfrIndex))) return false;
  if (f.query && !matchesQuery(b, f.query, f.fuzzy)) return false;
  if (f.manufacturers != null && !f.manufacturers.includes(manufacturerKey(boardManufacturer(b), mfrIndex)))
    return false;
  if (f.platform !== "ANY" && b.platform !== f.platform) return false;
  if (f.mcus.length > 0 && !f.mcus.includes(mcuFamilyLabel(b.mcu.family))) return false;
  if (f.vehicles.length > 0) {
    for (const v of f.vehicles) {
      if (!b.vehicles.includes(v)) return false;
    }
  }
  if (b.io.uart_count < f.uart) return false;
  if (b.io.i2c_count < f.i2c) return false;
  if (b.io.spi_count < f.spi) return false;
  if (b.io.can_count < f.can) return false;
  if (b.io.pwm.total < f.pwm) return false;
  if (b.io.usb_count < f.usb) return false;
  if (b.power.monitor_inputs < f.powerInputs) return false;
  if (f.ethernet && !b.io.ethernet) return false;
  if (f.sdcard && !b.io.sdcard) return false;
  if (f.sbusOut && !b.io.sbus_out) return false;
  if (f.bdshot && !hasBdshot(b)) return false;
  if (f.iomcu && !b.io.iomcu) return false;
  if (imuSlotCount(b) < f.imus) return false;
  if (f.canfd && !b.io.canfd) return false;
  if (f.minFlash && (b.flash_kb ?? 0) < f.minFlash) return false;

  // Experimental AI-based filters — only applied when explicitly enabled.
  // These read the unverified `ai` block; a board missing the field is excluded
  // (we can't confirm it matches).
  if (f.aiEnabled) {
    const ai = b.ai;
    if (f.aiWeightMin != null || f.aiWeightMax != null) {
      const w = ai?.weight_g;
      if (w == null || !inBounds(w, f.aiWeightMin, f.aiWeightMax)) return false;
    }
    if (f.aiSizeMin != null || f.aiSizeMax != null) {
      const dims = [ai?.dimensions_mm?.length, ai?.dimensions_mm?.width].filter((x): x is number => x != null);
      const size = dims.length ? Math.max(...dims) : null;
      if (size == null || !inBounds(size, f.aiSizeMin, f.aiSizeMax)) return false;
    }
    if (f.aiVoltMin != null || f.aiVoltMax != null) {
      // Board's accepted input-voltage span must overlap the selected range.
      const bMax = ai?.voltage_max_v;
      const bMin = ai?.voltage_min_v ?? 0;
      if (bMax == null) return false;
      if (f.aiVoltMin != null && bMax < f.aiVoltMin) return false;
      if (f.aiVoltMax != null && bMin > f.aiVoltMax) return false;
    }
    if (f.aiMount !== "ANY") {
      const m = (ai?.mounting_pattern_mm ?? "").replace(/\s+/g, "").toLowerCase();
      if (!m.includes(f.aiMount.toLowerCase())) return false;
    }
    if (f.aiBecMin > 0 && (ai?.bec_outputs?.length ?? 0) < f.aiBecMin) return false;
    if (f.aiHasOsd && !(ai?.has_osd || ai?.osd_chip)) return false;
    if (f.aiHasWireless && !ai?.wireless) return false;
    if (f.aiHasBlackbox && !ai?.blackbox_flash) return false;
  }
  return true;
}

// ── URL state ───────────────────────────────────────────────────────────────
//
// Filters live in the query string so the browser's Back button restores them.
// Without this, choosing a board and returning threw away everything you had
// set up, which is the point in the session where it is most annoying to lose.
// Making the URL the source of truth also means a filtered view can be
// bookmarked or sent to someone.
//
// Only values differing from DEFAULTS are written, so a plain listing stays at
// a bare "/" instead of a wall of parameters that are all just the defaults.

/** Serialise the non-default parts of a filter set into query parameters. */
export function filtersToParams(f: Filters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, def] of Object.entries(DEFAULTS) as [keyof Filters, unknown][]) {
    const value = f[key] as unknown;
    if (Array.isArray(def)) {
      const arr = value as string[];
      if (arr.length) params.set(key, arr.join(","));
      continue;
    }
    if (value === def) continue;
    if (value === null) continue;      // null is "no bound" / "everything"
    if (typeof value === "boolean") {
      if (value) params.set(key, "1");
      continue;
    }
    if (Array.isArray(value)) {
      // manufacturers is string[] | null; null (the default) means "all ticked".
      if (value.length) params.set(key, value.join(","));
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

/** Rebuild a filter set from query parameters, falling back to DEFAULTS. */
export function filtersFromParams(params: URLSearchParams): Filters {
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const [key, def] of Object.entries(DEFAULTS)) {
    const raw = params.get(key);
    if (raw === null) continue;
    if (Array.isArray(def)) {
      out[key] = raw ? raw.split(",").filter(Boolean) : [];
    } else if (typeof def === "boolean") {
      out[key] = raw === "1" || raw === "true";
    } else if (typeof def === "number") {
      const n = Number(raw);
      if (Number.isFinite(n)) out[key] = n;
    } else if (def === null) {
      // Either a numeric bound (aiWeightMin…) or the manufacturer list.
      if (key === "manufacturers") {
        out[key] = raw ? raw.split(",").filter(Boolean) : null;
      } else {
        const n = Number(raw);
        if (Number.isFinite(n)) out[key] = n;
      }
    } else {
      out[key] = raw;
    }
  }
  return out as unknown as Filters;
}
