/**
 * Type-level invariants over the real board catalog.
 *
 * types.ts is the contract between tools/build.py and the React app (see
 * CLAUDE.md): "keep these in sync". These tests check assumptions the
 * TypeScript types make that the Python suite (tests/test_board_data.py,
 * tests/test_invariants.py) doesn't — variant/slug collisions, the shape of
 * a folded bdshot target, and the counted-vs-listed IO fields that the
 * selector's spec table renders side by side.
 */
import { describe, expect, it } from "vitest";
import { allBoards } from "../helpers";

describe("manual.variants", () => {
  it("has no duplicate variant name within a board, and no variant named after the board itself", () => {
    const dupWithinBoard: string[] = [];
    const redundant: string[] = [];
    for (const b of allBoards()) {
      const names = (b.manual?.variants ?? []).map((v) => v.name);
      if (new Set(names).size !== names.length) dupWithinBoard.push(b.slug);
      if (names.includes(b.slug)) redundant.push(b.slug);
    }
    expect(dupWithinBoard).toEqual([]);
    expect(redundant).toEqual([]);
  });
});

describe("manual.documents", () => {
  it("exists and is an array on every board, even though it's empty everywhere today", () => {
    const bad = allBoards()
      .filter((b) => !Array.isArray(b.manual?.documents))
      .map((b) => b.slug);
    expect(bad).toEqual([]);
  });
});

describe("bdshot_target", () => {
  it("has a slug ending in -bdshot and an io block shaped like the parent board's, when present", () => {
    const withTarget = allBoards().filter((b) => b.bdshot_target !== null);
    expect(withTarget.length).toBeGreaterThan(0); // guard against the fixture losing every bdshot board

    const badSlug = withTarget.filter((b) => !b.bdshot_target!.slug.endsWith("-bdshot")).map((b) => b.slug);
    const badShape = withTarget
      .filter((b) => {
        const a = Object.keys(b.bdshot_target!.io).sort();
        const c = Object.keys(b.io).sort();
        return a.length !== c.length || a.some((k, i) => k !== c[i]);
      })
      .map((b) => b.slug);

    expect(badSlug).toEqual([]);
    expect(badShape).toEqual([]);
  });
});

describe("io.pwm", () => {
  it("has fmu + io == total on every board", () => {
    const bad = allBoards()
      .filter((b) => b.io.pwm.fmu + b.io.pwm.io !== b.io.pwm.total)
      .map((b) => `${b.slug}: ${b.io.pwm.fmu}+${b.io.pwm.io}!=${b.io.pwm.total}`);
    expect(bad).toEqual([]);
  });
});

describe("bus count fields vs listed buses", () => {
  it("uart/i2c/spi/can counts match the length of their listed buses on every board", () => {
    // If this ever fails, do NOT weaken it — a mismatch means the parser's
    // count and its own bus list disagree, which is a real parser bug, not
    // a display nuance.
    const bad: string[] = [];
    for (const b of allBoards()) {
      const checks: [string, number, number][] = [
        ["uart", b.io.uart_count, b.io.uart_buses.length],
        ["i2c", b.io.i2c_count, b.io.i2c_buses.length],
        ["spi", b.io.spi_count, b.io.spi_buses.length],
        ["can", b.io.can_count, b.io.can_buses.length],
      ];
      for (const [field, count, listed] of checks) {
        if (count !== listed) bad.push(`${b.slug}: ${field}_count=${count} but ${field}_buses.length=${listed}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("sensor entries", () => {
  it("has a non-empty chip and bus on every imu/baro/compass entry", () => {
    const bad: string[] = [];
    for (const b of allBoards()) {
      for (const [group, entries] of [
        ["imus", b.imus],
        ["baros", b.baros],
        ["compasses", b.compasses],
      ] as const) {
        for (const s of entries) {
          if (!s.chip || !s.bus) bad.push(`${b.slug}.${group}: chip=${s.chip} bus=${s.bus}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("firmware_support", () => {
  // The real catalog currently only ever emits one combination — every
  // board is built by ArduPilot itself and shipped as "official" — but the
  // fields exist for when PX4/INAV/Betaflight support is layered in (see
  // CLAUDE.md), so this is written as a vocabulary check rather than an
  // equality check against today's single value.
  const KNOWN_FIRMWARES = new Set(["ardupilot"]);
  const KNOWN_MATURITIES = new Set(["official"]);

  it("has only known firmware and maturity values", () => {
    const bad = allBoards().flatMap((b) =>
      b.firmware_support
        .filter((fs) => !KNOWN_FIRMWARES.has(fs.firmware) || !KNOWN_MATURITIES.has(fs.maturity))
        .map((fs) => `${b.slug}: ${fs.firmware}/${fs.maturity}`),
    );
    expect(bad).toEqual([]);
  });
});

describe("vehicles", () => {
  // AUTOBUILD_TARGETS can be explicitly "none" in a board's hwdef (see
  // tools/build.py), which legitimately produces an empty vehicles array —
  // these four are Nucleo dev boards / bootloader-style targets, not real
  // flight controllers, confirmed against their hwdef. A NEW board landing
  // here unannounced should be investigated, not silently allowed.
  const KNOWN_NO_VEHICLES = new Set(["Nucleo-G491", "NucleoH755", "rFCU", "revo-mini-sd"]);

  it("is non-empty for every chibios board except the known no-vehicle set", () => {
    const bad = allBoards()
      .filter((b) => b.platform === "chibios" && b.vehicles.length === 0 && !KNOWN_NO_VEHICLES.has(b.slug))
      .map((b) => b.slug);
    expect(bad).toEqual([]);
  });
});
