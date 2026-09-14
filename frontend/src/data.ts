import { useEffect, useMemo, useState } from "react";
import type {
  Board,
  BoardsPayload,
  Manufacturer,
  ManufacturersPayload,
  Rangefinder,
  RangefindersPayload,
  SensorEntry,
} from "./types";

// Physical-position key for a sensor: its SPI chip-select slot, or — for I2C
// sensors, which have no slot — the I2C bus channel. hwdef probes several
// candidate parts per physical position (e.g. "BMP280 or SPL06", "ICP20100 or
// DPS310"); those alternates sit on the same channel, so keying on the channel
// collapses them to the one physical sensor that's actually populated.
export function sensorSlotKey(s: SensorEntry): string {
  if (s.slot) return s.slot;
  const p = (s.bus ?? "").split(":");
  return p[0] === "I2C" && p.length >= 3 ? `I2C:${p[1]}` : s.bus ?? "?";
}

// True for sensors soldered to the board. hwdef "COMPASS ... I2C:ALL_EXTERNAL:.."
// entries are probes for a plug-in compass (e.g. on a GPS module), not a chip on
// the PCB — the user knows when they've attached one, so they don't count here.
export function isOnboardSensor(s: SensorEntry): boolean {
  return !/EXTERNAL/i.test(s.bus ?? "");
}

// Count of distinct physical onboard sensor positions (not raw probe lines,
// and excluding external plug-in probes).
export function physicalSensorCount(items: SensorEntry[]): number {
  return new Set(items.filter(isOnboardSensor).map(sensorSlotKey)).size;
}

let cache: Board[] | null = null;
let inflight: Promise<Board[]> | null = null;

function load(): Promise<Board[]> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetch("/boards.json")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<BoardsPayload>;
    })
    .then((p) => {
      cache = p.boards;
      return cache;
    });
  return inflight;
}

export function useBoards() {
  const [boards, setBoards] = useState<Board[] | null>(cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache) return;
    load().then(setBoards).catch((e) => setError(String(e)));
  }, []);

  return { boards, error, loading: !boards && !error };
}

type HwdefImagesPayload = {
  base_url: string;
  boards: { slug: string; is_autopilot: boolean; images: string[] }[];
};

export type BoardImages = { baseUrl: string; images: string[] };

let imagesCache: HwdefImagesPayload | null = null;
let imagesInflight: Promise<HwdefImagesPayload> | null = null;

function loadImages(): Promise<HwdefImagesPayload> {
  if (imagesCache) return Promise.resolve(imagesCache);
  if (imagesInflight) return imagesInflight;
  imagesInflight = fetch("/hwdef-images.json")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<HwdefImagesPayload>;
    })
    .then((p) => {
      imagesCache = p;
      return p;
    });
  return imagesInflight;
}

