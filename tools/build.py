"""Build script for fcPicker.

Walks the local ArduPilot firmware repo (~/ardupilot), parses each board's
hwdef files for structured specs (MCU, flash, IMUs, baros, compasses),
loads them into a SQLite database, then exports a single boards.json
for the static frontend to consume.

Schema is firmware-agnostic so PX4/INAV/Betaflight can be layered in later.

Usage:
    python tools/build.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import (
    Column, Integer, String, Float, ForeignKey, create_engine, select,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, Session


ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
FRONTEND_PUBLIC = ROOT / "frontend" / "public"
ARDUPILOT_HWDEF = Path.home() / "ardupilot" / "libraries" / "AP_HAL_ChibiOS" / "hwdef"
# ArduPilot also runs on Linux SoC boards (Raspberry Pi HATs, Navigator, etc.),
# defined by a parallel hwdef tree with the same .dat syntax but no MCU line.
ARDUPILOT_LINUX_HWDEF = Path.home() / "ardupilot" / "libraries" / "AP_HAL_Linux" / "hwdef"
# platform -> the AP_HAL_* subdirectory its hwdefs live under (for GitHub links).
HAL_DIR = {"chibios": "AP_HAL_ChibiOS", "linux": "AP_HAL_Linux"}
BEC_OVERRIDES = ROOT / "data" / "bec_overrides.json"
DOCS_OVERRIDES = ROOT / "data" / "docs_overrides.json"
SITE_BASE_URL = "https://fcpicker.pebnum.com"
# Overridable so the build can target a clean upstream-master wiki checkout
# (or CI) without depending on whatever branch the local clone is on.
ARDUPILOT_WIKI_ROOT = Path(os.environ.get("ARDUPILOT_WIKI_ROOT", Path.home() / "ardupilot_wiki"))
ARDUPILOT_WIKI_DOCS = ARDUPILOT_WIKI_ROOT / "common" / "source" / "docs"
DOCS_BASE = "https://ardupilot.org"
# Platform dirs (besides common/) whose docs/ contain board landing pages.
# Common docs render under /copter/docs/ for historical reasons.
WIKI_PLATFORMS = ("copter", "plane", "rover", "sub", "blimp", "antennatracker", "dev")
COMMON_PLATFORM = "copter"
# Last-resort docs link when a board has neither a wiki page nor an index entry:
# the hwdef README on GitHub, if the board ships one.
HWDEF_README_URL = (
    "https://github.com/ArduPilot/ardupilot/blob/master/"
    "libraries/{hal_dir}/hwdef/{slug}/{readme}"
)
# Fallback link for boards with no README: the hwdef directory itself.
HWDEF_DIR_URL = (
    "https://github.com/ArduPilot/ardupilot/tree/master/"
    "libraries/{hal_dir}/hwdef/{slug}"
)

# Directory names that are peripherals / nodes / bootloaders, not autopilots.
PERIPHERAL_PATTERNS = (
    "GPS", "GNSS", "CANNODE", "PMU", "ESC", "Periph", "periph",
    "Airspeed", "Compass-", "RTK", "ADSB", "TBS-",
)


class Base(DeclarativeBase):
    pass


class Board(Base):
    __tablename__ = "boards"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    slug: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String)
    # HAL family this board runs: "chibios" (STM32 flight controllers) or
    # "linux" (SoC/Pi-HAT boards). Drives the platform filter + badge.
    platform: Mapped[str] = mapped_column(String, default="chibios")
    manufacturer: Mapped[str | None] = mapped_column(String, nullable=True)
    mcu_family: Mapped[str | None] = mapped_column(String, nullable=True)
    mcu_part: Mapped[str | None] = mapped_column(String, nullable=True)
    flash_kb: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Bus IDs stored as comma-separated names (e.g. "SPI1,SPI2,SPI6")
    uart_buses_csv: Mapped[str] = mapped_column(String, default="")
    i2c_buses_csv: Mapped[str] = mapped_column(String, default="")
    spi_buses_csv: Mapped[str] = mapped_column(String, default="")
    can_buses_csv: Mapped[str] = mapped_column(String, default="")
    canfd: Mapped[bool] = mapped_column(Integer, default=0)
    pwm_fmu: Mapped[int] = mapped_column(Integer, default=0)
    pwm_io: Mapped[int] = mapped_column(Integer, default=0)
    usb_count: Mapped[int] = mapped_column(Integer, default=0)
    ethernet: Mapped[bool] = mapped_column(Integer, default=0)
    sdcard: Mapped[bool] = mapped_column(Integer, default=0)
    sbus_out: Mapped[bool] = mapped_column(Integer, default=0)
    iomcu: Mapped[bool] = mapped_column(Integer, default=0)
    bdshot: Mapped[bool] = mapped_column(Integer, default=0)
    # JSON: {slug, notes, io} of the merged "<slug>-bdshot" hwdef, if any.
    bdshot_target_json: Mapped[str | None] = mapped_column(String, nullable=True)
    # JSON list: SERIALn → hardware UART → pads (see _serial_ports).
    serial_ports_json: Mapped[str] = mapped_column(String, default="[]")
    adc_inputs: Mapped[int] = mapped_column(Integer, default=0)
    power_inputs: Mapped[int] = mapped_column(Integer, default=0)
    vehicles_csv: Mapped[str] = mapped_column(String, default="")
    docs_url: Mapped[str | None] = mapped_column(String, nullable=True)
    repo_url: Mapped[str | None] = mapped_column(String, nullable=True)
    readme: Mapped[str | None] = mapped_column(String, nullable=True)

    sensors: Mapped[list["Sensor"]] = relationship(back_populates="board", cascade="all, delete-orphan")
    firmware_support: Mapped[list["FirmwareSupport"]] = relationship(back_populates="board", cascade="all, delete-orphan")
    bec_rails: Mapped[list["BecRail"]] = relationship(back_populates="board", cascade="all, delete-orphan")


class Sensor(Base):
    __tablename__ = "sensors"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    board_id: Mapped[int] = mapped_column(ForeignKey("boards.id"))
    kind: Mapped[str] = mapped_column(String)   # "imu" | "baro" | "compass"
    chip: Mapped[str] = mapped_column(String)
    bus: Mapped[str | None] = mapped_column(String, nullable=True)
    # BOARD_MATCH(...) token if the sensor line is gated to a hardware variant,
    # else NULL. Multiple sensors sharing the same variant token belong to the
    # same physical board revision.
    variant: Mapped[str | None] = mapped_column(String, nullable=True)
    # Physical socket key (e.g. "SPI1/DEVID2"). Sensors sharing a slot are
    # mutually-exclusive: only one chip can be mounted on that chip-select.
    slot: Mapped[str | None] = mapped_column(String, nullable=True)
    # Friendly chip name derived from the SPIDEV token (e.g. "ICM42688").
    chip_display: Mapped[str | None] = mapped_column(String, nullable=True)

    board: Mapped[Board] = relationship(back_populates="sensors")


class FirmwareSupport(Base):
    __tablename__ = "firmware_support"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    board_id: Mapped[int] = mapped_column(ForeignKey("boards.id"))
    firmware: Mapped[str] = mapped_column(String)   # ardupilot | px4 | inav | betaflight
    maturity: Mapped[str] = mapped_column(String)   # official | community | experimental

    board: Mapped[Board] = relationship(back_populates="firmware_support")


class BecRail(Base):
    """Hand-curated BEC output rail. Loaded from data/bec_overrides.json,
    keyed by board slug. Not derivable from hwdef."""
    __tablename__ = "bec_rails"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    board_id: Mapped[int] = mapped_column(ForeignKey("boards.id"))
    rail: Mapped[str] = mapped_column(String)         # "Servo", "Peripheral", "VTX", ...
    voltage_v: Mapped[float] = mapped_column(Float)
    current_a: Mapped[float] = mapped_column(Float)
    note: Mapped[str | None] = mapped_column(String, nullable=True)

    board: Mapped[Board] = relationship(back_populates="bec_rails")


@dataclass
class ParsedBoard:
    slug: str
    platform: str = "chibios"   # "chibios" | "linux"
    mcu_family: str | None = None
    mcu_part: str | None = None
    flash_kb: int | None = None
    # (chip, bus, variant, slot, chip_display) — slot/chip_display are
    # SPIDEV-derived (None for non-SPI sensors).
    imus: list[tuple[str, str, str | None, str | None, str | None]] = None
    baros: list[tuple[str, str, str | None, str | None, str | None]] = None
    compasses: list[tuple[str, str, str | None, str | None, str | None]] = None
    uart_buses: list[str] = None
    i2c_buses: list[str] = None
    spi_buses: list[str] = None
    can_buses: list[str] = None
    canfd: bool = False
    pwm_fmu: int = 0
    pwm_io: int = 0
    usb_count: int = 0
    ethernet: bool = False
    sdcard: bool = False
    sbus_out: bool = False
    iomcu: bool = False
    bdshot: bool = False
    bdshot_target: dict | None = None
    header_note: str | None = None
    serial_ports: list[dict] = None
    adc_inputs: int = 0
    power_inputs: int = 0
    vehicles: list[str] = None
    docs_url: str | None = None
    repo_url: str | None = None
    readme: str | None = None
    readme_name: str | None = None


MCU_RE = re.compile(r"^\s*MCU\s+(\S+)\s+(\S+)", re.MULTILINE)
FLASH_RE = re.compile(r"^\s*FLASH_SIZE_KB\s+(\d+)", re.MULTILINE)
# Sensor lines capture chip + bus + the rest of the line (for BOARD_MATCH extraction).
IMU_RE = re.compile(r"^\s*IMU\s+(\S+)\s+(\S+)(.*)$", re.MULTILINE)
BARO_RE = re.compile(r"^\s*BARO\s+(\S+)\s+(\S+)(.*)$", re.MULTILINE)
COMPASS_RE = re.compile(r"^\s*COMPASS\s+(\S+)\s+(\S+)(.*)$", re.MULTILINE)
BOARD_MATCH_RE = re.compile(r"\bBOARD_MATCH\(([^)]+)\)")
SERIAL_ORDER_RE = re.compile(r"^\s*SERIAL_ORDER\s+(.+)$", re.MULTILINE)
# `PA9 USART1_TX USART1` — a UART signal on a physical pad. TXINV/RXINV are
# hardware-inverted variants of TX/RX.
UART_PIN_RE = re.compile(r"^\s*(P[A-K]\d+)\s+(U(?:S)?ART\d+)_(TX|RX|RTS|CTS|TXINV|RXINV)\b", re.MULTILINE)
# `define DEFAULT_SERIAL7_PROTOCOL 23` — the SERIALn_PROTOCOL default the
# board ships with. Numeric in every hwdef; enum names accepted just in case.
DEFAULT_SERIAL_PROTOCOL_RE = re.compile(
    r"^\s*define\s+DEFAULT_SERIAL(\d)_PROTOCOL\s+(-?\d+|SerialProtocol_\w+)", re.MULTILINE)

# AP_SerialManager::SerialProtocol, short display names.
SERIAL_PROTOCOL_NAMES = {
    -1: "None", 0: "Console", 1: "MAVLink1", 2: "MAVLink2", 3: "FrSky D", 4: "FrSky SPort",
    5: "GPS", 6: "GPS", 7: "AlexMos gimbal", 8: "Gimbal", 9: "Rangefinder",
    10: "FrSky SPort passthrough", 11: "Lidar360", 12: "USD1", 13: "Beacon", 14: "Volz",
    15: "SBUS out", 16: "ESC telemetry", 17: "Devo telemetry", 18: "Optical flow",
    19: "Robotis servo", 20: "NMEA out", 21: "WindVane", 22: "SLCAN", 23: "RC input",
    24: "EFI", 25: "LTM telemetry", 26: "RunCam", 27: "HoTT telemetry", 28: "Scripting",
    29: "CRSF", 30: "Generator", 31: "Winch", 32: "MSP", 33: "DJI FPV", 34: "Airspeed",
    35: "ADSB", 36: "AHRS", 37: "SmartAudio", 38: "FETtec OneWire", 39: "Torqeedo",
    40: "AIS", 41: "CoDevESC", 42: "MSP DisplayPort", 43: "MAVLink high-latency",
    44: "IRC Tramp", 45: "DDS XRCE", 46: "IMU out", 48: "PPP", 49: "i-BUS telemetry",
    50: "IOMCU",
}
# Paragraph headings that say nothing about a specific port.
GENERIC_UART_HINTS = {"uarts", "uart", "usarts", "serial", "serial ports", "uart pins",
                      "order of uarts (and usb)", "order of uarts"}
# AP_SerialManager.cpp built-in defaults when the hwdef doesn't override.
SERIAL_PROTOCOL_BUILTIN = {0: 2, 1: 2, 2: 2, 3: 5, 4: 5}
I2C_ORDER_RE = re.compile(r"^\s*I2C_ORDER\s+(.+)$", re.MULTILINE)
SPIDEV_RE = re.compile(r"^\s*SPIDEV\s+\S+\s+(SPI\d+)", re.MULTILINE)
# Full SPIDEV form: SPIDEV <name> <SPIn> <DEVIDm> <CS> ...
# Used to resolve a sensor's bus token (e.g. "SPI:icm42688") to a physical
# (SPI bus, DEVID) slot — sensors sharing a slot are mutually-exclusive
# variants (only one chip can be mounted on a given chip-select line).
SPIDEV_FULL_RE = re.compile(
    r"^\s*SPIDEV\s+(\S+)\s+(SPI\d+)\s+(DEVID\d+)\s+(\S+)", re.MULTILINE
)
# Chip-name suffixes that mark placement / part-split rather than a different
# part number. Stripped when deriving a friendly chip name from a SPIDEV
# token (e.g. `icm20689_board` → `ICM20689`, `bmi088_a` → `BMI088`).
_CHIP_SUFFIX_RE = re.compile(
    r"(?:_(?:a|g|imu|board|ext|int)|-\d+)+$",
    re.IGNORECASE,
)
CAN_PIN_RE = re.compile(r"\bCAN(\d+)_(?:TX|RX)\b")
CANFD_RE = re.compile(r"^\s*CANFD_SUPPORTED\b", re.MULTILINE)
PWM_RE = re.compile(r"\bPWM\(\d+\)")
AUTOBUILD_RE = re.compile(r"^\s*AUTOBUILD_TARGETS\s+(.+)$", re.MULTILINE)
PHY_RE = re.compile(r"^\s*define\s+BOARD_PHY_ID\b", re.MULTILINE)
SDMMC_RE = re.compile(r"\bSDMMC\d?_(?:CK|CMD)\b")
FATFS_RE = re.compile(r"^\s*define\s+HAL_OS_FATFS_IO\s+1\b", re.MULTILINE)
IOMCU_RE = re.compile(r"^\s*IOMCU_UART\b|^\s*define\s+HAL_WITH_IO_MCU\w*\s+1\b", re.MULTILINE)
# Bidirectional DShot: a PWM pin tagged BIDIR, or the IOMCU flag. Boards that
# only get it via a sibling `<slug>-bdshot` hwdef are recorded separately.
BDSHOT_RE = re.compile(r"\bPWM\(\d+\)[^\n]*\bBIDIR\b|^\s*define\s+HAL_WITH_IO_MCU_BIDIR_DSHOT\s+1\b", re.MULTILINE)
# nVALID brick pins. Boards typically declare one per power input as
# VDD_BRICK_nVALID, VDD_BRICK2_nVALID, VDD_BRICK3_nVALID, etc.
BRICK_RE = re.compile(r"\bVDD_BRICK\d*_n?VALID\b")
# Onboard analog battery sensing — a single (non-redundant) power-monitor input
# on FPV/AIO boards that have no Pixhawk-style power bricks. Either an ADC pin
# labelled *_VOLTAGE_SENS or a HAL_BATT_VOLT_PIN define.
BATT_SENSE_RE = re.compile(r"\bBATT\w*_VOLTAGE_SENS\b|\bHAL_BATT_VOLT_PIN\b")
SBUS_OUT_RE = re.compile(
    r"^\s*define\s+HAL_GPIO_PIN_SBUS_OUT\b|^\s*PINIO_PIN\s+\S+\s+SBUS_OUT\b|\bSBUS_OUT\b",
    re.MULTILINE,
)
# ADC channel pin definitions — count distinct ADC pins by their PIN token,
# across ADC1/ADC2/ADC3.
ADC_PIN_RE = re.compile(r"^\s*(P[A-K]\d{1,2})\s+\S+\s+ADC[123]\b", re.MULTILINE)

ALL_VEHICLES = ["copter", "plane", "rover", "sub", "tracker", "blimp"]


def _resolve_slot(
    bus_token: str,
    spidev_map: dict[str, tuple[str, str]],
) -> tuple[str | None, str | None]:
    """Given a sensor bus token like `SPI:icm42688`, return (slot_key, chip_display).

    - slot_key is "<SPIn>/<DEVIDm>" if the spidev exists in the map, else None.
      Two sensors sharing a slot_key are mutually exclusive — only one chip
      is physically mounted on that chip-select.
    - chip_display is the SPIDEV name normalized: known placement suffixes
      (`_a`, `_g`, `_board`, `_imu`, ...) stripped, then uppercased.
    Returns (None, None) for non-SPI buses (I2C/etc.) — those have no
    SPI-slot collision and the caller falls back to the driver chip name.
    """
    if not bus_token.startswith("SPI:"):
        return None, None
    name = bus_token[4:].split()[0] if bus_token[4:] else ""
    if not name:
        return None, None
    info = spidev_map.get(name)
    slot = f"{info[0]}/{info[1]}" if info else None
    chip_display = _CHIP_SUFFIX_RE.sub("", name).upper() or name.upper()
    return slot, chip_display


INCLUDE_RE = re.compile(r"^\s*include\s+(\S+)", re.MULTILINE | re.IGNORECASE)


def _expand_includes(path: Path, visited: set[Path]) -> str:
    """Read a hwdef file and inline its `include` directives recursively.

    Many boards (notably the Cube family) declare SPIDEVs and pinmuxes in a
    parent hwdef (e.g. `include ../fmuv3/hwdef.dat`) — without expanding
    these, sensor-to-slot resolution misses every inherited SPIDEV.
    """
    try:
        resolved = path.resolve()
    except OSError:
        return ""
    if resolved in visited or not resolved.exists():
        return ""
    visited.add(resolved)
    try:
        text = resolved.read_text(errors="ignore")
    except OSError:
        return ""
    out: list[str] = []
    last = 0
    for m in INCLUDE_RE.finditer(text):
        out.append(text[last:m.start()])
        inc_path = (resolved.parent / m.group(1)).resolve()
        out.append(_expand_includes(inc_path, visited))
        last = m.end()
    out.append(text[last:])
    return "".join(out)


def read_hwdef_text(board_dir: Path) -> str:
    """Concatenate hwdef.dat + hwdef.inc with `include` directives expanded.

    Fields are split between .dat and .inc; both may chain through includes
    into shared parent hwdefs.
    """
    parts = []
    visited: set[Path] = set()
    for fname in ("hwdef.dat", "hwdef.inc"):
        parts.append(_expand_includes(board_dir / fname, visited))
    return "\n".join(parts)


def _apply_undef(text: str, keyword: str) -> str:
    """Honor `undef <KEYWORD>` directives for IMU/BARO/COMPASS lines.

    ArduPilot hwdefs that inherit from a parent (e.g. `include ../fmuv5/...`)
    often `undef IMU` to wipe the inherited sensor set before declaring their
    own. `undef <KEYWORD>` removes everything defined so far, so only
    definition lines after the *last* such undef survive. Without this the
    parser lists phantom inherited sensors (e.g. CUAVv5 showed 9 IMUs).
    """
    # ArduPilot's hwdef.py clears the whole sensor list whenever the bare
    # token IMU/BARO/COMPASS appears anywhere in an `undef` line (trailing
    # device names are no-ops); match that exactly.
    undef_re = re.compile(rf"^\s*undef\b.*\b{keyword}\b")
    def_re = re.compile(rf"^\s*{keyword}\s+\S")
    lines = text.split("\n")
    last_undef = -1
    for i, ln in enumerate(lines):
        if undef_re.match(ln):
            last_undef = i
    if last_undef < 0:
        return text
    return "\n".join(
        ln for i, ln in enumerate(lines)
        if not (i < last_undef and def_re.match(ln))
    )


def _apply_pin_undefs(text: str) -> str:
    """Honor `undef A B …` for pin / define lines, as ArduPilot's hwdef.py does.

    A variant hwdef (e.g. `MatekH743-bdshot`) includes its parent and then
    `undef`s the pins it remaps before redeclaring them. hwdef.py drops every
    earlier pin whose port (PB0) or label (TIM3_CH3) matches, and every
    `define NAME` line. Without this the redeclared pins are counted twice —
    MatekH743-bdshot reported 25 PWM outputs instead of 12.

    The `undef` lines themselves are kept so `_apply_undef` can still see the
    bare IMU / BARO / COMPASS keywords.
    """
    kept: list[str] = []
    for line in text.splitlines():
        toks = line.split()
        if len(toks) >= 2 and toks[0] == "undef":
            # `undef define FOO` appears in a few hwdefs; hwdef.py treats the
            # stray "define" token as a no-op, so it must not match `define`
            # lines by their first token.
            names = set(toks[1:]) - {"define"}
            kept = [
                k for k in kept
                if not (
                    (kt := k.split())
                    and (
                        kt[0] in names
                        or (len(kt) >= 2 and kt[1] in names)
                        or (len(kt) >= 2 and kt[0] == "define" and kt[1] in names)
                    )
                )
            ]
        kept.append(line)
    return "\n".join(kept)


def _strip_comments(text: str) -> str:
    """Remove `#` comments from hwdef text.

    In ChibiOS hwdef syntax `#` always starts a comment (directives are bare
    `define`/`undef`, never `#define`). Commented-out lines must not be parsed:
    without this, the PWM/CAN/etc. regexes count disabled pins — e.g. a board
    with `# PD0 CAN1_RX` (CAN removed) was still reported as having CAN.
    """
    return "\n".join(line.split("#", 1)[0] for line in text.splitlines())


def is_autopilot(slug: str) -> bool:
    if any(pat in slug for pat in PERIPHERAL_PATTERNS):
        return False
    if slug.startswith("bootloader") or slug.endswith("-bl"):
        return False
    return True


def _serial_ports(text: str, raw: str) -> list[dict]:
    """SERIALn → hardware UART → physical pads, from SERIAL_ORDER + pin lines.

    `text` is the comment-stripped, undef-applied hwdef (authoritative pins);
    `raw` still has comments, used only for the hint a hwdef author wrote
    above a UART's pins ("# USART6 (RC input), SERIAL7"). Index in
    SERIAL_ORDER is the SERIALn number; EMPTY keeps its slot, OTG is USB.
    """
    sm = SERIAL_ORDER_RE.search(text)
    if not sm:
        return []
    pins: dict[str, dict] = {}
    for m in UART_PIN_RE.finditer(text):
        pad, dev, sig = m.group(1), m.group(2), m.group(3)
        d = pins.setdefault(dev, {})
        if sig in ("TXINV", "RXINV"):
            d[sig[:2].lower()] = pad
            d["inverted"] = True
        else:
            d[sig.lower()] = pad
    # Hint: nearest comment line above a UART pin line, last occurrence wins
    # (a variant hwdef redeclares pins after its own comment).
    # Per device, the first comment block seen above its TX pin, else above
    # its RX pin. First line of a block is the heading ("USART6 (RC input),
    # SERIAL7"); later lines are prose. A hint that only repeats the device
    # name ("UART4") carries no information and is dropped.
    hint_tx: dict[str, str] = {}
    hint_rx: dict[str, str] = {}
    block: list[str] = []  # contiguous comment lines directly above the current line
    for line in raw.splitlines():
        s = line.strip()
        if s.startswith("#"):
            c = s.lstrip("#").strip()
            if c:
                block.append(c)
            continue
        if not s:
            block = []
            continue
        m = UART_PIN_RE.match(line)
        if m and block:
            dev, sig = m.group(2), m.group(3)
            target = hint_tx if sig.startswith("TX") else hint_rx
            target.setdefault(dev, block[0][:80])
        # Only a blank line ends a paragraph: every pin under one heading
        # shares it, even with other pin lines in between (e.g. the RC-input
        # timer pin declared between "# USART6 (RC input)" and USART6_TX).
    hints: dict[str, str] = {}
    for dev in set(hint_tx) | set(hint_rx):
        h = hint_tx.get(dev) or hint_rx.get(dev) or ""
        norm = h.rstrip(":").strip().lower()
        if norm and norm != dev.lower() and norm not in GENERIC_UART_HINTS:
            hints[dev] = h
    overrides: dict[int, int] = {}
    for m in DEFAULT_SERIAL_PROTOCOL_RE.finditer(text):
        v = m.group(2)
        if v.startswith("SerialProtocol_"):
            name = v[len("SerialProtocol_"):]
            num = next((k for k, n in SERIAL_PROTOCOL_NAMES.items()
                        if n.replace(" ", "").lower() == name.replace("_", "").lower()), None)
            if num is None:
                continue
            v = str(num)
        overrides[int(m.group(1))] = int(v)
    out: list[dict] = []
    for n, tok in enumerate(sm.group(1).split()):
        if tok == "EMPTY":
            continue
        from_hwdef = n in overrides
        pid = overrides.get(n, SERIAL_PROTOCOL_BUILTIN.get(n, -1))
        proto = {"id": pid, "name": SERIAL_PROTOCOL_NAMES.get(pid, str(pid)), "from_hwdef": from_hwdef}
        if tok.startswith("OTG"):
            out.append({"serial": n, "device": tok, "usb": True, "tx": None, "rx": None,
                        "rts": None, "cts": None, "inverted": False, "protocol": proto, "hint": None})
            continue
        p = pins.get(tok, {})
        out.append({
            "serial": n, "device": tok, "usb": False,
            "tx": p.get("tx"), "rx": p.get("rx"), "rts": p.get("rts"), "cts": p.get("cts"),
            "inverted": bool(p.get("inverted")), "protocol": proto, "hint": hints.get(tok),
        })
    return out


def _header_note(path: Path) -> str | None:
    """The leading `#` comment block of a hwdef file, as plain text.

    Variant hwdefs open with a note on what they change ("RC input moves to
    UART…"); surfaced on the board page next to the firmware-target toggle.
    """
    if not path.exists():
        return None
    lines: list[str] = []
    for raw in path.read_text(errors="replace").splitlines():
        s = raw.strip()
        if not s.startswith("#"):
            if lines or s:
                break
            continue
        lines.append(s.lstrip("#").strip())
    note = " ".join(l for l in lines if l).strip()
    return note or None


def _io_from_parsed(p: "ParsedBoard") -> dict:
    """io block for a ParsedBoard — same shape as _board_payload()["io"]."""
    return {
        "uart_count": len(p.uart_buses or []),
        "uart_buses": list(p.uart_buses or []),
        "i2c_count": len(p.i2c_buses or []),
        "i2c_buses": list(p.i2c_buses or []),
        "spi_count": len(p.spi_buses or []),
        "spi_buses": list(p.spi_buses or []),
        "can_count": len(p.can_buses or []),
        "can_buses": list(p.can_buses or []),
        "canfd": bool(p.canfd),
        "usb_count": p.usb_count,
        "pwm": {"fmu": p.pwm_fmu, "io": p.pwm_io, "total": p.pwm_fmu + p.pwm_io},
        "ethernet": bool(p.ethernet),
        "sdcard": bool(p.sdcard),
        "sbus_out": bool(p.sbus_out),
        "iomcu": bool(p.iomcu),
        "bdshot": bool(p.bdshot),
        "adc_inputs": p.adc_inputs,
        "serial_ports": list(p.serial_ports or []),
    }


def merge_bdshot_targets(parsed: list["ParsedBoard"]) -> list["ParsedBoard"]:
    """Fold each "<slug>-bdshot" hwdef into its base board as a firmware target.

    A -bdshot hwdef is the same PCB with a different pin map (see the note at
    the top of any of them), so it is not a separate board. Variants whose
    base isn't an autopilot in the catalog stay as standalone entries.
    """
    by_slug = {p.slug: p for p in parsed}
    out: list[ParsedBoard] = []
    for p in parsed:
        if p.slug.endswith("-bdshot") and p.slug[: -len("-bdshot")] in by_slug:
            base = by_slug[p.slug[: -len("-bdshot")]]
            base.bdshot_target = {"slug": p.slug, "notes": p.header_note, "io": _io_from_parsed(p)}
            continue
        out.append(p)
    return out


def parse_board(board_dir: Path, platform: str = "chibios") -> ParsedBoard | None:
    slug = board_dir.name
    if not is_autopilot(slug):
        return None
    text = read_hwdef_text(board_dir)
    if not text:
        return None
    raw = text
    # Strip comments so disabled (`#`-commented) pin/feature lines aren't parsed.
    text = _strip_comments(text)
    text = _apply_pin_undefs(text)

    mcu_m = MCU_RE.search(text)
    flash_m = FLASH_RE.search(text)

    spidev_map = {
        m.group(1): (m.group(2), m.group(3))
        for m in SPIDEV_FULL_RE.finditer(text)
    }
    # name → "SPIn/CS_PIN" — two SPIDEVs sharing a CS pin on the same bus
    # are wired to the same physical footprint (one chip can be populated).
    spidev_cs = {
        m.group(1): f"{m.group(2)}/CS:{m.group(4)}"
        for m in SPIDEV_FULL_RE.finditer(text)
    }

    def _sensors(rx, stext):
        # Each line may reference more than one SPI bus (BMI088 declares both
        # an accel and a gyro bus). Collect every slot the line touches so we
        # can detect mutually-exclusive chip variants that share a chip-select
        # with another sensor entry (e.g. BMI088 fallback for an ICM42688
        # populated on the same footprint).
        raw = []
        for m in rx.finditer(stext):
            tail = m.group(3) or ""
            bm = BOARD_MATCH_RE.search(tail)
            variant = bm.group(1).strip() if bm else None
            bus_token = m.group(2)
            slot, chip_display = _resolve_slot(bus_token, spidev_map)
            # Merge keys: (SPI bus, DEVID) AND (SPI bus, CS pin). Either
            # collision marks two chips as alternates for one footprint.
            phys_keys: set[str] = set()
            for tok in [bus_token, *re.findall(r"SPI:\S+", tail)]:
                if not tok.startswith("SPI:"):
                    continue
                name = tok[4:].split()[0]
                info = spidev_map.get(name)
                if info:
                    phys_keys.add(f"{info[0]}/{info[1]}")
                cs_key = spidev_cs.get(name)
                if cs_key:
                    phys_keys.add(cs_key)
            im = re.search(r"\bINSTANCE:(\d+)", tail)
            instance = f"INSTANCE:{im.group(1)}" if im else None
            raw.append([m.group(1), bus_token, variant, slot, chip_display,
                        phys_keys, instance])

        # If any line uses INSTANCE annotations, that's the authoritative
        # logical-IMU identity. Non-INSTANCE lines on the same board are
        # inherited fallbacks for older revs — absorb each into the INSTANCE
        # group it physically overlaps with (shared SPI bus + DEVID or CS
        # pin); drop the rest so they don't inflate the count.
        if any(r[6] for r in raw):
            instance_keys: dict[str, set[str]] = {}
            for r in raw:
                if r[6]:
                    instance_keys.setdefault(r[6], set()).update(r[5])
            out = []
            for r in raw:
                inst = r[6]
                if not inst:
                    # find the INSTANCE whose physical keys overlap
                    for cand, keys in instance_keys.items():
                        if r[5] & keys:
                            inst = cand
                            break
                if inst:
                    out.append((r[0], r[1], r[2], inst, r[4]))
            return out

        # No INSTANCE annotations — union-find over physical keys.
        parent = list(range(len(raw)))
        def find(i):
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i
        def union(i, j):
            ri, rj = find(i), find(j)
            if ri != rj:
                parent[ri] = rj
        key_owner: dict[str, int] = {}
        for i, r in enumerate(raw):
            for s in r[5]:  # phys_keys
                if s in key_owner:
                    union(i, key_owner[s])
                else:
                    key_owner[s] = i

        # Assign every entry in a group the same canonical slot (lex-smallest
        # merge key) so downstream dedupe-by-slot collapses alternates into
        # one IMU.
        groups: dict[int, set[str]] = {}
        for i, r in enumerate(raw):
            groups.setdefault(find(i), set()).update(r[5])
        canonical = {root: (min(ks) if ks else None) for root, ks in groups.items()}

        out = []
        for i, r in enumerate(raw):
            canon = canonical[find(i)]
            out.append((r[0], r[1], r[2], canon if canon else r[3], r[4]))
        return out

    imus = _sensors(IMU_RE, _apply_undef(text, "IMU"))
    baros = _sensors(BARO_RE, _apply_undef(text, "BARO"))
    compasses = _sensors(COMPASS_RE, _apply_undef(text, "COMPASS"))

    if not imus:
        return None

    # SERIAL_ORDER lists every serial port; OTG entries are USB.
    uart_buses: list[str] = []
    usb_count = 0
    sm = SERIAL_ORDER_RE.search(text)
    if sm:
        for t in sm.group(1).split():
            if t == "EMPTY":
                continue
            if t.startswith("OTG"):
                usb_count += 1
            else:
                uart_buses.append(t)

    i2c_buses: list[str] = []
    im = I2C_ORDER_RE.search(text)
    if im:
        i2c_buses = [t for t in im.group(1).split() if t.startswith("I2C")]

    spi_buses = sorted({m.group(1) for m in SPIDEV_RE.finditer(text)})
    can_buses = sorted({f"CAN{m.group(1)}" for m in CAN_PIN_RE.finditer(text)})
    canfd = bool(CANFD_RE.search(text))

    # PWM split: total PWM channels declared, plus 8 extra from IOMCU when present.
    pwm_total = len(PWM_RE.findall(text))
    iomcu = bool(IOMCU_RE.search(text))
    pwm_io = 8 if iomcu else 0
    pwm_fmu = pwm_total

    ethernet = bool(PHY_RE.search(text))
    sdcard = bool(FATFS_RE.search(text)) or bool(SDMMC_RE.search(text))
    sbus_out = bool(SBUS_OUT_RE.search(text))
    bdshot = bool(BDSHOT_RE.search(text))
    header_note = _header_note(board_dir / "hwdef.dat")
    serial_ports = _serial_ports(text, raw)
    adc_inputs = len(set(ADC_PIN_RE.findall(text)))
    # Distinct brick indices: VDD_BRICK_nVALID, VDD_BRICK2_nVALID → 2 inputs.
    # Boards with no bricks but onboard analog battery sensing have one
    # (non-redundant) power-monitor input — otherwise every FPV/AIO board
    # reports 0 despite measuring pack voltage/current.
    power_inputs = len({m for m in BRICK_RE.findall(text)})
    if power_inputs == 0 and BATT_SENSE_RE.search(text):
        power_inputs = 1

    # Vehicle support — defaults to all six unless hwdef overrides via AUTOBUILD_TARGETS.
    am = AUTOBUILD_RE.search(text)
    if am:
        raw = am.group(1).strip().lower()
        vehicles = [] if raw == "none" else [v.strip() for v in raw.split(",") if v.strip()]
    else:
        vehicles = list(ALL_VEHICLES)

    # Take the filename from the directory listing rather than assuming
    # "README.md". A dozen hwdefs spell it "Readme.md" or "readme.md", and on a
    # case-insensitive filesystem (macOS) `(dir / "README.md").exists()` is True
    # for all of them — so the generated GitHub URL 404'd, because GitHub is
    # case-sensitive. The link checker is what surfaced it.
    readme_name = next(
        (f.name for f in sorted(board_dir.iterdir()) if f.name.lower() == "readme.md"),
        None,
    )
    readme_path = board_dir / readme_name if readme_name else None
    readme = readme_path.read_text(errors="ignore") if readme_path else None

    return ParsedBoard(
        slug=slug,
        platform=platform,
        mcu_family=mcu_m.group(1) if mcu_m else None,
        mcu_part=mcu_m.group(2) if mcu_m else None,
        flash_kb=int(flash_m.group(1)) if flash_m else None,
        imus=imus,
        baros=baros,
        compasses=compasses,
        uart_buses=uart_buses,
        i2c_buses=i2c_buses,
        spi_buses=spi_buses,
        can_buses=can_buses,
        canfd=canfd,
        pwm_fmu=pwm_fmu,
        pwm_io=pwm_io,
        usb_count=usb_count,
        ethernet=ethernet,
        sdcard=sdcard,
        sbus_out=sbus_out,
        iomcu=iomcu,
        bdshot=bdshot,
        header_note=header_note,
        serial_ports=serial_ports,
        adc_inputs=adc_inputs,
        power_inputs=power_inputs,
        vehicles=vehicles,
        readme=readme,
        readme_name=readme_name,
    )


def _norm(s: str) -> str:
    """Lowercase alphanumeric-only normalization for fuzzy slug matching."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


# A toctree entry in common-autopilots.rst: "    Display Name <target>", where
# target is either a wiki stem (common-foo) or an external URL (vendor / README).
_INDEX_ENTRY_RE = re.compile(r"^[ \t]+(.+?)\s+<([^>]+)>\s*$", re.MULTILINE)

_TOKEN_SPLIT = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z]+|\d+")
# Generic words that match too many boards; ignore them when scoring.
_STOP_TOKENS = {"the", "common", "overview", "fc", "v", "ardupilot", "autopilot", "flight"}

