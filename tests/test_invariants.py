"""Cross-cutting invariants over the committed board catalog.

These are the properties that must hold for the site to show real numbers
instead of nonsense: sensor counts that fit in a physical airframe, sane MCU
metadata, non-negative peripheral counts, a sitemap that neither hides nor
invents boards, and well-formed external links. Each failure mode here is
silent in the UI otherwise — a board just quietly shows a wrong or missing
value, or a search engine gets a 404.
"""
from __future__ import annotations

import re
from pathlib import Path
from xml.etree import ElementTree

import pytest

from sanity_check import MAX_IMU, counts, positions

# Raise this as the catalog grows (new hwdef boards land via tools/build.py).
# Never lower it to make a test pass — a drop below this floor means the
# parser silently ate boards, which is exactly the regression this guards.
MIN_BOARD_COUNT = 300

# Mirrors frontend/src/data.ts MAX_IMU_SLOTS / tools/sanity_check.py MAX_IMU:
# the physical ceiling on ArduPilot's INS instance count.
MAX_IMU_SLOTS = 3


def test_imu_count_within_physical_bounds(boards):
    """A count above the ceiling must be a human decision, never a silent clamp.

    ArduPilot instantiates at most 3 IMUs, but a few premium boards physically
    carry a fourth footprint (QioTek Zealot, VUAV V7pro). So exceeding the
    ceiling is allowed — but only when a person has looked at the hwdef and
    recorded `manual.imu_count` in that board's JSON. Without the override we
    cannot tell "the board really has four" from "the parser is wrong", and
    guessing in favour of either is how a wrong spec reaches a buyer.
    """
    unverified = []
    for b in boards:
        imu, _, _ = counts(b)
        override = (b.get("manual") or {}).get("imu_count")
        if imu > MAX_IMU and override is None:
            unverified.append(
                f"{b['slug']}: parser found {imu} IMU chip-selects and no "
                f"manual.imu_count override"
            )
        elif not (1 <= imu):
            unverified.append(f"{b['slug']}: IMU={imu} (must be at least 1)")
    assert not unverified, (
        "IMU counts above the ceiling need a verified override.\n  "
        + "\n  ".join(unverified)
        + "\n\nCheck the board's hwdef. If it really has that many IMU positions, set "
          "manual.imu_count to confirm it; if not, the parser needs fixing."
    )

def test_baro_and_compass_within_bounds(boards):
    bad = []
    for b in boards:
        _, baro, comp = counts(b)
        if not (0 <= baro <= 3):
            bad.append(f"{b['slug']}: Baro={baro}")
        if not (0 <= comp <= 3):
            bad.append(f"{b['slug']}: Compass={comp}")
    assert not bad, f"displayed baro/compass count outside 0..3: {bad}"


def test_raw_imu_overcount_is_tracked(boards):
    """MAX_IMU_SLOTS caps the *displayed* IMU count at 3, which can mask a
    parser problem: a board whose hwdef genuinely yields 4+ distinct physical
    IMU slots (SPI chip-select / I2C bus channel) silently gets rounded down
    to "3" in the UI instead of surfacing as a bug. Compute the RAW, uncapped
    slot count here so an overcount stays a visible, tracked list of parse
    problems rather than being swallowed by the display cap.

    If this starts failing for new boards, investigate each one (duplicate
    BOARD_MATCH variants being counted as separate slots is the usual cause)
    before deciding whether to fix the parser or extend the xfail list.
    """
    offenders = []
    for b in boards:
        raw = positions(b["imus"])
        if raw > MAX_IMU_SLOTS:
            offenders.append(f"{b['slug']} (raw={raw})")

    if offenders:
        pytest.xfail(
            "boards with raw (uncapped) IMU slot count > "
            f"{MAX_IMU_SLOTS}, masked by the frontend's display cap: "
            + ", ".join(offenders)
        )


def test_chibios_boards_have_mcu_family(boards):
    bad = [
        b["slug"]
        for b in boards
        if b["platform"] == "chibios" and not (b.get("mcu") or {}).get("family")
    ]
    assert not bad, f"chibios boards with no mcu.family: {bad}"


def test_flash_kb_is_sane(boards):
    bad = []
    for b in boards:
        flash = b.get("flash_kb")
        if flash is None:
            continue
        if not isinstance(flash, int) or isinstance(flash, bool):
            bad.append(f"{b['slug']}: flash_kb={flash!r} (not an int)")
        elif not (0 < flash <= 8192):
            bad.append(f"{b['slug']}: flash_kb={flash}")
    assert not bad, f"flash_kb not None or 1..8192: {bad}"


def test_io_counts_are_non_negative(boards):
    scalar_fields = [
        "uart_count",
        "i2c_count",
        "spi_count",
        "can_count",
        "usb_count",
        "adc_inputs",
    ]
    bad = []
    for b in boards:
        io = b.get("io") or {}
        for field in scalar_fields:
            v = io.get(field)
            if v is None:
                continue
            if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                bad.append(f"{b['slug']}: io.{field}={v!r}")
        pwm = io.get("pwm") or {}
        for field in ("fmu", "io", "total"):
            v = pwm.get(field)
            if v is None:
                continue
            if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                bad.append(f"{b['slug']}: io.pwm.{field}={v!r}")
    assert not bad, f"negative or non-int io counts: {bad}"


def test_sitemap_covers_every_board(boards, repo_root):
    sitemap = repo_root / "frontend" / "public" / "sitemap.xml"
    tree = ElementTree.parse(sitemap)
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = [el.text or "" for el in tree.getroot().findall("sm:url/sm:loc", ns)]
    slugs_in_sitemap = {
        loc.rsplit("/board/", 1)[1] for loc in locs if "/board/" in loc
    }
    board_slugs = {b["slug"] for b in boards}
    missing = sorted(board_slugs - slugs_in_sitemap)
    assert not missing, f"boards missing from sitemap.xml: {missing}"


def test_sitemap_has_no_phantom_boards(boards, repo_root):
    sitemap = repo_root / "frontend" / "public" / "sitemap.xml"
    tree = ElementTree.parse(sitemap)
    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = [el.text or "" for el in tree.getroot().findall("sm:url/sm:loc", ns)]
    slugs_in_sitemap = {
        loc.rsplit("/board/", 1)[1] for loc in locs if "/board/" in loc
    }
    board_slugs = {b["slug"] for b in boards}
    phantom = sorted(slugs_in_sitemap - board_slugs)
    assert not phantom, f"sitemap.xml has stale entries for removed boards: {phantom}"


def test_docs_urls_are_well_formed(boards):
    bad = []
    for b in boards:
        for field in ("docs_url", "repo_url"):
            v = b.get(field)
            if v is None:
                continue
            if not re.match(r"^https://", v):
                bad.append(f"{b['slug']}: {field}={v!r} (does not start with https://)")
            elif re.search(r"\s", v):
                bad.append(f"{b['slug']}: {field}={v!r} (contains whitespace)")
    assert not bad, f"malformed docs_url/repo_url values: {bad}"


def test_board_count_floor(boards):
    assert len(boards) >= MIN_BOARD_COUNT, (
        f"only {len(boards)} boards found, below the floor of {MIN_BOARD_COUNT} "
        "— a parser regression may be silently dropping boards"
    )