export function useBoardImages(slug: string): BoardImages | null {
  const [state, setState] = useState<BoardImages | null>(() => lookupImages(slug, imagesCache));

  useEffect(() => {
    let cancelled = false;
    loadImages()
      .then((p) => {
        if (!cancelled) setState(lookupImages(slug, p));
      })
      .catch(() => {
        if (!cancelled) setState({ baseUrl: "", images: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return state;
}

function lookupImages(slug: string, p: HwdefImagesPayload | null): BoardImages | null {
  if (!p) return null;
  const entry = p.boards.find((b) => b.slug === slug);
  return { baseUrl: p.base_url, images: entry?.images ?? [] };
}

let rfCache: Rangefinder[] | null = null;
let rfInflight: Promise<Rangefinder[]> | null = null;

function loadRangefinders(): Promise<Rangefinder[]> {
  if (rfCache) return Promise.resolve(rfCache);
  if (rfInflight) return rfInflight;
  rfInflight = fetch("/rangefinders.json")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<RangefindersPayload>;
    })
    .then((p) => {
      rfCache = p.rangefinders;
      return rfCache;
    });
  return rfInflight;
}

export function useRangefinders() {
  const [items, setItems] = useState<Rangefinder[] | null>(rfCache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (rfCache) return;
    loadRangefinders().then(setItems).catch((e) => setError(String(e)));
  }, []);

  return { rangefinders: items, error, loading: !items && !error };
}

export function mcuFamilyLabel(family: string | null): string {
  if (!family) return "Unknown";
  if (family.startsWith("STM32H7")) return "STM32 H7";
  if (family.startsWith("STM32F7")) return "STM32 F7";
  if (family.startsWith("STM32F4")) return "STM32 F4";
  if (family.startsWith("STM32G4")) return "STM32 G4";
  if (family.startsWith("STM32L4")) return "STM32 L4";
  return family;
}

// Manufacturer names in hwdef files are free text, so the same company
// appears under several spellings ("Matek", "Matek Systems", "Mateksys").
// data/manufacturers.json is the registry that folds them onto one id and
// carries the purchase links; this is its client side.
let mfrCache: Manufacturer[] | null = null;
let mfrInflight: Promise<Manufacturer[]> | null = null;

export function loadManufacturers(): Promise<Manufacturer[]> {
  if (mfrCache) return Promise.resolve(mfrCache);
  if (mfrInflight) return mfrInflight;
  mfrInflight = fetch("/manufacturers.json")
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<ManufacturersPayload>;
    })
    .then((p) => {
      mfrCache = p.manufacturers;
      return mfrCache;
    })
    .catch(() => {
      // A missing registry costs purchase links, not the catalog. Degrade to
      // plain normalisation rather than failing the page.
      mfrCache = [];
      return mfrCache;
    });
  return mfrInflight;
}

export interface ManufacturerIndex {
  byId: Map<string, Manufacturer>;
  // Normalised alias key -> canonical id.
  aliasToId: Map<string, string>;
}

export function buildManufacturerIndex(list: Manufacturer[]): ManufacturerIndex {
  const byId = new Map<string, Manufacturer>();
  const aliasToId = new Map<string, string>();
  for (const m of list) {
    byId.set(m.id, m);
    for (const a of m.aliases) aliasToId.set(a, m.id);
  }
  return { byId, aliasToId };
}

const EMPTY_INDEX: ManufacturerIndex = { byId: new Map(), aliasToId: new Map() };

export function useManufacturers(): ManufacturerIndex {
  const [list, setList] = useState<Manufacturer[] | null>(mfrCache);
  useEffect(() => {
    if (mfrCache) return;
    let cancelled = false;
    loadManufacturers().then((m) => {
      if (!cancelled) setList(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => (list ? buildManufacturerIndex(list) : EMPTY_INDEX), [list]);
}

// The vendor name to use for a board: the curated manual value wins, since
// the top-level key is build-derived and hwdef rarely carries a vendor.
export function boardManufacturer(b: Board): string | null {
  return b.manual?.manufacturer ?? b.manufacturer ?? null;
}

// Normalise a free-text manufacturer string to a grouping key. Pass the
// registry index to fold aliases onto the canonical id; without it this is
// plain normalisation, which still groups identical spellings.
//
// Must stay in sync with manufacturer_key() in tools/bundle.py.
export function manufacturerKey(
  raw: string | null | undefined,
  index?: ManufacturerIndex,
): string {
  const k = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return index?.aliasToId.get(k) ?? k;
}

// The registry entry for a board's manufacturer, or null when unmapped.
export function manufacturerFor(
  raw: string | null | undefined,
  index: ManufacturerIndex,
): Manufacturer | null {
  return index.byId.get(manufacturerKey(raw, index)) ?? null;
}

// Whether the board's maker is an ArduPilot Corporate Partner. Three states,
// not two: "unknown" is for boards whose manufacturer we could not identify at
// all, where marking them a non-partner would assert something we don't know.
export type PartnerStatus = "partner" | "non-partner" | "unknown";

export function partnerStatus(b: Board, index: ManufacturerIndex): PartnerStatus {
  const m = manufacturerFor(boardManufacturer(b), index);
  if (!m) return "unknown";
  return m.ardupilot_partner ? "partner" : "non-partner";
}

// Worth surfacing: a partner funds the project and is likelier to keep the
// board's hwdef and docs current.
export function isPartnerBoard(b: Board, index: ManufacturerIndex): boolean {
  return partnerStatus(b, index) === "partner";
}

// Best single "where to buy" link: direct store first, then the reseller list
// for vendors who only sell through distributors, then the home page.
export function purchaseUrl(m: Manufacturer | null): string | null {
  if (!m) return null;
  return m.store_url ?? m.distributors_url ?? m.website ?? null;
}
