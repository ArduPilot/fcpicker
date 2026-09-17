"""Per-board catalog data integrity.

`data/boards/<slug>.json` is the source of truth for the whole site (see
CLAUDE.md): the frontend never talks to a server, it just fetches the bundled
`boards.json`. Every failure mode here is silent until a real user hits it —
a board that can't be looked up by its own filename, a `manual` block missing
a field the admin UI expects, a weight stored as `"23g"` that breaks a numeric
sort/filter, or a stale `boards.json` that ships data older than what's
committed under `data/boards/`. These tests run against the real 300+ board
catalog, not synthetic fixtures, because the bugs worth catching are
properties of the actual data.
"""
from __future__ import annotations

import json
import re

import pytest

from build import MANUAL_TEMPLATE
from bundle import bundle

REQUIRED_TOP_LEVEL_KEYS = [
    "slug", "name", "platform", "mcu", "io", "power",
    "imus", "baros", "compasses", "firmware_support", "vehicles",
]
KNOWN_PLATFORMS = {"chibios", "linux"}
KNOWN_VEHICLES = {"copter", "plane", "rover", "sub", "tracker", "blimp"}


def test_filename_matches_slug(board_files):
    mismatched = []
    for f in board_files:
        doc_slug = json.loads(f.read_text()).get("slug")
        if doc_slug != f.stem:
            mismatched.append((f.name, doc_slug))
    assert not mismatched, (
        f"board files whose slug doesn't match their filename: {mismatched}"
    )


def test_slugs_are_unique(boards):
    slugs = [b["slug"] for b in boards]
    dupes = {s for s in slugs if slugs.count(s) > 1}
    assert not dupes, f"duplicate slugs across data/boards/*.json: {sorted(dupes)}"


def test_required_top_level_keys(boards):
    missing: dict[str, list[str]] = {}
    for b in boards:
        miss = [k for k in REQUIRED_TOP_LEVEL_KEYS if k not in b]
        if miss:
            missing[b.get("slug", "<unknown>")] = miss
    assert not missing, f"boards missing required top-level keys: {missing}"


def test_platform_is_known(boards):
    bad = [(b["slug"], b.get("platform")) for b in boards if b.get("platform") not in KNOWN_PLATFORMS]
    assert not bad, f"boards with an unknown platform (want chibios/linux): {bad}"


def test_vehicles_are_known(boards):
    bad: dict[str, list[str]] = {}
    for b in boards:
        unknown = [v for v in b.get("vehicles", []) if v not in KNOWN_VEHICLES]
        if unknown:
            bad[b["slug"]] = unknown
    assert not bad, f"boards with unrecognised vehicle entries: {bad}"


def test_manual_block_has_every_template_key(boards):
    """A key silently dropped by hand-editing breaks the admin UI's assumptions
    about the shape of `manual` (see MANUAL_TEMPLATE in tools/build.py)."""
    template_keys = set(MANUAL_TEMPLATE.keys())
    missing: dict[str, list[str]] = {}
    for b in boards:
        manual = b.get("manual") or {}
        miss = sorted(template_keys - set(manual.keys()))
        if miss:
            missing[b["slug"]] = miss
    assert not missing, f"boards whose manual block is missing template keys: {missing}"


def test_manual_variants_shape(boards):
    bad: list[tuple[str, str, object]] = []
    dup_names: list[str] = []
    for b in boards:
        variants = (b.get("manual") or {}).get("variants") or []
        names = []
        for v in variants:
            name = v.get("name")
            names.append(name)
            if not isinstance(name, str) or not name:
                bad.append((b["slug"], "name", name))
            aliases = v.get("aliases")
            if not isinstance(aliases, list) or not all(isinstance(a, str) for a in aliases):
                bad.append((b["slug"], "aliases", aliases))
            discontinued = v.get("discontinued")
            if not isinstance(discontinued, bool):
                bad.append((b["slug"], "discontinued", discontinued))
            product_url = v.get("product_url")
            if product_url is not None and not str(product_url).startswith("http"):
                bad.append((b["slug"], "product_url", product_url))
        if len(names) != len(set(names)):
            dup_names.append(b["slug"])
    assert not bad, f"manual.variants entries with malformed fields (slug, field, value): {bad}"
    assert not dup_names, f"boards with duplicate variant names: {dup_names}"


