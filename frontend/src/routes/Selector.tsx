import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import Slider from "rc-slider";
import "rc-slider/assets/index.css";
import {
  boardManufacturer,
  manufacturerKey,
  mcuFamilyLabel,
  physicalSensorCount,
  useBoards,
  useManufacturers,
  type ManufacturerIndex,
} from "../data";
import type { Board, VehicleType } from "../types";

// Physical maximum number of IMU slots any ArduPilot autopilot ships with.
// Counts above this are capped; the raw value is exposed for the overcount
// flag so the user knows the data needs review.
const MAX_IMU_SLOTS = 3;

// Amber accent for experimental, AI-derived (unverified) data — used in the
// sidebar filter section and the CSV column picker, with a key so it reads as
// "handle with care".
const AI_AMBER = "#b58900";

function imuSlotCountRaw(b: Board): number {
  if (b.manual?.imu_count != null) return b.manual.imu_count;
  const slots = new Set<string>();
  let unslotted = 0;
  for (const s of b.imus) {
    if (s.slot) slots.add(s.slot);
    else unslotted += 1;
  }
  return slots.size + unslotted;
}

// Capped slot count: never exceeds the physical hardware maximum.
function imuSlotCount(b: Board): number {
  return Math.min(imuSlotCountRaw(b), MAX_IMU_SLOTS);
}