# Hardware-variant qualifiers used to disambiguate which wiki page a board maps
# to when several share a base name (e.g. kakutef7 → ...aio vs ...mini). Matched
# as substrings of the normalized stem; only consulted to break ties between
# candidates that already share the same base overlap.
_VARIANT_TOKENS = (
    "mini", "nano", "pro", "plus", "wing", "aio", "lite", "extreme",
    "ultra", "dual", "prime", "hd", "rf", "se", "v1", "v2", "v3", "v4", "v5",
)


def _variants_in(norm: str) -> set[str]:
    return {t for t in _VARIANT_TOKENS if t in norm}


def _readme_heading(readme: str | None) -> str:
    """First markdown heading of a hwdef README — the board's canonical name."""
    if not readme:
        return ""
    for line in readme.splitlines():
        s = line.strip()
        if s.startswith("#"):
            return s.lstrip("#").strip()
    return ""


def _tokens(s: str) -> list[str]:
    return [t.lower() for t in _TOKEN_SPLIT.findall(s) if t.lower() not in _STOP_TOKENS]


def build_docs_map() -> dict[str, tuple[str, list[str], str]]:
    """Build canonical-key → (doc-name, tokens, platform) map from the local wiki.

    Sources:
      - common/source/docs/common-*.rst (rendered under /copter/docs/)
      - <platform>/source/docs/*.rst for each platform in WIKI_PLATFORMS
        (rendered under /<platform>/docs/)
      - common-* references inside common-autopilots.rst

    Map key is the normalized stem with leading `common-` and trailing
    `-overview` / `-autopilot` removed.
    """
    # (doc_stem, platform) entries.
    entries: set[tuple[str, str]] = set()

    if ARDUPILOT_WIKI_DOCS.exists():
        for p in ARDUPILOT_WIKI_DOCS.glob("common-*.rst"):
            entries.add((p.stem, COMMON_PLATFORM))
        ap_page = ARDUPILOT_WIKI_DOCS / "common-autopilots.rst"
        if ap_page.exists():
            for m in re.finditer(r"common-[A-Za-z0-9._-]+", ap_page.read_text(errors="ignore")):
                name = m.group(0)
                if name.endswith(".rst"):
                    name = name[:-4]
                entries.add((name, COMMON_PLATFORM))
        entries.discard(("common-autopilots", COMMON_PLATFORM))

    for platform in WIKI_PLATFORMS:
        pdir = ARDUPILOT_WIKI_ROOT / platform / "source" / "docs"
        if not pdir.exists():
            continue
        for p in pdir.glob("*.rst"):
            # Only pages that look like board landing pages, to avoid linking
            # generic guides. Heuristic: ends with `-autopilot` or `-overview`.
            stem = p.stem
            if stem.endswith("-autopilot") or stem.endswith("-overview"):
                entries.add((stem, platform))

    out: dict[str, tuple[str, list[str], str]] = {}
    # A page can exist under several platforms (the wiki ships copies of each
    # common-* page under blimp/, rover/, … as well as copter/). First-wins
    # registration must therefore prefer the *canonical* platform, not whatever
    # sorts first alphabetically — otherwise `blimp` beats `copter` and every
    # common page links to the blimp render. Rank by WIKI_PLATFORMS order
    # (copter == COMMON_PLATFORM first); tie-break by name for determinism
    # (set iteration is hash-randomized per process).
    def _rank(entry: tuple[str, str]) -> tuple[str, int, str]:
        doc, platform = entry
        try:
            pr = WIKI_PLATFORMS.index(platform)
        except ValueError:
            pr = len(WIKI_PLATFORMS)
        return (doc, pr, platform)

    for doc, platform in sorted(entries, key=_rank):
        core = doc[len("common-"):] if doc.startswith("common-") else doc
        for suffix in ("-overview", "-autopilot"):
            if core.endswith(suffix):
                core = core[: -len(suffix)]
                break
        key = _norm(core)
        if key and key not in out:
            out[key] = (doc, _tokens(core), platform)
    return out


