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

// Every whitespace-separated token must appear, so "matek h743" narrows rather
// than widening — each token is matched against the folded haystack, which is
// why a query with separators still finds a solid slug.
export function matchesQuery(b: Board, query: string): boolean {
  const tokens = query.trim().split(/\s+/).map(searchFold).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = searchHaystack(b);
  return tokens.every((t) => hay.includes(t));
}

export function passes(b: Board, f: Filters, mfrIndex?: ManufacturerIndex): boolean {
  if (!f.includeDiscontinued && b.manual?.discontinued) return false;
  if (f.partnersOnly && !(mfrIndex && isPartnerBoard(b, mfrIndex))) return false;
  if (f.query && !matchesQuery(b, f.query)) return false;
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