interface Filters {
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

const DEFAULTS: Filters = {
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

// Mounting-hole patterns offered as quick chips. Matched as a substring of
// the AI-gathered `mounting_pattern_mm` string (which may list several).
const AI_MOUNT_OPTIONS = ["16x16", "20x20", "25.5x25.5", "30.5x30.5"] as const;

// Battery cell-count shortcuts for the input-voltage filter. A board must
// accept at least the full-charge voltage of that pack (4.2 V per cell).
const AI_CELL_OPTIONS = [2, 3, 4, 6, 8, 12] as const;
const cellsToVolts = (cells: number) => Math.round(cells * 4.2 * 10) / 10;

// true when v lies inside [lo, hi] (either bound may be absent).
function inBounds(v: number, lo: number | null, hi: number | null): boolean {
  return (lo == null || v >= lo) && (hi == null || v <= hi);
}

const VEHICLES: { id: VehicleType; label: string }[] = [
  { id: "copter",  label: "Copter" },
  { id: "plane",   label: "Plane" },
  { id: "rover",   label: "Rover" },
  { id: "sub",     label: "Sub" },
  { id: "tracker", label: "Tracker" },
  { id: "blimp",   label: "Blimp" },
];

type SortKey =
  | "slug" | "mcu" | "flash"
  | "uart" | "i2c" | "spi" | "can" | "pwm" | "usb"
  | "imus" | "power" | "ethernet" | "sdcard" | "sbus" | "iomcu" | "bdshot";

interface TableColumn {
  id: string;
  label: string;
  sortKey: SortKey;
  align?: "right" | "center";
  cell: (b: Board) => ReactNode;
}

// Reorderable data columns. The BOARD slug column is fixed leftmost and the
// open-arrow column is fixed rightmost (both rendered outside this list).
const TABLE_COLUMNS: TableColumn[] = [
  { id: "mcu",      label: "MCU",   sortKey: "mcu",
    cell: (b) => <td className="td-mcu">{b.platform === "linux" ? "Linux" : mcuFamilyLabel(b.mcu.family)}</td> },
  { id: "flash",    label: "FLASH", sortKey: "flash", align: "right",
    cell: (b) => <td className="td-num">{b.flash_kb ? `${b.flash_kb}K` : "—"}</td> },
  { id: "uart",     label: "UART",  sortKey: "uart",  align: "right",
    cell: (b) => <td className="td-num">{b.io.uart_count}</td> },
  { id: "i2c",      label: "I²C",   sortKey: "i2c",   align: "right",
    cell: (b) => <td className="td-num">{b.io.i2c_count}</td> },
  { id: "spi",      label: "SPI",   sortKey: "spi",   align: "right",
    cell: (b) => <td className="td-num">{b.io.spi_count}</td> },
  { id: "can",      label: "CAN",   sortKey: "can",   align: "right",
    cell: (b) => (
      <td className="td-num">
        {b.io.can_count}{b.io.canfd && <span className="canfd-tag">FD</span>}
      </td>
    ) },
  { id: "pwm",      label: "PWM",   sortKey: "pwm",   align: "right",
    cell: (b) => <td className="td-num">{b.io.pwm.total}</td> },
  { id: "usb",      label: "USB",   sortKey: "usb",   align: "right",
    cell: (b) => <td className="td-num">{b.io.usb_count}</td> },
  { id: "imus",     label: "IMU",   sortKey: "imus",  align: "right",
    cell: (b) => {
      return (
        <td className="td-num">
          {imuSlotCount(b)}
        </td>
      );
    } },
  { id: "power",    label: "POWER", sortKey: "power", align: "right",
    cell: (b) => <td className="td-num">{b.power.monitor_inputs}</td> },
  { id: "ethernet", label: "ETH",   sortKey: "ethernet", align: "center",
    cell: (b) => <BoolCell on={b.io.ethernet} /> },
  { id: "sdcard",   label: "SD",    sortKey: "sdcard",   align: "center",
    cell: (b) => <BoolCell on={b.io.sdcard} /> },
  { id: "sbus",     label: "SBUS",  sortKey: "sbus",     align: "center",
    cell: (b) => <BoolCell on={b.io.sbus_out} /> },
  { id: "iomcu",    label: "IOMCU", sortKey: "iomcu",    align: "center",
    cell: (b) => <BoolCell on={b.io.iomcu} /> },
  { id: "bdshot",   label: "BDShot", sortKey: "bdshot",  align: "center",
    cell: (b) => <BdshotCell board={b} /> },
];

// true when the board supports bidirectional DShot directly or via a sibling
// "<slug>-bdshot" firmware target.
const hasBdshot = (b: Board) => b.io.bdshot || b.bdshot_target != null;
const DEFAULT_COL_ORDER = TABLE_COLUMNS.map((c) => c.id);
const COL_ORDER_KEY = "fcpicker.columnOrder.v1";

function loadColumnOrder(): string[] {
  try {
    const raw = sessionStorage.getItem(COL_ORDER_KEY);
    if (!raw) return DEFAULT_COL_ORDER;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_COL_ORDER;
    // Keep only known ids, then append any missing ones (forward-compat
    // when new columns are added between sessions).
    const known = new Set(DEFAULT_COL_ORDER);
    const filtered = parsed.filter((x): x is string => typeof x === "string" && known.has(x));
    for (const id of DEFAULT_COL_ORDER) if (!filtered.includes(id)) filtered.push(id);
    return filtered;
  } catch {
    return DEFAULT_COL_ORDER;
  }
}

interface CsvColumn {
  id: string;
  label: string;
  get: (b: Board) => string | number;
}

const CSV_COLUMNS: CsvColumn[] = [
  { id: "slug",       label: "Board name",         get: (b) => b.slug },
  { id: "manufacturer", label: "Manufacturer",     get: (b) => boardManufacturer(b) ?? "" },
  { id: "platform",   label: "Platform",           get: (b) => b.platform },
  { id: "mcu_family", label: "MCU family",         get: (b) => b.mcu.family ?? "" },
  { id: "mcu_part",   label: "MCU part",           get: (b) => b.mcu.part ?? "" },
  { id: "flash_kb",   label: "Flash (KB)",         get: (b) => b.flash_kb ?? "" },
  { id: "uart",       label: "UART count",         get: (b) => b.io.uart_count },
  { id: "i2c",        label: "I²C count",          get: (b) => b.io.i2c_count },
  { id: "spi",        label: "SPI count",          get: (b) => b.io.spi_count },
  { id: "can",        label: "CAN count",          get: (b) => b.io.can_count },
  { id: "canfd",      label: "CAN-FD support",     get: (b) => (b.io.canfd ? "yes" : "no") },
  { id: "pwm",        label: "PWM total",          get: (b) => b.io.pwm.total },
  { id: "pwm_fmu",    label: "PWM (FMU)",          get: (b) => b.io.pwm.fmu },
  { id: "pwm_io",     label: "PWM (IO)",           get: (b) => b.io.pwm.io },
  { id: "ethernet",   label: "Ethernet",           get: (b) => (b.io.ethernet ? "yes" : "no") },
  { id: "sdcard",     label: "microSD",            get: (b) => (b.io.sdcard ? "yes" : "no") },
  { id: "sbus_out",   label: "SBUS out",           get: (b) => (b.io.sbus_out ? "yes" : "no") },
  { id: "bdshot",     label: "BDShot",             get: (b) => (b.io.bdshot ? "yes" : b.bdshot_target ? `via ${b.bdshot_target.slug}` : "no") },
  { id: "usb",        label: "USB ports",          get: (b) => b.io.usb_count },
  { id: "power",      label: "Power inputs",       get: (b) => b.power.monitor_inputs },
  { id: "imus",       label: "IMU count",          get: (b) => imuSlotCount(b) },
  { id: "baros",      label: "Baro count",         get: (b) => physicalSensorCount(b.baros) },
  { id: "compasses",  label: "Compass count",      get: (b) => physicalSensorCount(b.compasses) },
  { id: "vehicles",   label: "Supported vehicles", get: (b) => b.vehicles.join("|") },
  { id: "docs_url",   label: "ArduPilot docs URL", get: (b) => b.docs_url ?? "" },
  // Experimental — from the unverified AI-gathered `ai` block. Flagged amber
  // with a key in the column picker instead of suffixing every label. The CSV
  // file headers keep the `ai_` id prefix as the signal (no colour in a file).
  { id: "ai_product",     label: "Product name",  get: (b) => b.ai?.marketing_name ?? "" },
  { id: "ai_weight_g",    label: "Weight g",      get: (b) => b.ai?.weight_g ?? "" },
  { id: "ai_dimensions",  label: "Dimensions mm", get: (b) => {
      const d = b.ai?.dimensions_mm;
      return d && (d.length || d.width || d.height)
        ? `${d.length ?? "?"}x${d.width ?? "?"}x${d.height ?? "?"}` : "";
    } },
  { id: "ai_mounting_mm", label: "Mounting mm",   get: (b) => b.ai?.mounting_pattern_mm ?? "" },
  { id: "ai_input",       label: "Input",         get: (b) => b.ai?.voltage_cells ?? (b.ai?.voltage_max_v ? `<=${b.ai.voltage_max_v}V` : "") },
  { id: "ai_osd",         label: "OSD",           get: (b) => b.ai?.osd_chip ?? (b.ai?.has_osd ? "yes" : "") },
  { id: "ai_wireless",    label: "Wireless",      get: (b) => b.ai?.wireless ?? "" },
  { id: "ai_blackbox",    label: "Blackbox",      get: (b) => b.ai?.blackbox_flash ?? "" },
  { id: "ai_connectors",  label: "Connectors",    get: (b) => (b.ai?.notable_connectors ?? []).join("|") },
];

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(boards: Board[], columnIds: string[]) {
  const cols = CSV_COLUMNS.filter((c) => columnIds.includes(c.id));
  if (cols.length === 0) return;
  const header = cols.map((c) => c.id).join(",");
  const rows = boards.map((b) => cols.map((c) => csvCell(c.get(b))).join(","));
  const csv = [header, ...rows].join("\n") + "\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fcpicker-boards-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Fold a string to its searchable form: lowercase, with every separator
// removed. Slugs are written solid ("MatekH743") while people type the product
// name with spaces and hyphens ("Matek H743", "H743-SLIM"), so both sides have
// to lose their separators before they can be compared.
function searchFold(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Everything a board can be found by. Variant names matter most: a retail
// product like the H743-SLIM has no hwdef of its own, so this is the only
// place its name appears.
function searchHaystack(b: Board): string {
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
function matchesQuery(b: Board, query: string): boolean {
  const tokens = query.trim().split(/\s+/).map(searchFold).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = searchHaystack(b);
  return tokens.every((t) => hay.includes(t));
}

function passes(b: Board, f: Filters, mfrIndex?: ManufacturerIndex): boolean {
  if (!f.includeDiscontinued && b.manual?.discontinued) return false;
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

export default function Selector() {
  const { boards, loading, error } = useBoards();
  const mfrIndex = useManufacturers();
  const [f, setF] = useState<Filters>(DEFAULTS);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "slug", dir: 1 });
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvScope, setCsvScope] = useState<"filtered" | "all">("filtered");
  const [csvCols, setCsvCols] = useState<Set<string>>(
    () => new Set(CSV_COLUMNS.map((c) => c.id)),
  );

  const [columnOrder, setColumnOrder] = useState<string[]>(loadColumnOrder);
  const [dragColId, setDragColId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: "left" | "right" } | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(COL_ORDER_KEY, JSON.stringify(columnOrder));
    } catch { /* ignore quota */ }
  }, [columnOrder]);