def test_numeric_fields_are_numeric(boards):
    """A weight/dimension stored as a string (e.g. "23g") silently breaks any
    numeric sort or filter over it in the frontend."""
    bad: list[tuple[str, str, object]] = []
    for b in boards:
        slug = b["slug"]
        manual = b.get("manual") or {}
        weight = manual.get("weight_g")
        if weight is not None and not isinstance(weight, (int, float)):
            bad.append((slug, "manual.weight_g", weight))
        imu_count = manual.get("imu_count")
        if imu_count is not None and not isinstance(imu_count, (int, float)):
            bad.append((slug, "manual.imu_count", imu_count))
        dims = manual.get("dimensions_mm") or {}
        for dim in ("length", "width", "height"):
            v = dims.get(dim)
            if v is not None and not isinstance(v, (int, float)):
                bad.append((slug, f"manual.dimensions_mm.{dim}", v))
        ai = b.get("ai") or {}
        ai_weight = ai.get("weight_g")
        if ai_weight is not None and not isinstance(ai_weight, (int, float)):
            bad.append((slug, "ai.weight_g", ai_weight))
    assert not bad, f"non-numeric values in numeric fields (slug, field, value): {bad}"


def _board_ai_allowed_keys(repo_root) -> set[str]:
    """Allowed `ai` keys, parsed from the BoardAi interface in types.ts.

    Regex-based on purpose: this is the same contract check the frontend
    relies on (types.ts is the documented shape of `ai`), so we read it from
    the interface itself rather than hardcoding a second copy of the list.
    """
    types_ts = (repo_root / "frontend" / "src" / "types.ts").read_text()
    m = re.search(r"export interface BoardAi \{(.*?)\n\}", types_ts, re.DOTALL)
    assert m, "could not find `export interface BoardAi { ... }` in types.ts"
    keys = re.findall(r"^\s*(\w+)\??:", m.group(1), re.MULTILINE)
    assert keys, "found BoardAi interface but parsed no keys out of it"
    # `source` (which subagent/workflow produced this block) is used in
    # practice but isn't part of the typed frontend contract.
    return set(keys) | {"source"}


# Was xfailed while the extraction workflow wrote fields BoardAi never
# declared. Those are now declared (mcu_part, imu_models, field_checks and the
# rest of the cross-check group), so this is a live guard again: a pass that
# invents a new field fails here rather than silently filling board files with
# data the frontend can never read.
def test_ai_block_has_no_unknown_keys(boards, repo_root):
    allowed = _board_ai_allowed_keys(repo_root)
    unknown: dict[str, list[str]] = {}
    for b in boards:
        ai = b.get("ai")
        if not ai:
            continue
        extra = sorted(set(ai.keys()) - allowed)
        if extra:
            unknown[b["slug"]] = extra
    assert not unknown, f"boards whose `ai` block has keys outside BoardAi: {unknown}"


def test_bundle_is_not_stale(repo_root, tmp_path):
    """boards.json is committed (Cloudflare's build env doesn't run Python) —
    if it drifts from data/boards/*.json, the live site serves stale data."""
    out_path = tmp_path / "boards.json"
    bundle(repo_root / "data" / "boards", out_path)
    fresh = json.loads(out_path.read_text())
    committed = json.loads((repo_root / "frontend" / "public" / "boards.json").read_text())
    assert fresh == committed, (
        "frontend/public/boards.json is stale relative to data/boards/*.json — "
        "run `.venv/bin/python tools/bundle.py` and commit the result"
    )
