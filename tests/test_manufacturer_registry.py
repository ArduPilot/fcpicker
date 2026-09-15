"""Manufacturer registry integrity.

The registry is the join between a board's free-text manufacturer string and
its purchase links and partner status. Every failure mode here is silent in
the UI: a duplicate alias sends a board to the wrong company, a missing alias
drops its buy link, a stale partner flag credits the wrong vendor.
"""
from __future__ import annotations

import re

import pytest

from bundle import manufacturer_key


def test_every_id_is_unique(registry):
    ids = [e["id"] for e in registry]
    dupes = {i for i in ids if ids.count(i) > 1}
    assert not dupes, f"duplicate manufacturer ids: {sorted(dupes)}"


def test_every_alias_is_claimed_by_exactly_one_company(registry):
    owner: dict[str, str] = {}
    clashes: list[str] = []
    for entry in registry:
        for alias in entry["aliases"]:
            if alias in owner:
                clashes.append(f"{alias!r}: {owner[alias]} and {entry['id']}")
            owner[alias] = entry["id"]
    assert not clashes, "aliases claimed twice: " + "; ".join(clashes)


def test_aliases_are_already_normalised(registry):
    """An alias that isn't in normalised form can never be matched."""
    bad = [
        (e["id"], a)
        for e in registry
        for a in e["aliases"]
        if a != manufacturer_key(a)
    ]
    assert not bad, f"aliases not in normalised form: {bad}"


def test_every_board_manufacturer_resolves(boards, registry):
    alias_to_id = {a: e["id"] for e in registry for a in e["aliases"]}
    unmapped: dict[str, list[str]] = {}
    for b in boards:
        raw = (b.get("manual") or {}).get("manufacturer") or b.get("manufacturer")
        if not raw:
            continue
        if manufacturer_key(raw) not in alias_to_id:
            unmapped.setdefault(raw, []).append(b["slug"])
    assert not unmapped, (
        "manufacturer spellings with no registry entry (these boards get no "
        f"purchase link and group wrongly in the filter): {unmapped}"
    )


@pytest.mark.parametrize("field", ["website", "store_url", "distributors_url"])
def test_urls_are_absolute_http(registry, field):
    bad = [
        (e["id"], e[field])
        for e in registry
        if e.get(field) and not re.match(r"^https?://", e[field])
    ]
    assert not bad, f"{field} values that are not absolute http(s) URLs: {bad}"


def test_verified_entries_carry_at_least_one_url(registry):
    """`verified: true` asserts a human confirmed a link — so there must be one."""
    bad = [
        e["id"]
        for e in registry
        if e["verified"]
        and not (e.get("website") or e.get("store_url") or e.get("distributors_url"))
    ]
    assert not bad, f"marked verified but have no URL: {bad}"


def test_partner_flag_is_present_and_boolean(registry):
    bad = [e["id"] for e in registry if not isinstance(e.get("ardupilot_partner"), bool)]
    assert not bad, f"ardupilot_partner missing or non-boolean: {bad}"