  const orderedColumns = useMemo(() => {
    const byId = new Map(TABLE_COLUMNS.map((c) => [c.id, c]));
    return columnOrder.map((id) => byId.get(id)).filter((c): c is TableColumn => !!c);
  }, [columnOrder]);

  const moveColumn = (fromId: string, toId: string, side: "left" | "right") => {
    if (fromId === toId) return;
    setColumnOrder((prev) => {
      const next = prev.filter((x) => x !== fromId);
      const idx = next.indexOf(toId);
      if (idx === -1) return prev;
      next.splice(side === "left" ? idx : idx + 1, 0, fromId);
      return next;
    });
  };

  // One entry per company: key → display label (the most common spelling in
  // the catalog, shortest on ties) and board count.
  const manufacturerOptions = useMemo(() => {
    if (!boards) return [];
    const groups = new Map<string, { spellings: Map<string, number>; count: number }>();
    for (const b of boards) {
      const raw = (boardManufacturer(b) ?? "").trim() || "Unknown";
      const key = manufacturerKey(boardManufacturer(b), mfrIndex);
      const g = groups.get(key) ?? { spellings: new Map(), count: 0 };
      g.spellings.set(raw, (g.spellings.get(raw) ?? 0) + 1);
      g.count += 1;
      groups.set(key, g);
    }
    return Array.from(groups, ([key, g]) => {
      const label = Array.from(g.spellings)
        .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
      return { key, label, count: g.count };
    }).sort((a, b) =>
      // "Unknown" (empty key) always last.
      (a.key === "") === (b.key === "")
        ? a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
        : a.key === "" ? 1 : -1);
  }, [boards, mfrIndex]);

  const mcuOptions = useMemo(() => {
    if (!boards) return [];
    const set = new Set<string>();
    // Only real MCUs become chips — Linux boards (null family) are filtered via
    // the Platform control, not surfaced here as a bare "Unknown".
    for (const b of boards) if (b.mcu.family) set.add(mcuFamilyLabel(b.mcu.family));
    return Array.from(set).sort();
  }, [boards]);

