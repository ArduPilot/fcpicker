/**
 * Shared helpers for the frontend test suite.
 *
 * Tests run against the REAL committed payloads, not hand-written mocks. The
 * bugs this suite exists to catch — a search that finds nothing, a manufacturer
 * that loses its partner tick, a board whose sensor count goes impossible —
 * are all properties of the actual 322-board catalog. A mock would pass while
 * the site was broken.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManufacturerIndex, primeCaches } from "../src/data";
import type {
  Board,
  BoardsPayload,
  Manufacturer,
  ManufacturersPayload,
  Rangefinder,
  RangefindersPayload,
} from "../src/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "..", "public");

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(PUBLIC, file), "utf8")) as T;
}

let boardsCache: Board[] | null = null;
let mfrsCache: Manufacturer[] | null = null;
let rfCache: Rangefinder[] | null = null;

export function allBoards(): Board[] {
  boardsCache ??= readJson<BoardsPayload>("boards.json").boards;
  return boardsCache;
}

export function allManufacturers(): Manufacturer[] {
  mfrsCache ??= readJson<ManufacturersPayload>("manufacturers.json").manufacturers;
  return mfrsCache;
}

export function allRangefinders(): Rangefinder[] {
  rfCache ??= readJson<RangefindersPayload>("rangefinders.json").rangefinders;
  return rfCache;
}

export function manufacturerIndex() {
  return buildManufacturerIndex(allManufacturers());
}

/** Find one board by slug, failing loudly if the fixture has moved. */
export function board(slug: string): Board {
  const b = allBoards().find((x) => x.slug === slug);
  if (!b) throw new Error(`no board "${slug}" in boards.json — fixture drifted`);
  return b;
}

/**
 * Seed the data-module caches so components render with real data on their
 * first pass, exactly as the pre-renderer does. Call in beforeEach for any
 * component test that mounts a route.
 */
export function primeAll(): void {
  primeCaches({
    boards: allBoards(),
    manufacturers: allManufacturers(),
    rangefinders: allRangefinders(),
  });
}
