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


# Boards whose hwdef declares more IMU chip-selects than ArduPilot can
# instantiate. Every one has a human-verified manual.imu_count recording the
# real number; this set exists so a NEW one cannot appear unnoticed.
KNOWN_RAW_IMU_OVERCOUNT = {"QioTekZealotF427", "QioTekZealotH743", "VUAV-V7pro"}


def test_raw_imu_overcount_is_tracked(boards):
    """The parser reading more than 3 IMU positions must stay a known set.

    It is not an error in itself — the QioTek Zealot and VUAV V7pro genuinely
    expose a fourth chip-select for alternates or a reserve footprint, all
    confirmed against the wiki or the hwdef README. A board appearing here
    unannounced means either a new such board or a parser regression, and both
    want a human look before the displayed count is trusted.
    """
    over = {b["slug"] for b in boards if positions(b["imus"]) > MAX_IMU}
    new = sorted(over - KNOWN_RAW_IMU_OVERCOUNT)
    assert not new, (
        "new board(s) parsing above the IMU ceiling:\n  "
        + "\n  ".join(f"{s}: raw={next(positions(b['imus']) for b in boards if b['slug'] == s)}" for s in new)
        + "\n\nCheck the hwdef, then record a verified manual.imu_count and add the "
          "slug here."
    )
    gone = sorted(KNOWN_RAW_IMU_OVERCOUNT - over)
    assert not gone, f"no longer overcounting — remove from KNOWN_RAW_IMU_OVERCOUNT: {gone}"

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


def test_sitemap_advertises_only_what_is_built(repo_root):
    """Never list a URL that has no file behind it.

    The published site is the flight-controller picker; prerender.mjs does not
    emit the rangefinder catalog unless INCLUDE_RANGEFINDERS=1, so the sitemap
    must not offer those URLs either. A sitemap entry with no page behind it
    sends a crawler we invited straight to a 404, which is worse than simply
    not mentioning it.

    If rangefinders are ever published again, both sides flip together.
    """
    import xml.etree.ElementTree as ET

    sitemap = repo_root / "frontend" / "public" / "sitemap.xml"
    ns = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
    locs = {el.text for el in ET.parse(sitemap).getroot().iter(f"{ns}loc")}

    advertised = sorted(loc for loc in locs if "/rangefinder" in loc)
    assert not advertised, (
        "sitemap lists rangefinder URLs that prerender.mjs does not build:\n  "
        + "\n  ".join(advertised[:10])
    )


HWDEF_ROOT = Path.home() / "ardupilot" / "libraries"

needs_ardupilot = pytest.mark.skipif(
    not HWDEF_ROOT.exists(), reason="needs an ArduPilot checkout at ~/ardupilot"
)


@needs_ardupilot
def test_github_readme_links_match_the_real_filename(boards):
    """GitHub is case-sensitive; macOS is not.

    A dozen hwdefs spell it "Readme.md" or "readme.md". On a case-insensitive
    filesystem `(dir / "README.md").exists()` is True for every one of them, so
    a URL built from the assumed name resolves locally and 404s on GitHub —
    which is how three boards ended up with a dead link as their primary
    docs_url.
    """
    wrong = []
    for b in boards:
        for key in ("docs_url", "repo_url"):
            url = b.get(key) or ""
            if "github.com" not in url or not url.lower().endswith("readme.md"):
                continue
            linked = url.rsplit("/", 1)[-1]
            actual = None
            for hal in ("AP_HAL_ChibiOS", "AP_HAL_Linux"):
                d = HWDEF_ROOT / hal / "hwdef" / b["slug"]
                if d.is_dir():
                    actual = next(
                        (f.name for f in sorted(d.iterdir()) if f.name.lower() == "readme.md"),
                        None,
                    )
                    break
            if actual and actual != linked:
                wrong.append(f"{b['slug']}: links {linked}, file is {actual}")
    assert not wrong, (
        "GitHub README links whose capitalisation does not match the file:\n  "
        + "\n  ".join(wrong)
    )