  const filtered = useMemo(() => {
    if (!boards) return [];
    const out = boards.filter((b) => passes(b, f, mfrIndex));
    const dir = sort.dir;
    out.sort((a, b) => {
      switch (sort.key) {
        case "slug":  return a.slug.localeCompare(b.slug) * dir;
        case "mcu":   return mcuFamilyLabel(a.mcu.family).localeCompare(mcuFamilyLabel(b.mcu.family)) * dir;
        case "flash": return ((a.flash_kb ?? 0) - (b.flash_kb ?? 0)) * dir;
        case "uart":  return (a.io.uart_count - b.io.uart_count) * dir;
        case "i2c":   return (a.io.i2c_count - b.io.i2c_count) * dir;
        case "spi":   return (a.io.spi_count - b.io.spi_count) * dir;
        case "can":   return (a.io.can_count - b.io.can_count) * dir;
        case "pwm":   return (a.io.pwm.total - b.io.pwm.total) * dir;
        case "usb":   return (a.io.usb_count - b.io.usb_count) * dir;
        case "imus":  return (imuSlotCount(a) - imuSlotCount(b)) * dir;
        case "power": return (a.power.monitor_inputs - b.power.monitor_inputs) * dir;
        case "ethernet": return ((a.io.ethernet ? 1 : 0) - (b.io.ethernet ? 1 : 0)) * dir;
        case "sdcard":   return ((a.io.sdcard   ? 1 : 0) - (b.io.sdcard   ? 1 : 0)) * dir;
        case "sbus":     return ((a.io.sbus_out ? 1 : 0) - (b.io.sbus_out ? 1 : 0)) * dir;
        case "iomcu":    return ((a.io.iomcu    ? 1 : 0) - (b.io.iomcu    ? 1 : 0)) * dir;
        case "bdshot":   return ((hasBdshot(a) ? 1 : 0) - (hasBdshot(b) ? 1 : 0)) * dir;
      }
    });
    return out;
  }, [boards, f, sort, mfrIndex]);

