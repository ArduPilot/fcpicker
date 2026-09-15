"""Tests for the hwdef parser in tools/build.py.

`parse_board()` is regex-based and is the entire input side of the pipeline:
every one of the 322 committed `data/boards/*.json` files traces back to it.
It has no upstream tests, so a regression here (a tightened regex, a
reordered check) silently corrupts the whole catalog on the next
`tools/build.py` run without a single test failing anywhere else.

These tests run entirely against fixtures committed under
`tests/fixtures/hwdef/` (see the README there for what each one is and why
it was chosen) — they never touch `~/ardupilot`, so they work in CI and on a
machine with no ArduPilot checkout at all.
"""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path

from build import is_autopilot, merge_bdshot_targets, parse_board

FIXTURES = Path(__file__).parent / "fixtures" / "hwdef"
GOLDEN = Path(__file__).parent / "fixtures" / "golden"


def test_parses_a_plain_autopilot():
    """MatekF405: a plain, single-file, non-BOARD_MATCH, non-IOMCU autopilot."""
    p = parse_board(FIXTURES / "MatekF405", platform="chibios")

    assert p is not None
    assert p.slug == "MatekF405"
    # From `MCU STM32F4xx STM32F405xx` in the fixture.
    assert p.mcu_family == "STM32F4xx"
    assert p.mcu_part == "STM32F405xx"
    # From `FLASH_SIZE_KB 1024`.
    assert p.flash_kb == 1024


def test_rejects_peripherals():
    """f303-MatekGPS: is_autopilot() rejects it by name (contains "GPS")
    before hwdef.dat is even read, so parse_board() must return None."""
    assert is_autopilot("f303-MatekGPS") is False

    result = parse_board(FIXTURES / "f303-MatekGPS", platform="chibios")

    assert result is None, f"expected None, got {result!r}"


def test_rejects_board_without_imu():
    """CarbonixF405: is_autopilot() says yes (no peripheral-pattern in the
    name), but the hwdef declares no IMU line at all (it's a CAN sensor node
    -- compass + baro only) so parse_board() must still drop it.

    This is a different rejection path from test_rejects_peripherals: that
    one is rejected by *name* before the file is read; this one is rejected
    by *content* after full parsing.
    """
    assert is_autopilot("CarbonixF405") is True

    result = parse_board(FIXTURES / "CarbonixF405", platform="chibios")

    assert result is None, f"expected None, got {result!r}"


def test_serial_order_is_parsed():
    """The parsed UART list matches MatekF405's SERIAL_ORDER line, in order,
    with the OTG (USB) entry excluded from uart_buses."""
    p = parse_board(FIXTURES / "MatekF405", platform="chibios")

    assert p is not None
    # Fixture line: `SERIAL_ORDER OTG1 USART3 UART4 USART1 UART5 USART2`
    assert p.uart_buses == ["USART3", "UART4", "USART1", "UART5", "USART2"]
    assert p.usb_count == 1

    # serial_ports carries every SERIAL_ORDER slot (including OTG1 as USB),
    # in the same order, indexed by SERIALn.
    devices = [sp["device"] for sp in p.serial_ports]
    assert devices == ["OTG1", "USART3", "UART4", "USART1", "UART5", "USART2"]
    assert p.serial_ports[0]["usb"] is True
    assert p.serial_ports[0]["serial"] == 0


def test_spi_devices_detected():
    """MatekH743's SPIDEV lines produce the expected sensor chips, buses and
    chip-select slots."""
    p = parse_board(FIXTURES / "MatekH743", platform="chibios")

    assert p is not None
    assert p.spi_buses == ["SPI1", "SPI2", "SPI3", "SPI4"]

    # (chip, bus, variant, slot, chip_display)
    chip_displays = {imu[4] for imu in p.imus}
    assert chip_displays == {"ICM42688", "ICM42605", "ICM20602", "MPU6000"}

    # SPIDEV icm42688 SPI1 DEVID1 IMU1_CS ... -> slot "SPI1/CS:IMU1_CS"
    by_display = {imu[4]: imu for imu in p.imus}
    assert by_display["ICM42688"][3] == "SPI1/CS:IMU1_CS"
    assert by_display["ICM42605"][3] == "SPI4/CS:IMU2_CS"
    # None of these are BOARD_MATCH-gated.
    assert all(imu[2] is None for imu in p.imus)


def test_board_match_sets_sensor_variant():
    """Pixhawk6X gates its IMUs to hardware revisions with BOARD_MATCH(...);
    every one of those sensors must carry a non-null `variant` equal to the
    matched token, and different revisions must get different tokens."""
    p = parse_board(FIXTURES / "Pixhawk6X", platform="chibios")

    assert p is not None
    variants = {imu[2] for imu in p.imus}
    # Every IMU line in the fixture is BOARD_MATCH-gated -> no None variant.
    assert None not in variants
    assert variants == {
        "FMUV6_BOARD_HOLYBRO_6X",
        "FMUV6_BOARD_CUAV_6X",
        "FMUV6_BOARD_HOLYBRO_6X_REV6",
        "FMUV6_BOARD_HOLYBRO_6X_45686",
    }
    # Spot-check one exact line: `IMU Invensensev3 SPI:icm42688 ... BOARD_MATCH(FMUV6_BOARD_HOLYBRO_6X)`
    holybro_6x = [imu for imu in p.imus if imu[2] == "FMUV6_BOARD_HOLYBRO_6X"]
    assert ("Invensensev3", "SPI:icm42688") in {(imu[0], imu[1]) for imu in holybro_6x}