def build_index_url_map() -> dict[str, str]:
    """Map normalized board name → external URL from the autopilots index.

    common-autopilots.rst lists some boards as `Display Name <https://…>` —
    a vendor page or a hwdef README — instead of a wiki page. These are the
    maintainer-chosen link for boards with no dedicated wiki page. Used only as
    a *fallback*: a real wiki match always wins (see populate_db).
    """
    page = ARDUPILOT_WIKI_DOCS / "common-autopilots.rst"
    if not page.exists():
        return {}
    out: dict[str, str] = {}
    for disp, target in _INDEX_ENTRY_RE.findall(page.read_text(errors="ignore")):
        target = target.strip()
        if not target.startswith(("http://", "https://")):
            continue  # internal wiki stem — already covered by build_docs_map
        key = _norm(disp)
        if key:
            out.setdefault(key, target)
    return out


def _doc_url(doc: str, platform: str) -> str:
    return f"{DOCS_BASE}/{platform}/docs/{doc}.html"


def match_index_url(slug: str, index_map: dict[str, str]) -> str | None:
    """Exact (or `the`-prefixed) normalized match against the index URL map."""
    if not index_map:
        return None
    key = _norm(slug)
    return index_map.get(key) or index_map.get("the" + key)


def match_docs_url(
    slug: str,
    docs_map: dict[str, tuple[str, list[str], str]],
    readme: str | None = None,
) -> str | None:
    """Match a board slug to a wiki doc using progressively looser strategies.

    1. Exact normalized-string match.
    2. "the" + slug (ArduPilot prefixes Cube boards).
    3. Substring containment of normalized strings, with min length 6 to
       guard against accidental hits on short tokens.
    4. Meaningful-token overlap: every alphabetic token of length >= 3 in the
       slug must appear (exact or substring) in some wiki token of length
       >= 3, AND at least 2 such tokens must agree.

    When several wiki pages tie on overlap (e.g. ...kakutef7aio vs
    ...kakutef7mini both contain "kakutef7"), the variant qualifier in the
    board's README heading / slug breaks the tie — deterministically, and
    preferring the base page when the board declares no variant.
    """
    if not docs_map:
        return None
    key = _norm(slug)
    if key in docs_map:
        doc, _t, platform = docs_map[key]
        return _doc_url(doc, platform)
    if ("the" + key) in docs_map:
        doc, _t, platform = docs_map["the" + key]
        return _doc_url(doc, platform)

    board_vars = _variants_in(_norm(_readme_heading(readme))) | _variants_in(key)

    def _pick(cands: list[tuple[str, str]]) -> tuple[str, str]:
        # cands: (wkey, doc, platform-bearing tuple) reduced to (wkey, doc, platform).
        # Prefer: most board-matching variant tokens, then fewest wrong
        # variant tokens, then shortest stem (base page), then lexicographic.
        return min(
            cands,
            key=lambda c: (
                -len(_variants_in(c[0]) & board_vars),
                len(_variants_in(c[0]) - board_vars),
                len(c[0]),
                c[1],
            ),
        )[1:]

    # Substring containment on normalized strings. Best = longest overlap;
    # ties resolved by variant qualifier (above), not set/dict order.
    if len(key) >= 6:
        best_overlap = 0
        tied: list[tuple[str, str, str]] = []
        for wkey, (doc, _wtoks, platform) in docs_map.items():
            if len(wkey) < 6:
                continue
            if key in wkey:
                overlap = len(key)
            elif wkey in key:
                overlap = len(wkey)
            else:
                continue
            if overlap > best_overlap:
                best_overlap = overlap
                tied = [(wkey, doc, platform)]
            elif overlap == best_overlap:
                tied.append((wkey, doc, platform))
        if tied:
            doc, platform = _pick(tied)
            return _doc_url(doc, platform)

    # Token overlap, last resort. Score using ALL slug tokens (exact-match
    # works for short tokens like "3"/"dr"/"g"; substring only for ≥3-char
    # tokens). Tie-break by preferring the most-specific wiki page (fewest
    # unmatched extra tokens).
    slug_toks = _tokens(slug)
    if len(slug_toks) < 2:
        return None
    threshold = max(2, int(round(len(slug_toks) * 0.75)))

    best: tuple[int, float, str, str] | None = None
    for _wkey, (doc, wtoks, platform) in docs_map.items():
        if len(wtoks) < 1:
            continue
        hits = 0
        for st in slug_toks:
            for wt in wtoks:
                if st == wt:
                    hits += 1
                    break
                if len(st) >= 3 and len(wt) >= 3 and (st in wt or wt in st):
                    hits += 1
                    break
        if hits < threshold:
            continue
        wiki_specificity = hits / len(wtoks)  # higher = wiki is more focused on these tokens
        ranking = (hits, wiki_specificity, doc, platform)
        if best is None or ranking > best:
            best = ranking
    if best:
        return _doc_url(best[2], best[3])
    return None