  const siblingIds = useMemo(() => filtered.map((b) => b.slug), [filtered]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }));

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((p) => ({ ...p, [k]: v }));

  return (
    <>
      <aside className="sidebar">
        <details className="sidebar-block exp-disclosure">
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>⚠ Experimental</summary>
          <p className="filter-note" style={{ marginTop: "0.4rem" }}>
            Catalog is in testing — board data is parsed from ArduPilot hwdef files
            and may be incomplete or wrong. Verify against the docs.
          </p>
        </details>

        <div className="sidebar-block">
          <h3 className="block-title">Search</h3>
          <input
            type="text"
            className="input-text"
            placeholder="Cube, Pixhawk, Matek…"
            value={f.query}
            onChange={(e) => set("query", e.target.value)}
          />
        </div>

        <div className="sidebar-block">
          <h3 className="block-title">Manufacturer</h3>
          <ManufacturerPicker
            options={manufacturerOptions}
            value={f.manufacturers}
            onChange={(v) => set("manufacturers", v)}
          />
        </div>

        <div className="sidebar-block">
          <h3 className="block-title">Vehicle type</h3>
          <div className="chip-row">
            {VEHICLES.map((v) => {
              const on = f.vehicles.includes(v.id);
              return (
                <button
                  key={v.id}
                  className={"chip " + (on ? "chip-on" : "")}
                  onClick={() =>
                    set(
                      "vehicles",
                      on ? f.vehicles.filter((x) => x !== v.id) : [...f.vehicles, v.id],
                    )
                  }
                >
                  {v.label}
                </button>
              );
            })}
          </div>
          {f.vehicles.length > 0 && (
            <p className="filter-note">
              Showing boards that build for {f.vehicles.length === 1 ? "this vehicle" : "all selected vehicles"}.
            </p>
          )}
        </div>

        <div className="sidebar-block">
          <h3 className="block-title">Platform</h3>
          <div className="chip-row">
            {([["ANY", "Any"], ["chibios", "Flight controller"], ["linux", "Linux"]] as const).map(
              ([val, label]) => (
                <button
                  key={val}
                  className={"chip " + (f.platform === val ? "chip-on" : "")}
                  onClick={() => set("platform", val)}
                >
                  {label}
                </button>
              ),
            )}
          </div>
        </div>

        <div className="sidebar-block">
          <h3 className="block-title">MCU family</h3>
          <div className="chip-row">
            <button
              className={"chip " + (f.mcus.length === 0 ? "chip-on" : "")}
              onClick={() => set("mcus", [])}
            >
              Any
            </button>
            {mcuOptions.map((m) => {
              const on = f.mcus.includes(m);
              return (
                <button
                  key={m}
                  className={"chip " + (on ? "chip-on" : "")}
                  aria-pressed={on}
                  onClick={() =>
                    set("mcus", on ? f.mcus.filter((x) => x !== m) : [...f.mcus, m])
                  }
                >
                  {m.replace("STM32 ", "")}
                </button>
              );
            })}
          </div>
          {f.mcus.length > 1 && (
            <p className="filter-note">Showing boards on any of these families.</p>
          )}
        </div>

        <div className="sidebar-block">
          <h3 className="block-title">Minimum peripherals</h3>
          <Stepper label="UART"   value={f.uart} max={10} onChange={(v) => set("uart", v)} />
          <Stepper label="I²C"    value={f.i2c}  max={6}  onChange={(v) => set("i2c", v)} />
          <Stepper label="SPI"    value={f.spi}  max={8}  onChange={(v) => set("spi", v)} />
          <Stepper label="CAN"    value={f.can}  max={4}  onChange={(v) => set("can", v)} />
          <Stepper label="PWM"    value={f.pwm}  max={16} onChange={(v) => set("pwm", v)} />
          <Stepper label="USB"    value={f.usb}  max={2}  onChange={(v) => set("usb", v)} />
          <Stepper label="Power"  value={f.powerInputs} max={4} onChange={(v) => set("powerInputs", v)} />
          <Stepper label="IMU"    value={f.imus} max={5}  min={1} onChange={(v) => set("imus", v)} />
        </div>

        <div className="sidebar-block">
          <h3 className="block-title">Features</h3>
          <label className="toggle">
            <input type="checkbox" checked={f.canfd} onChange={(e) => set("canfd", e.target.checked)} />
            <span className="toggle-mark" aria-hidden />
            <span className="toggle-label">CAN-FD capable</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={f.ethernet} onChange={(e) => set("ethernet", e.target.checked)} />
            <span className="toggle-mark" aria-hidden />
            <span className="toggle-label">Ethernet</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={f.sdcard} onChange={(e) => set("sdcard", e.target.checked)} />
            <span className="toggle-mark" aria-hidden />
            <span className="toggle-label">microSD slot</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={f.sbusOut} onChange={(e) => set("sbusOut", e.target.checked)} />
            <span className="toggle-mark" aria-hidden />
            <span className="toggle-label">SBUS out</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={f.iomcu} onChange={(e) => set("iomcu", e.target.checked)} />
            <span className="toggle-mark" aria-hidden />
            <span className="toggle-label">IOMCU (16 PWM)</span>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={f.bdshot} onChange={(e) => set("bdshot", e.target.checked)} />
            <span className="toggle-mark" aria-hidden />
            <span className="toggle-label">Bidirectional DShot</span>
          </label>
        </div>

        <div className="ai-card">
          <label className="toggle ai-card-head">
            <input
              type="checkbox"
              checked={f.aiEnabled}
              onChange={(e) => set("aiEnabled", e.target.checked)}
            />
            <span className="toggle-mark" aria-hidden />
            <span className="toggle-label" style={{ fontWeight: 600 }}>AI-based filters</span>
            <span className="ai-pill">experimental</span>
          </label>
          {f.aiEnabled ? (
            <div className="ai-card-body">
              <p className="filter-note" style={{ marginTop: 0 }}>
                Unverified AI-gathered specs — boards missing a spec are excluded. Confirm in the docs.
              </p>

              <NumRange
                label="Weight" unit="g" max={200} step={1}
                lo={f.aiWeightMin} hi={f.aiWeightMax}
                onChange={(lo, hi) => setF((p) => ({ ...p, aiWeightMin: lo, aiWeightMax: hi }))}
              />
              <NumRange
                label="Size (longest side)" unit="mm" max={120} step={1}
                lo={f.aiSizeMin} hi={f.aiSizeMax}
                onChange={(lo, hi) => setF((p) => ({ ...p, aiSizeMin: lo, aiSizeMax: hi }))}
              />
              <NumRange
                label="Input voltage" unit="V" max={60} step={0.1}
                lo={f.aiVoltMin} hi={f.aiVoltMax}
                onChange={(lo, hi) => setF((p) => ({ ...p, aiVoltMin: lo, aiVoltMax: hi }))}
              />
              <div className="chip-row ai-cells">
                <span className="ai-cells-label">Pack</span>
                {AI_CELL_OPTIONS.map((c) => {
                  const v = cellsToVolts(c);
                  const on = f.aiVoltMin === v;
                  return (
                    <button
                      key={c}
                      className={"chip " + (on ? "chip-on" : "")}
                      title={`Accepts at least ${v} V (${c}S full charge)`}
                      onClick={() => set("aiVoltMin", on ? null : v)}
                    >
                      {c}S
                    </button>
                  );
                })}
              </div>

              <div className="stepper-label">Mounting pattern</div>
              <div className="chip-row">
                {(["ANY", ...AI_MOUNT_OPTIONS] as const).map((m) => (
                  <button
                    key={m}
                    className={"chip " + (f.aiMount === m ? "chip-on" : "")}
                    onClick={() => set("aiMount", m)}
                  >
                    {m === "ANY" ? "Any" : `${m} mm`}
                  </button>
                ))}
              </div>

              <Stepper label="BEC outputs" value={f.aiBecMin} max={6} onChange={(v) => set("aiBecMin", v)} />

              <label className="toggle">
                <input type="checkbox" checked={f.aiHasOsd} onChange={(e) => set("aiHasOsd", e.target.checked)} />
                <span className="toggle-mark" aria-hidden />
                <span className="toggle-label">Has OSD</span>
              </label>
              <label className="toggle">
                <input type="checkbox" checked={f.aiHasWireless} onChange={(e) => set("aiHasWireless", e.target.checked)} />
                <span className="toggle-mark" aria-hidden />
                <span className="toggle-label">Has wireless (ELRS / Wi-Fi / BT)</span>
              </label>
              <label className="toggle">
                <input type="checkbox" checked={f.aiHasBlackbox} onChange={(e) => set("aiHasBlackbox", e.target.checked)} />
                <span className="toggle-mark" aria-hidden />
                <span className="toggle-label">Has blackbox flash</span>
              </label>
            </div>
          ) : (
            <p className="ai-card-hint">
              Filter by AI-guessed specs — weight, size, voltage &amp; features.
            </p>
          )}
        </div>

        <div className="sidebar-block">
          <h3 className="block-title">Minimum flash</h3>
          <input
            type="range"
            min={0}
            max={2048}
            step={128}
            value={f.minFlash}
            onChange={(e) => set("minFlash", Number(e.target.value))}
            className="range"
          />
          <div className="range-readout">
            <span>{f.minFlash} KB</span>
            <span className="range-max">up to 2048</span>
          </div>
        </div>

        <div className="sidebar-block">
          <h3 className="block-title">Availability</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={f.includeDiscontinued}
              onChange={(e) => set("includeDiscontinued", e.target.checked)}
            />
            <span className="toggle-mark" aria-hidden />
            <span className="toggle-label">Include discontinued boards</span>
          </label>
        </div>

        <button className="reset" onClick={() => setF(DEFAULTS)}>
          Reset filters
        </button>
      </aside>

      <section className="results">
        <div className="results-head">
          <div>
            <h1 className="results-title">Flight controllers</h1>
            <p className="results-sub">
              <strong>{filtered.length}</strong> of {boards?.length ?? 0} ArduPilot-supported boards
              match your filters.
            </p>
          </div>
          <div className="results-actions">
            <button
              type="button"
              className="btn-csv"
              onClick={() => setCsvOpen(true)}
              disabled={(boards?.length ?? 0) === 0}
              title="Configure and download a CSV file"
            >
              ⤓ Download CSV…
            </button>
            <div className="results-legend">
              <span><i className="dot dot-green" /> ArduPilot official</span>
              <span><i className="dot dot-blue" /> CAN-FD</span>
            </div>
          </div>
        </div>

        {loading && <div className="state">Loading catalog…</div>}
        {error && <div className="state state-err">Couldn't load boards.json: {error}</div>}

        {boards && (
          <div className="table-wrap">
            <table className="ttable">
              <thead>
                <tr>
                  <Th label="BOARD" k="slug" sort={sort} onClick={toggleSort} />
                  {orderedColumns.map((c) => (
                    <Th
                      key={c.id}
                      label={c.label}
                      k={c.sortKey}
                      sort={sort}
                      onClick={toggleSort}
                      align={c.align}
                      draggableId={c.id}
                      dragColId={dragColId}
                      dropTarget={dropTarget}
                      onDragStartCol={(id) => setDragColId(id)}
                      onDragOverCol={(id, side) => setDropTarget({ id, side })}
                      onDragLeaveCol={(id) =>
                        setDropTarget((cur) => (cur && cur.id === id ? null : cur))
                      }
                      onDropCol={(toId, side) => {
                        if (dragColId) moveColumn(dragColId, toId, side);
                        setDragColId(null);
                        setDropTarget(null);
                      }}
                      onDragEndCol={() => {
                        setDragColId(null);
                        setDropTarget(null);
                      }}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((b) => (
                  <tr key={b.slug} className={"trow" + (b.manual?.discontinued ? " trow-disc" : "")}>
                    <td className="td-name">
                      <Link
                        to={`/board/${b.slug}`}
                        state={{ siblings: siblingIds }}
                        className="row-link"
                      >
                        <span className="row-bracket">[</span>
                        {b.slug}
                        <span className="row-bracket">]</span>
                      </Link>
                      {b.manual?.discontinued && <span className="row-disc-tag" title="Discontinued">DISC</span>}
                      {boardManufacturer(b) && (
                        <span
                          className="row-maker"
                          title="Manufacturer — suggested for discovery; verify exact specs in the linked docs"
                        >
                          {boardManufacturer(b)}
                        </span>
                      )}
                    </td>
                    {orderedColumns.map((c) => (
                      <Cell key={c.id} col={c} board={b} />
                    ))}
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={orderedColumns.length + 1} className="empty">
                      — NO BOARDS MATCH CURRENT PARAMETERS —
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {csvOpen && boards && (
          <CsvDialog
            filteredCount={filtered.length}
            totalCount={boards.length}
            scope={csvScope}
            setScope={setCsvScope}
            selected={csvCols}
            setSelected={setCsvCols}
            onCancel={() => setCsvOpen(false)}
            onDownload={() => {
              const rows = csvScope === "all" ? boards : filtered;
              downloadCsv(rows, Array.from(csvCols));
              setCsvOpen(false);
            }}
          />
        )}
      </section>
    </>
  );
}

function CsvDialog({
  filteredCount, totalCount, scope, setScope, selected, setSelected,
  onCancel, onDownload,
}: {
  filteredCount: number;
  totalCount: number;
  scope: "filtered" | "all";
  setScope: (s: "filtered" | "all") => void;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  onCancel: () => void;
  onDownload: () => void;
}) {
  const toggleCol = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const selectAll = () => setSelected(new Set(CSV_COLUMNS.map((c) => c.id)));
  const selectNone = () => setSelected(new Set());

  const willExport = scope === "filtered" ? filteredCount : totalCount;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>Download CSV</h2>
          <button className="modal-x" onClick={onCancel} aria-label="Close">×</button>
        </header>

        <div className="modal-body">
          <fieldset className="modal-section">
            <legend>What to export</legend>
            <label className="radio">
              <input
                type="radio"
                checked={scope === "filtered"}
                onChange={() => setScope("filtered")}
              />
              <span>
                <strong>Current filtered results</strong>{" "}
                <span className="radio-hint">({filteredCount} board{filteredCount === 1 ? "" : "s"})</span>
              </span>
            </label>
            <label className="radio">
              <input
                type="radio"
                checked={scope === "all"}
                onChange={() => setScope("all")}
              />
              <span>
                <strong>All boards</strong>{" "}
                <span className="radio-hint">({totalCount} boards, ignores filters)</span>
              </span>
            </label>
          </fieldset>

          <fieldset className="modal-section">
            <legend>
              Columns
              <span className="legend-actions">
                <button type="button" className="link-btn" onClick={selectAll}>All</button>
                {" · "}
                <button type="button" className="link-btn" onClick={selectNone}>None</button>
              </span>
            </legend>
            <p className="filter-note">
              <span style={{ color: AI_AMBER, fontWeight: 700 }}>■ Amber</span> = experimental,
              AI-derived &amp; unverified.
            </p>
            <div className="col-grid">
              {CSV_COLUMNS.map((c) => {
                const ai = c.id.startsWith("ai_");
                return (
                  <label key={c.id} className="check">
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggleCol(c.id)}
                    />
                    <span style={ai ? { color: AI_AMBER } : undefined}>{c.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>

        <footer className="modal-foot">
          <span className="modal-summary">
            {selected.size} column{selected.size === 1 ? "" : "s"} ·{" "}
            {willExport} row{willExport === 1 ? "" : "s"}
          </span>
          <div className="modal-buttons">
            <button type="button" className="btn-ghost" onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className="btn-csv"
              onClick={onDownload}
              disabled={selected.size === 0 || willExport === 0}
            >
              Download
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Th({
  label, k, sort, onClick, align,
  draggableId, dragColId, dropTarget,
  onDragStartCol, onDragOverCol, onDragLeaveCol, onDropCol, onDragEndCol,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onClick: (k: SortKey) => void;
  align?: "right" | "center";
  draggableId?: string;
  dragColId?: string | null;
  dropTarget?: { id: string; side: "left" | "right" } | null;
  onDragStartCol?: (id: string) => void;
  onDragOverCol?: (id: string, side: "left" | "right") => void;
  onDragLeaveCol?: (id: string) => void;
  onDropCol?: (id: string, side: "left" | "right") => void;
  onDragEndCol?: () => void;
}) {
  const active = sort.key === k;
  const alignClass = align === "right" ? " th-right" : align === "center" ? " th-center" : "";
  const isDragging = draggableId && dragColId === draggableId;
  const isDropTarget = draggableId && dropTarget?.id === draggableId;
  const dropClass = isDropTarget
    ? dropTarget!.side === "left" ? " th-drop-left" : " th-drop-right"
    : "";
  return (
    <th
      className={`th${alignClass}${active ? " th-active" : ""}${isDragging ? " th-dragging" : ""}${dropClass}`}
      onClick={() => onClick(k)}
      onDragOver={draggableId ? (e) => {
        if (!dragColId) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const side = (e.clientX - rect.left) < rect.width / 2 ? "left" : "right";
        onDragOverCol?.(draggableId, side);
      } : undefined}
      onDragLeave={draggableId ? () => onDragLeaveCol?.(draggableId) : undefined}
      onDrop={draggableId ? (e) => {
        if (!dragColId) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const side = (e.clientX - rect.left) < rect.width / 2 ? "left" : "right";
        onDropCol?.(draggableId, side);
      } : undefined}
    >
      {draggableId && (
        <span
          className="th-handle"
          draggable
          aria-label="Drag to reorder column"
          title="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", draggableId);
            onDragStartCol?.(draggableId);
          }}
          onDragEnd={() => onDragEndCol?.()}
        >
          ⋮⋮
        </span>
      )}
      <span>{label}</span>
      <span className="th-caret">{active ? (sort.dir === 1 ? "▲" : "▼") : "·"}</span>
    </th>
  );
}

function Cell({ col, board }: { col: TableColumn; board: Board }) {
  return col.cell(board);
}

// BDShot cell: ✓ in the default firmware, "opt" when it needs the board's
// -bdshot firmware target (toggle on the board page).
function BdshotCell({ board: b }: { board: Board }) {
  if (b.io.bdshot) return <BoolCell on />;
  if (b.bdshot_target) {
    return (
      <td className="td-bool td-bool-yes">
        <Link to={`/board/${b.slug}`} className="bdshot-var" title={`Optional: ${b.bdshot_target.slug} firmware target`}>opt</Link>
      </td>
    );
  }
  return <BoolCell on={false} />;
}

function BoolCell({ on }: { on: boolean }) {
  return (
    <td className={"td-bool " + (on ? "td-bool-yes" : "td-bool-no")}>
      {on ? "✓" : "—"}
    </td>
  );
}

function Stepper({
  label, value, onChange, min = 0, max,
}: { label: string; value: number; min?: number; max: number; onChange: (v: number) => void }) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const [text, setText] = useState(String(value));
  // Resync the input buffer when value changes externally (e.g. Reset filters)
  // using React's "store previous value" pattern — avoids an effect.
  const [lastSeenValue, setLastSeenValue] = useState(value);
  if (lastSeenValue !== value) {
    setLastSeenValue(value);
    setText(String(value));
  }

  const commit = (raw: string) => {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) {
      const c = clamp(n);
      onChange(c);
      setText(String(c));
    } else {
      setText(String(value));
    }
  };

  return (
    <div className="stepper">
      <span className="stepper-label">{label}</span>
      <div className="stepper-ctrl">
        <button
          className="stepper-btn"
          onClick={() => onChange(Math.max(min, value - 1))}
          aria-label={`${label} decrease`}
        >−</button>
        <span className="stepper-value">
          <span className="stepper-prefix">≥</span>
          <input
            type="number"
            inputMode="numeric"
            className="stepper-input"
            min={min}
            max={max}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit((e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label={`${label} minimum`}
          />
        </span>
        <button
          className="stepper-btn"
          onClick={() => onChange(Math.min(max, value + 1))}
          aria-label={`${label} increase`}
        >+</button>
      </div>
    </div>
  );
}

// Tick-list dropdown of manufacturers. Everything is ticked by default (value
// null); "None" clears the list so the user can tick just the ones they want.
function ManufacturerPicker({
  options, value, onChange,
}: {
  options: { key: string; label: string; count: number }[];
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const allKeys = options.map((o) => o.key);
  const ticked = value ?? allKeys;
  const tickedSet = new Set(ticked);
  const allTicked = value == null || ticked.length === allKeys.length;

  const toggle = (key: string) => {
    const next = tickedSet.has(key) ? ticked.filter((k) => k !== key) : [...ticked, key];
    onChange(next.length === allKeys.length ? null : next);
  };

  const needle = q.trim().toLowerCase();
  const visible = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;

  const summary = allTicked
    ? `All manufacturers (${allKeys.length})`
    : ticked.length === 0
      ? "None selected"
      : ticked.length === 1
        ? options.find((o) => o.key === ticked[0])?.label ?? "1 selected"
        : `${ticked.length} of ${allKeys.length} selected`;

  return (
    <div className={"ms " + (open ? "ms-open" : "")}>
      <button
        type="button"
        className="ms-summary"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ms-summary-text">{summary}</span>
        <span className="ms-caret" aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="ms-panel">
          <div className="ms-tools">
            <input
              type="search"
              className="input-text ms-search"
              placeholder="Filter list…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Filter manufacturers"
            />
            <button type="button" className="chip" onClick={() => onChange(null)} disabled={allTicked}>All</button>
            <button type="button" className="chip" onClick={() => onChange([])} disabled={ticked.length === 0}>None</button>
          </div>
          <div className="ms-list" role="group" aria-label="Manufacturers">
            {visible.map((o) => (
              <label key={o.key} className="ms-item">
                <input
                  type="checkbox"
                  checked={tickedSet.has(o.key)}
                  onChange={() => toggle(o.key)}
                />
                <span className="ms-item-label">{o.label}</span>
                <span className="ms-item-count">{o.count}</span>
              </label>
            ))}
            {visible.length === 0 && <p className="ms-empty">No match</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// Range slider for an optional numeric bound, with min / max number boxes as
// editable readouts. A handle parked at the slider's end means "no bound"
// (stored as null); the boxes accept values beyond the slider's max.
function NumRange({
  label, unit, lo, hi, onChange, max, step = 1,
}: {
  label: string; unit: string; lo: number | null; hi: number | null;
  max: number; step?: number; onChange: (lo: number | null, hi: number | null) => void;
}) {
  const fmt = (n: number | null) => (n == null ? "" : String(n));
  const [loText, setLoText] = useState(fmt(lo));
  const [hiText, setHiText] = useState(fmt(hi));
  const [lastSeen, setLastSeen] = useState({ lo, hi });
  if (lastSeen.lo !== lo || lastSeen.hi !== hi) {
    setLastSeen({ lo, hi });
    setLoText(fmt(lo));
    setHiText(fmt(hi));
  }

  const parse = (raw: string): number | null => {
    const t = raw.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const commit = () => {
    let nlo = parse(loText);
    let nhi = parse(hiText);
    if (nlo != null && nhi != null && nlo > nhi) [nlo, nhi] = [nhi, nlo];
    setLoText(fmt(nlo));
    setHiText(fmt(nhi));
    if (nlo !== lo || nhi !== hi) onChange(nlo, nhi);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  };

  const sliderValue: [number, number] = [
    Math.min(lo ?? 0, max),
    Math.min(hi ?? max, max),
  ];

  return (
    <div className="num-range">
      <span className="stepper-label">{label}</span>
      <div className="range-slider">
        <Slider
          range={{ draggableTrack: true }}
          allowCross={false}
          min={0}
          max={max}
          step={step}
          value={sliderValue}
          onChange={(v) => {
            const [a, b] = v as [number, number];
            onChange(a <= 0 ? null : a, b >= max ? null : b);
          }}
        />
      </div>
      <div className="num-range-ctrl">
        <input
          type="number" inputMode="decimal" min={0} step={step}
          className="num-range-input" placeholder="min"
          value={loText}
          onChange={(e) => setLoText(e.target.value)}
          onBlur={commit} onKeyDown={onKey}
          aria-label={`${label} minimum (${unit})`}
        />
        <span className="num-range-sep">to</span>
        <input
          type="number" inputMode="decimal" min={0} step={step}
          className="num-range-input" placeholder="max"
          value={hiText}
          onChange={(e) => setHiText(e.target.value)}
          onBlur={commit} onKeyDown={onKey}
          aria-label={`${label} maximum (${unit})`}
        />
        <span className="num-range-unit">{unit}</span>
        {(lo != null || hi != null) && (
          <button className="num-range-clear" onClick={() => onChange(null, null)} aria-label={`Clear ${label}`}>×</button>
        )}
      </div>
    </div>
  );
}