def test_iomcu_detected():
    """Pixhawk6X declares IOMCU_UART -> iomcu True, plus 8 extra IO-side PWM
    channels. MatekF405 has no IOMCU_UART / HAL_WITH_IO_MCU define -> False."""
    with_iomcu = parse_board(FIXTURES / "Pixhawk6X", platform="chibios")
    without_iomcu = parse_board(FIXTURES / "MatekF405", platform="chibios")

    assert with_iomcu is not None and without_iomcu is not None
    assert with_iomcu.iomcu is True
    assert with_iomcu.pwm_io == 8
    assert without_iomcu.iomcu is False
    assert without_iomcu.pwm_io == 0


def test_bdshot_variant_detected():
    """MatekH743 itself has no bidirectional dshot. Its `-bdshot` sibling
    hwdef (`include ../MatekH743/hwdef.dat` + BIDIR-tagged PWM pins) reports
    it directly, and merge_bdshot_targets() folds that sibling into the base
    board as `bdshot_target` rather than leaving it as a separate board."""
    base = parse_board(FIXTURES / "MatekH743", platform="chibios")
    variant = parse_board(FIXTURES / "MatekH743-bdshot", platform="chibios")

    assert base is not None and variant is not None
    assert base.bdshot is False
    assert variant.bdshot is True

    merged = merge_bdshot_targets([base, variant])

    # The standalone "-bdshot" entry is folded away, not kept as its own board.
    assert [b.slug for b in merged] == ["MatekH743"]
    assert base.bdshot_target is not None
    assert base.bdshot_target["slug"] == "MatekH743-bdshot"
    assert base.bdshot_target["io"]["bdshot"] is True


def test_undef_is_honoured(tmp_path):
    """`undef IMU` must wipe every IMU line defined before it, so only
    definitions after the last `undef IMU` survive.

    No fixture under tests/fixtures/hwdef/ exercises this cleanly: every
    real `undef IMU` hwdef found in the current ArduPilot tree only makes
    sense after including a parent hwdef several levels deep (e.g.
    KakuteH7v2 -> KakuteH7-bdshot -> KakuteH7), which would drag an unrelated
    multi-file include chain into this fixture set just to test one
    directive. So this test builds a minimal synthetic hwdef.dat directly in
    tmp_path instead.
    """
    board_dir = tmp_path / "SyntheticUndef"
    board_dir.mkdir()
    (board_dir / "hwdef.dat").write_text(
        "MCU STM32F4xx STM32F405xx\n"
        "FLASH_SIZE_KB 1024\n"
        "IMU Invensense SPI:mpu6000 ROTATION_NONE\n"
        "undef IMU\n"
        "IMU Invensensev3 SPI:icm42688 ROTATION_NONE\n"
    )

    p = parse_board(board_dir, platform="chibios")

    assert p is not None
    chips = [imu[0] for imu in p.imus]
    assert chips == ["Invensensev3"], (
        "undef IMU should have removed the mpu6000 line defined before it"
    )


def test_golden_snapshot():
    """Full parse_board() output for MatekF405 against a committed golden
    JSON. This locks in *current* parser behaviour wholesale (every field,
    not just the ones other tests spot-check) so an unintended change
    anywhere in parse_board() shows up as a diff here.

    The golden file was generated from the parser's own output and then
    eyeballed field-by-field against the fixture text before being
    committed (see tests/fixtures/golden/MatekF405.json). Regenerating it
    is NOT a substitute for that review: it would just as happily commit a
    regression as a real behaviour change. Treat any update to this file as
    requiring a human to re-read the diff against MatekF405/hwdef.dat.
    """
    p = parse_board(FIXTURES / "MatekF405", platform="chibios")
    assert p is not None

    actual = json.loads(json.dumps(dataclasses.asdict(p), sort_keys=True))
    expected = json.loads((GOLDEN / "MatekF405.json").read_text())

    assert actual == expected


def test_linux_platform_board_parses():
    """Bonus coverage for the Linux-HAL fixture (item e in the task): no
    MCU/FLASH_SIZE_KB line at all, so mcu_family/mcu_part/flash_kb are all
    None, but the board still parses because it has an IMU line."""
    p = parse_board(FIXTURES / "navio2", platform="linux")

    assert p is not None
    assert p.platform == "linux"
    assert p.mcu_family is None
    assert p.mcu_part is None
    assert p.flash_kb is None
    assert [imu[0] for imu in p.imus] == ["Invensense"]