def load_bec_overrides() -> dict[str, list[dict]]:
    """Load hand-curated BEC rails per slug. Keys starting with `_` are
    metadata (e.g. _README) and ignored."""
    if not BEC_OVERRIDES.exists():
        return {}
    raw = json.loads(BEC_OVERRIDES.read_text())
    return {k: v for k, v in raw.items() if not k.startswith("_") and isinstance(v, list)}


def load_docs_overrides() -> dict[str, str]:
    """Load hand/AI-verified docs_url corrections per slug. These win over the
    fuzzy matcher for boards where it links the wrong variant or a different
    product (found by the fc-verify-enrich cross-check). Keys starting with
    `_` are metadata."""
    if not DOCS_OVERRIDES.exists():
        return {}
    raw = json.loads(DOCS_OVERRIDES.read_text())
    return {k: v for k, v in raw.items() if not k.startswith("_") and isinstance(v, str)}


def populate_db(session: Session, parsed: list[ParsedBoard], docs_map: dict[str, tuple[str, list[str], str]]) -> None:
    bec_map = load_bec_overrides()
    docs_overrides = load_docs_overrides()
    index_map = build_index_url_map()
    for p in parsed:
        hal_dir = HAL_DIR.get(p.platform, "AP_HAL_ChibiOS")
        # The hwdef README on GitHub, if this board ships one.
        readme_url = (
            HWDEF_README_URL.format(hal_dir=hal_dir, slug=p.slug, readme=p.readme_name)
            if p.readme_name else None
        )
        # Linux boards rarely have a wiki page; the hwdef dir is a guaranteed
        # source link. Kept Linux-only so ChibiOS output is byte-identical.
        dir_url = HWDEF_DIR_URL.format(hal_dir=hal_dir, slug=p.slug) if p.platform == "linux" else None
        # Primary link: an explicit override wins; then a real wiki page;
        # otherwise fall back to the maintainer-chosen index URL, then README.
        wiki = match_docs_url(p.slug, docs_map, p.readme)
        p.docs_url = docs_overrides.get(p.slug) or wiki or match_index_url(p.slug, index_map) or readme_url or dir_url
        # Secondary "source" link (the hwdef README, or an external index URL),
        # shown alongside docs_url when it's a distinct destination.
        second = readme_url or match_index_url(p.slug, index_map) or dir_url
        p.repo_url = second if second != p.docs_url else None
        b = Board(
            slug=p.slug,
            name=p.slug,                 # TODO: pretty-name from wiki / README
            platform=p.platform,
            manufacturer=None,           # TODO: infer from slug / wiki
            mcu_family=p.mcu_family,
            mcu_part=p.mcu_part,
            flash_kb=p.flash_kb,
            uart_buses_csv=",".join(p.uart_buses or []),
            i2c_buses_csv=",".join(p.i2c_buses or []),
            spi_buses_csv=",".join(p.spi_buses or []),
            can_buses_csv=",".join(p.can_buses or []),
            canfd=p.canfd,
            pwm_fmu=p.pwm_fmu,
            pwm_io=p.pwm_io,
            usb_count=p.usb_count,
            ethernet=p.ethernet,
            sdcard=p.sdcard,
            sbus_out=p.sbus_out,
            iomcu=p.iomcu,
            bdshot=p.bdshot,
            bdshot_target_json=json.dumps(p.bdshot_target) if p.bdshot_target else None,
            serial_ports_json=json.dumps(p.serial_ports or []),
            adc_inputs=p.adc_inputs,
            power_inputs=p.power_inputs,
            vehicles_csv=",".join(p.vehicles or []),
            docs_url=p.docs_url,
            repo_url=p.repo_url,
            readme=p.readme,
        )
        for chip, bus, variant, slot, chip_display in p.imus:
            b.sensors.append(Sensor(kind="imu", chip=chip, bus=bus,
                                    variant=variant, slot=slot,
                                    chip_display=chip_display))
        for chip, bus, variant, slot, chip_display in p.baros:
            b.sensors.append(Sensor(kind="baro", chip=chip, bus=bus,
                                    variant=variant, slot=slot,
                                    chip_display=chip_display))
        for chip, bus, variant, slot, chip_display in p.compasses:
            b.sensors.append(Sensor(kind="compass", chip=chip, bus=bus,
                                    variant=variant, slot=slot,
                                    chip_display=chip_display))
        b.firmware_support.append(FirmwareSupport(firmware="ardupilot", maturity="official"))
        for entry in bec_map.get(p.slug, []):
            b.bec_rails.append(BecRail(
                rail=str(entry["rail"]),
                voltage_v=float(entry["voltage_v"]),
                current_a=float(entry["current_a"]),
                note=entry.get("note"),
            ))
        session.add(b)
    session.commit()


