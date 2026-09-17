"""Every ArduPilot autopilot wiki page should be reachable from some board.

The rest of the suite checks the catalog from the hwdef side: it can prove the
boards we have are correct, but it structurally cannot notice a board we never
imported. This file checks from the other direction — ArduPilot's own
"Choosing an Autopilot" index lists every autopilot page on the wiki, so a page
that no board's `docs_url` points at means either a missing board or a failed
docs match.

Doc matching is the known weak link in the pipeline (`build.py` uses four
progressively looser slug-matching strategies), so this is the test most likely
to catch a real gap.

The known-missing set below is a RATCHET: it may shrink, never grow. A newly
unreferenced page fails immediately; the existing ones are tracked debt.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

WIKI_INDEX = Path.home() / "ardupilot_wiki/common/source/docs/common-autopilots.rst"

# Pages in the autopilot toctree that do not describe a specific board.
NOT_A_BOARD = {
    "common-limited-firmware",  # explains flash limits, not a product
}

# Wiki pages with no board pointing at them, as of the day this was written.
# Each is either a board we have not imported or one whose docs_url match
# failed. Remove entries as they are fixed; never add to this list to make a
# failing test pass — a new entry means a real regression.
KNOWN_UNREFERENCED = {
    "common-cuav-pixhawkv6X",
    "common-cuav-v5plus-overview",
    "common-erle-brain-linux-autopilot",
    "common-holybro-pix32v6",
    "common-intel-aero-rtf",
    "common-makeflyeasy-PixSurveyA1",
    "common-matekf405-se",
}

requires_wiki = pytest.mark.skipif(
    not WIKI_INDEX.exists(),
    reason="needs an ardupilot_wiki clone at ~/ardupilot_wiki",
)


def wiki_autopilot_pages() -> set[str]:
    """Wiki page stems listed in the autopilot index's toctrees.

    Entries read `Display Name <target>`; some targets are GitHub URLs rather
    than wiki pages, and a few carry a stray `.rst` suffix that Sphinx tolerates.
    """
    text = re.sub(r"\\\n\s*", "", WIKI_INDEX.read_text(errors="ignore"))
    pages: set[str] = set()
    in_toctree = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith(".. toctree::"):
            in_toctree = True
            continue
        if not in_toctree:
            continue
        if stripped.startswith(":") or not stripped:
            continue
        if not line.startswith(" "):
            in_toctree = False
            continue
        m = re.search(r"<([^>]+)>\s*$", stripped)
        target = m.group(1) if m else stripped
        if target.startswith("http"):
            continue  # documented on GitHub, not the wiki
        pages.add(target.removesuffix(".rst"))
    return pages - NOT_A_BOARD


def referenced_pages(boards: list[dict]) -> set[str]:
    out = set()
    for b in boards:
        url = b.get("docs_url")
        if url:
            out.add(url.rsplit("/", 1)[-1].removesuffix(".html"))
    return out


@requires_wiki
def test_wiki_index_is_parseable():
    """Guards the parser above: a wiki reformat must not silently yield zero."""
    pages = wiki_autopilot_pages()
    assert len(pages) > 80, (
        f"only parsed {len(pages)} autopilot pages from {WIKI_INDEX.name} — "
        "the index format probably changed and this file's parser needs updating"
    )


@requires_wiki
def test_no_new_unreferenced_wiki_pages(boards):
    """A wiki autopilot page nobody links to is a board we are missing."""
    unreferenced = wiki_autopilot_pages() - referenced_pages(boards)
    new = sorted(unreferenced - KNOWN_UNREFERENCED)
    assert not new, (
        "wiki autopilot page(s) that no board references:\n  "
        + "\n  ".join(new)
        + "\n\nEither the board is missing from data/boards, or its docs_url "
          "failed to match. Do not add these to KNOWN_UNREFERENCED to silence "
          "this — fix the data."
    )


@requires_wiki
def test_known_unreferenced_list_has_not_gone_stale(boards):
    """The ratchet only tightens: fixed entries must leave the list."""
    unreferenced = wiki_autopilot_pages() - referenced_pages(boards)
    fixed = sorted(KNOWN_UNREFERENCED - unreferenced)
    assert not fixed, (
        "these pages are now referenced — delete them from KNOWN_UNREFERENCED:\n  "
        + "\n  ".join(fixed)
    )


@requires_wiki
def test_every_docs_url_points_at_a_real_wiki_page(boards):
    """A docs_url that 404s is worse than none: it sends a buyer nowhere."""
    # Pages live under several doc trees, not just common/: vehicle-specific
    # boards are documented in copter/, plane/, dev/ and so on.
    wiki_root = WIKI_INDEX.parents[3]
    available = {p.stem for p in wiki_root.glob("*/source/docs/*.rst")}
    broken = []
    for b in boards:
        url = b.get("docs_url")
        if not url or "ardupilot.org" not in url:
            continue
        stem = url.rsplit("/", 1)[-1].removesuffix(".html")
        if stem not in available:
            broken.append(f"{b['slug']} -> {stem}")
    assert not broken, "docs_url with no matching wiki page:\n  " + "\n  ".join(broken)
