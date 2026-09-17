"""Rangefinder catalog integrity.

`data/rangefinders/<kind>-<slug>.json` is bundled into
`frontend/public/rangefinders.json` and served exactly like the board
catalog — pre-rendered, linked from every board's "add a rangefinder" flow,
and listed in the sitemap (see test_sitemap_covers_the_rangefinder_catalog in
test_invariants.py). But at 44 devices it has had essentially none of the
scrutiny the 300+ boards get. The failure modes are the same shape as a bad
board: a duplicate RNGFND/PRX_TYPE param_value means two devices fight over
one parameter slot, a missing type_id means the device can never actually be
selected in ArduPilot, and a stale bundle means the live site serves data
older than what's committed.

The `rangefinders` fixture lives here rather than in tests/conftest.py
because nothing else in the suite needs the raw per-file catalog.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from build_rangefinders import MANUAL_TEMPLATE, bundle_drivers

KNOWN_KINDS = {"rangefinder", "proximity"}
KNOWN_DIRECTIONALITY = {"unidirectional", "omnidirectional"}


@pytest.fixture(scope="session")
def rangefinder_files(repo_root: Path) -> list[Path]:
    files = sorted((repo_root / "data" / "rangefinders").glob("*.json"))
    assert files, "no rangefinder files under data/rangefinders"
    return files


@pytest.fixture(scope="session")
def rangefinders(rangefinder_files: list[Path]) -> list[dict]:
    return [json.loads(f.read_text()) for f in rangefinder_files]


def test_filename_stem_matches_kind_and_slug(rangefinder_files):
    """Files are namespaced `<kind>-<slug>.json`, not bare `<slug>.json`.

    export_per_driver() in tools/build_rangefinders.py does this deliberately
    ("Slug collisions across kinds ... are possible") even though no
    collision exists in the catalog today — so the filename is kind-qualified
    even though the `slug` field alone is not.
    """
    mismatched = []
    for f in rangefinder_files:
        doc = json.loads(f.read_text())
        expected = f"{doc['kind']}-{doc['slug']}"
        if expected != f.stem:
            mismatched.append((f.name, expected))
    assert not mismatched, (
        f"rangefinder files whose name isn't <kind>-<slug>.json: {mismatched}"
    )


def test_slugs_are_unique(rangefinders):
    slugs = [r["slug"] for r in rangefinders]
    dupes = {s for s in slugs if slugs.count(s) > 1}
    assert not dupes, f"duplicate rangefinder slugs: {sorted(dupes)}"


def test_kind_and_directionality_are_known(rangefinders):
    bad = [
        (r["slug"], r.get("kind"), r.get("directionality"))
        for r in rangefinders
        if r.get("kind") not in KNOWN_KINDS
        or r.get("directionality") not in KNOWN_DIRECTIONALITY
    ]
    assert not bad, f"devices with an unrecognised kind/directionality: {bad}"


def _rangefinder_tech_values(repo_root: Path) -> set[str]:
    """RangefinderTech union members, read from types.ts so this test can't
    drift from the frontend contract it's checking."""
    types_ts = (repo_root / "frontend" / "src" / "types.ts").read_text()
    m = re.search(r"export type RangefinderTech =\s*(.*?);", types_ts, re.DOTALL)
    assert m, "could not find `export type RangefinderTech = ...` in types.ts"
    return set(re.findall(r'"([a-z]+)"', m.group(1)))


def test_tech_is_null_or_a_known_value(rangefinders, repo_root):
    known = _rangefinder_tech_values(repo_root)
    assert known, "parsed no values out of RangefinderTech"
    bad = [(r["slug"], r["tech"]) for r in rangefinders if r["tech"] is not None and r["tech"] not in known]
    assert not bad, f"devices with a tech value outside RangefinderTech: {bad}"


# Devices with no type_ids at all. tools/build_rangefinders.py's
# attach_enum_ids() matches an enum member to a driver by normalised
# substring, but ArduPilot abbreviates several enum names (MBI2C, LWI2C,
# LWSER, TRI2C, PLI2C/PLI2CV3/PLI2CV3HP) in ways that share no substring with
# the driver's own slug (e.g. "mbi2c" vs "maxsonari2cxl"), so the match
# silently fails for these. This is a real build-script gap, not correct
# data — but tools/ is out of scope here, so it's tracked as a known set
# instead of asserted away: a NEW device joining it unannounced is still a
# regression worth seeing, and a slug leaving it should have this list
# trimmed.
# Emptied once tools/build_rangefinders.py learned ArduPilot's abbreviated enum
# names (MBI2C, LWSER, TRI2C, PLI2Cv3…). Every device now carries its
# RNGFNDx_TYPE / PRXx_TYPE value, so this asserts that outright: a device
# arriving with none means the enum-to-driver matching missed a real type.
KNOWN_MISSING_TYPE_ID: set[str] = set()