def export_robots(out_path: Path) -> None:
    out_path.write_text(
        "User-agent: *\n"
        "Allow: /\n"
        f"Sitemap: {SITE_BASE_URL}/sitemap.xml\n"
    )


# Keys this script owns — anything else in an existing per-board file
# (notably the `manual` block edited by hand or via the admin UI) is preserved.
GENERATED_KEYS = {
    "slug", "name", "manufacturer", "mcu", "flash_kb", "io", "power",
    "imus", "baros", "compasses", "firmware_support", "vehicles", "docs_url",
    "repo_url",
}

MANUAL_TEMPLATE = {
    "status": "not_started",
    # Vendor name recovered from the hwdef README / wiki. The top-level
    # `manufacturer` is build-derived (and still always None), so a name put
    # there would be lost on the next import; this one is preserved.
    "manufacturer": None,
    "form_factor": None,
    "mounting": None,
    "assembly": None,
    "dimensions_mm": None,
    "weight_g": None,
    "connectors": [],
    "images": [],
    "ardupilot_repo_url": None,
    "discontinued": False,
    # Override the parser's IMU slot count for boards where hwdef structure
    # doesn't match physical reality (alt chips on idiosyncratic SPI layouts,
    # aspirational hwdef comments, etc). null = use parser's count.
    "imu_count": None,
    # Retail products sold against this firmware target. ArduPilot ships one
    # hwdef per target, but vendors often sell several physically different
    # boards against it (the MatekH743 target covers -WING/-SLIM/-MINI/-WLITE),
    # and those products have no hwdef of their own. Empty = single product.
    "variants": [],
    # Vendor datasheets and manuals, as URLs only — the PDF stays on the
    # vendor's server. Promoted here from the extraction pass's ai.documents
    # once a human has opened the link and confirmed it is the right board.
    "documents": [],
    "notes": None,
}


