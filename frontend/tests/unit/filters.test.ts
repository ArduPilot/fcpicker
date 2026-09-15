/**
 * The Selector's filtering core — MCU family labels, sensor slot collapsing,
 * IMU slot counting and the `passes()` predicate that drives the board list.
 * These are the properties that keep the spec table honest: a sensor probed
 * twice must not look like two chips, and a filter bump must not silently
 * exclude boards it shouldn't.
 */
import { describe, expect, it } from "vitest";
import { DEFAULTS, hasBdshot, imuSlotCount, MAX_IMU_SLOTS, passes } from "../../src/selector-filter";
import {
  isOnboardSensor,
  isPartnerBoard,
  mcuFamilyLabel,
  physicalSensorCount,
  sensorSlotKey,
  type ManufacturerIndex,
} from "../../src/data";
import type { Board, Filters } from "../../src/types";
import { allBoards, board, manufacturerIndex } from "../helpers";

describe("mcuFamilyLabel", () => {
  it("maps known STM32 family prefixes to their display label", () => {
    expect(mcuFamilyLabel("STM32H7xx")).toBe("STM32 H7");
    expect(mcuFamilyLabel("STM32F7xx")).toBe("STM32 F7");
    expect(mcuFamilyLabel("STM32F4xx")).toBe("STM32 F4");
    expect(mcuFamilyLabel("STM32G4xx")).toBe("STM32 G4");
    expect(mcuFamilyLabel("STM32L4xx")).toBe("STM32 L4");
  });

  it("passes an unrecognised family through unchanged", () => {
    expect(mcuFamilyLabel("STM32F1xx")).toBe("STM32F1xx");
  });

  it("returns 'Unknown' for a null family (e.g. Linux-platform boards)", () => {
    expect(mcuFamilyLabel(null)).toBe("Unknown");
  });
});

describe("sensorSlotKey / isOnboardSensor", () => {
  it("is not onboard when the bus is an EXTERNAL probe", () => {
    // CORVON743V1's compass is a plug-in probe ("I2C:ALL_EXTERNAL:..."), not
    // a chip soldered to this PCB.
    const b = board("CORVON743V1");
    const ext = b.compasses.find((s) => /EXTERNAL/i.test(s.bus ?? ""));
    expect(ext).toBeDefined();
    expect(isOnboardSensor(ext!)).toBe(false);
  });

  it("keys an I2C sensor with no slot by its bus channel", () => {
    const b = board("AcctonGodwit_GA1");
    const baro = b.baros.find((s) => s.slot == null && (s.bus ?? "").startsWith("I2C:"));
    expect(baro).toBeDefined();
    expect(baro!.bus).toBe("I2C:0:0x64");
    expect(sensorSlotKey(baro!)).toBe("I2C:0");
    expect(isOnboardSensor(baro!)).toBe(true);
  });

  it("keys an SPI sensor by its chip-select slot", () => {
    const b = board("MatekH743");
    const withSlot = b.imus.find((s) => s.slot != null);
    expect(withSlot).toBeDefined();
    expect(sensorSlotKey(withSlot!)).toBe(withSlot!.slot);
  });
});

describe("physicalSensorCount", () => {
  it("collapses probe alternates that share one chip-select slot", () => {
    // Aocoda-RC-H743Dual lists 3 IMU probe lines (MPU6000, BMI270_1, BMI270_2)
    // but MPU6000 and BMI270_1 are alternates probed on the same slot
    // (SPI1/CS:IMU1_CS) — only one part is actually populated there, so the
    // physical count is 2, not 3.
    const b = board("Aocoda-RC-H743Dual");
    expect(b.imus.length).toBe(3);
    expect(physicalSensorCount(b.imus)).toBe(2);
  });

  it("excludes external plug-in probes from the count", () => {
    const b = board("CORVON743V1");
    const rawOnboard = b.compasses.filter(isOnboardSensor).length;
    expect(physicalSensorCount(b.compasses)).toBeLessThanOrEqual(b.compasses.length);
    expect(physicalSensorCount(b.compasses)).toBeLessThanOrEqual(rawOnboard);
  });
});

describe("imuSlotCount", () => {
  it("never exceeds MAX_IMU_SLOTS for any board in the catalog", () => {
    expect(MAX_IMU_SLOTS).toBe(3);
    for (const b of allBoards()) {
      expect(imuSlotCount(b), b.slug).toBeLessThanOrEqual(MAX_IMU_SLOTS);
    }
  });

  it("manual.imu_count overrides the computed slot count when set", () => {
    // crazyflie2 has two unslotted I2C IMU probes, which would compute to 2,
    // but a human has overridden it to the physically correct 1.
    const b = board("crazyflie2");
    expect(b.manual?.imu_count).toBe(1);
    expect(imuSlotCount(b)).toBe(1);
  });
});

describe("hasBdshot", () => {
  it("is true when io.bdshot is set", () => {
    const b = board("3DRControlZeroG");
    expect(b.io.bdshot).toBe(true);
    expect(hasBdshot(b)).toBe(true);
  });

  it("is true when a sibling bdshot_target exists even if io.bdshot is false", () => {
    const b = board("ARKV6X");
    expect(b.io.bdshot).toBe(false);
    expect(b.bdshot_target).not.toBeNull();
    expect(hasBdshot(b)).toBe(true);
  });

  it("is false when neither is present", () => {
    const b = board("ACNS-CM4Pilot");
    expect(b.io.bdshot).toBe(false);
    expect(b.bdshot_target).toBeNull();
    expect(hasBdshot(b)).toBe(false);
  });
});

describe("passes", () => {
  it("lets every board through under DEFAULTS", () => {
    const index = manufacturerIndex();
    const excluded = allBoards().filter((b) => !passes(b, DEFAULTS, index));
    expect(excluded.map((b) => b.slug)).toEqual([]);
  });

  it("raising the UART requirement excludes boards below that count", () => {
    const index = manufacturerIndex();
    const f: Filters = { ...DEFAULTS, uart: 6 };
    const results = allBoards().filter((b) => passes(b, f, index));
    expect(results.every((b) => b.io.uart_count >= 6)).toBe(true);
    // Sanity: the filter is actually narrowing, not a no-op.
    expect(results.length).toBeLessThan(allBoards().length);
    const lowUartBoard = board("aero");
    expect(lowUartBoard.io.uart_count).toBeLessThan(6);
    expect(passes(lowUartBoard, f, index)).toBe(false);
  });

  it("partnersOnly yields exactly the set of ArduPilot Corporate Partner boards", () => {
    const index = manufacturerIndex();
    const f: Filters = { ...DEFAULTS, partnersOnly: true };
    const bySelector = new Set(allBoards().filter((b) => passes(b, f, index)).map((b) => b.slug));
    const byHelper = new Set(allBoards().filter((b) => isPartnerBoard(b, index)).map((b) => b.slug));
    expect(bySelector).toEqual(byHelper);
    expect(bySelector.size).toBeGreaterThan(0);
  });

  it("includeDiscontinued: false excludes boards marked discontinued in manual", () => {
    // No board in the current catalog is actually discontinued, so prove the
    // predicate itself with a synthetic clone rather than skip the behaviour.
    const index: ManufacturerIndex = manufacturerIndex();
    const real = board("MatekH743");
    expect(allBoards().some((b) => b.manual?.discontinued)).toBe(false);
    const discontinued: Board = { ...real, manual: { ...real.manual!, discontinued: true } };
    expect(passes(discontinued, DEFAULTS, index)).toBe(false);
    expect(passes(discontinued, { ...DEFAULTS, includeDiscontinued: true }, index)).toBe(true);
  });
});