def test_type_ids_present_and_well_formed(rangefinders):
    missing = {r["slug"] for r in rangefinders if not r["type_ids"]}
    new = sorted(missing - KNOWN_MISSING_TYPE_ID)
    assert not new, (
        f"device(s) with no type_ids and not in KNOWN_MISSING_TYPE_ID: {new}\n"
        "Check whether tools/build_rangefinders.py's enum-to-driver matching "
        "missed a real ArduPilot RNGFND/PRX_TYPE for this slug."
    )
    fixed = sorted(KNOWN_MISSING_TYPE_ID - missing)
    assert not fixed, f"no longer missing type_ids — remove from KNOWN_MISSING_TYPE_ID: {fixed}"

    bad = []
    for r in rangefinders:
        for t in r["type_ids"]:
            if not isinstance(t.get("enum"), str) or not t["enum"]:
                bad.append((r["slug"], "enum", t.get("enum")))
            if not isinstance(t.get("param_value"), int) or isinstance(t.get("param_value"), bool):
                bad.append((r["slug"], "param_value", t.get("param_value")))
    assert not bad, f"type_ids entries missing a string enum or int param_value: {bad}"


def test_param_values_are_unique_within_kind(rangefinders):
    """Two devices of the same kind sharing a param_value would mean two
    different RNGFNDx_TYPE (or PRX_TYPE) settings select the same driver —
    a real ArduPilot data error, not a display bug."""
    by_kind: dict[str, dict[int, list[str]]] = {}
    for r in rangefinders:
        for t in r["type_ids"]:
            owners = by_kind.setdefault(r["kind"], {}).setdefault(t["param_value"], [])
            owners.append(f"{r['slug']}:{t['enum']}")
    dupes = {
        kind: {v: owners for v, owners in values.items() if len(owners) > 1}
        for kind, values in by_kind.items()
    }
    dupes = {k: v for k, v in dupes.items() if v}
    assert not dupes, f"param_value claimed by more than one device of the same kind: {dupes}"


def test_range_fields_are_sane(rangefinders):
    bad = []
    for r in rangefinders:
        rmin, rmax = r.get("wiki_range_min_m"), r.get("wiki_range_max_m")
        if rmin is not None and rmin < 0:
            bad.append(f"{r['slug']}: wiki_range_min_m={rmin} (negative)")
        if rmax is not None and rmax < 0:
            bad.append(f"{r['slug']}: wiki_range_max_m={rmax} (negative)")
        if rmin is not None and rmax is not None and not (rmin < rmax):
            bad.append(f"{r['slug']}: wiki_range_min_m={rmin} >= wiki_range_max_m={rmax}")
    assert not bad, f"malformed wiki range fields: {bad}"


def test_manual_block_has_every_template_key(rangefinders):
    """MANUAL_TEMPLATE is the shape tools/build_rangefinders.py writes and
    preserves across re-runs (mirrors test_manual_block_has_every_template_key
    for boards in test_board_data.py)."""
    template_keys = set(MANUAL_TEMPLATE.keys())
    missing: dict[str, list[str]] = {}
    for r in rangefinders:
        manual = r.get("manual") or {}
        miss = sorted(template_keys - set(manual.keys()))
        if miss:
            missing[r["slug"]] = miss
    assert not missing, f"devices whose manual block is missing template keys: {missing}"


def test_bundle_is_not_stale(repo_root, tmp_path):
    """rangefinders.json is committed (Cloudflare's build env doesn't run
    Python) — if it drifts from data/rangefinders/*.json, the live site
    serves stale device data. Same guard as test_bundle_is_not_stale for
    boards.json in test_board_data.py."""
    out_path = tmp_path / "rangefinders.json"
    bundle_drivers(repo_root / "data" / "rangefinders", out_path)
    fresh = json.loads(out_path.read_text())
    committed = json.loads((repo_root / "frontend" / "public" / "rangefinders.json").read_text())
    assert fresh == committed, (
        "frontend/public/rangefinders.json is stale relative to "
        "data/rangefinders/*.json — run "
        "`.venv/bin/python tools/build_rangefinders.py` and commit the result"
    )


ARDUPILOT_WIKI_DOCS = Path.home() / "ardupilot_wiki" / "common" / "source" / "docs"

needs_wiki = pytest.mark.skipif(
    not ARDUPILOT_WIKI_DOCS.exists(), reason="needs an ardupilot_wiki checkout at ~/ardupilot_wiki"
)


@needs_wiki
def test_docs_urls_are_https_and_resolve_locally(rangefinders):
    bad = []
    for r in rangefinders:
        url = r.get("docs_url")
        if url is None:
            continue
        if not url.startswith("https://"):
            bad.append(f"{r['slug']}: docs_url={url!r} (not https)")
            continue
        if "ardupilot.org" not in url:
            continue
        m = re.search(r"/docs/([^/]+?)\.html$", url)
        if not m:
            bad.append(f"{r['slug']}: docs_url={url!r} (unexpected shape)")
            continue
        stem = m.group(1)
        if not (ARDUPILOT_WIKI_DOCS / f"{stem}.rst").exists():
            bad.append(f"{r['slug']}: docs_url={url!r} has no matching {stem}.rst in the wiki checkout")
    assert not bad, f"broken rangefinder docs_url values: {bad}"