def _board_payload(b: "Board") -> dict:
    uart_buses = [x for x in b.uart_buses_csv.split(",") if x]
    i2c_buses = [x for x in b.i2c_buses_csv.split(",") if x]
    spi_buses = [x for x in b.spi_buses_csv.split(",") if x]
    can_buses = [x for x in b.can_buses_csv.split(",") if x]
    return {
        "slug": b.slug,
        "name": b.name,
        "platform": b.platform,
        "manufacturer": b.manufacturer,
        "mcu": {"family": b.mcu_family, "part": b.mcu_part},
        "flash_kb": b.flash_kb,
        "io": {
            "uart_count": len(uart_buses),
            "uart_buses": uart_buses,
            "i2c_count": len(i2c_buses),
            "i2c_buses": i2c_buses,
            "spi_count": len(spi_buses),
            "spi_buses": spi_buses,
            "can_count": len(can_buses),
            "can_buses": can_buses,
            "canfd": bool(b.canfd),
            "usb_count": b.usb_count,
            "pwm": {
                "fmu": b.pwm_fmu,
                "io": b.pwm_io,
                "total": b.pwm_fmu + b.pwm_io,
            },
            "ethernet": bool(b.ethernet),
            "sdcard": bool(b.sdcard),
            "sbus_out": bool(b.sbus_out),
            "iomcu": bool(b.iomcu),
            "bdshot": bool(b.bdshot),
            "adc_inputs": b.adc_inputs,
            # SERIALn → UART → pads; see _serial_ports().
            "serial_ports": json.loads(b.serial_ports_json or "[]"),
        },
        # The "<slug>-bdshot" firmware target folded into this board, if any:
        # same PCB, different pin map. {slug, notes, io}.
        "bdshot_target": json.loads(b.bdshot_target_json) if b.bdshot_target_json else None,
        "power": {
            "monitor_inputs": b.power_inputs,
            "bec": [
                {"rail": r.rail, "voltage_v": r.voltage_v,
                 "current_a": r.current_a, "note": r.note}
                for r in b.bec_rails
            ],
        },
        "imus":     [{"chip": s.chip, "bus": s.bus, "variant": s.variant, "slot": s.slot, "chip_display": s.chip_display} for s in b.sensors if s.kind == "imu"],
        "baros":    [{"chip": s.chip, "bus": s.bus, "variant": s.variant, "slot": s.slot, "chip_display": s.chip_display} for s in b.sensors if s.kind == "baro"],
        "compasses":[{"chip": s.chip, "bus": s.bus, "variant": s.variant, "slot": s.slot, "chip_display": s.chip_display} for s in b.sensors if s.kind == "compass"],
        "firmware_support": [
            {"firmware": f.firmware, "maturity": f.maturity}
            for f in b.firmware_support
        ],
        "vehicles": [v for v in b.vehicles_csv.split(",") if v],
        "docs_url": b.docs_url,
        "repo_url": b.repo_url,
    }


def export_per_board(session: Session, out_dir: Path) -> int:
    """Write one JSON file per board, preserving any existing `manual` block."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for b in session.scalars(select(Board)).all():
        path = out_dir / f"{b.slug}.json"
        manual = dict(MANUAL_TEMPLATE)
        ai_block: dict | None = None
        if path.exists():
            try:
                existing = json.loads(path.read_text())
                if isinstance(existing.get("manual"), dict):
                    manual = {**MANUAL_TEMPLATE, **existing["manual"]}
                if isinstance(existing.get("ai"), dict):
                    ai_block = existing["ai"]
            except json.JSONDecodeError:
                pass  # corrupt file — overwrite from scratch
        payload = _board_payload(b)
        payload["manual"] = manual
        if ai_block is not None:
            payload["ai"] = ai_block
            # Surface the AI-suggested manufacturer as a (secondary) discovery
            # field when the build pipeline has none of its own. It's a filter
            # aid, not authoritative — the docs link remains the source of truth.
            if not payload.get("manufacturer") and ai_block.get("manufacturer"):
                payload["manufacturer"] = ai_block["manufacturer"]
        path.write_text(json.dumps(payload, indent=2) + "\n")
        written += 1
    return written


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"}
HWDEF_GITHUB_RAW = (
    "https://raw.githubusercontent.com/ArduPilot/ardupilot/master/"
    "libraries/AP_HAL_ChibiOS/hwdef"
)


def export_hwdef_images(hwdef_root: Path, out_path: Path) -> int:
    """Walk every hwdef board dir and list image files. Images are served
    directly from GitHub raw (not copied into the build)."""
    entries: list[dict] = []
    for board_dir in sorted(hwdef_root.iterdir()):
        if not board_dir.is_dir():
            continue
        images = sorted(
            str(f.relative_to(board_dir))
            for f in board_dir.rglob("*")
            if f.is_file() and f.suffix.lower() in IMAGE_EXTS
        )
        if images:
            entries.append({
                "slug": board_dir.name,
                "is_autopilot": is_autopilot(board_dir.name),
                "images": images,
            })
    out_path.write_text(json.dumps({
        "base_url": HWDEF_GITHUB_RAW,
        "boards": entries,
    }, indent=2))
    return sum(len(e["images"]) for e in entries)


def main() -> int:
    if not ARDUPILOT_HWDEF.exists():
        print(f"ArduPilot hwdef dir not found at {ARDUPILOT_HWDEF}", file=sys.stderr)
        return 1

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    db_path = DATA_DIR / "fcpicker.sqlite"
    if db_path.exists():
        db_path.unlink()
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)

    parsed: list[ParsedBoard] = []
    sources = [(ARDUPILOT_HWDEF, "chibios")]
    if ARDUPILOT_LINUX_HWDEF.exists():
        sources.append((ARDUPILOT_LINUX_HWDEF, "linux"))
    for root, platform in sources:
        for board_dir in sorted(root.iterdir()):
            if not board_dir.is_dir():
                continue
            p = parse_board(board_dir, platform=platform)
            if p:
                parsed.append(p)
    parsed = merge_bdshot_targets(parsed)

    docs_map = build_docs_map()

    boards_dir = DATA_DIR / "boards"
    with Session(engine) as session:
        populate_db(session, parsed, docs_map)
        n_boards = export_per_board(session, boards_dir)
        # Sitemap lives in bundle.py: it must cover rangefinders as well as
        # boards, and must regenerate without an ArduPilot checkout.
        from bundle import write_sitemap
        write_sitemap(FRONTEND_PUBLIC / "sitemap.xml")
        export_robots(FRONTEND_PUBLIC / "robots.txt")

    # Concat per-board files into the single boards.json the frontend fetches.
    from bundle import bundle
    bundle(boards_dir, FRONTEND_PUBLIC / "boards.json")

    img_count = export_hwdef_images(ARDUPILOT_HWDEF, FRONTEND_PUBLIC / "hwdef-images.json")

    matched = sum(1 for p in parsed if p.docs_url)
    print(f"Parsed {n_boards} autopilot boards "
          f"({matched} matched to docs, {len(parsed) - matched} unmatched).")
    print(f"  SQLite: {db_path}")
    print(f"  JSON:   {FRONTEND_PUBLIC / 'boards.json'}")
    print(f"  Images: {img_count} across {FRONTEND_PUBLIC / 'hwdef-images.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
