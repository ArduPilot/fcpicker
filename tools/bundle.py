"""Bundle per-board JSON files into the single boards.json the frontend fetches.

Source:  data/boards/<slug>.json   (one file per board, hand-editable, committed)
Output:  frontend/public/boards.json

Also copies the manufacturer registry (data/manufacturers.json) into
frontend/public/, and reports which manufacturer spellings in the board files
have no registry entry — those boards get no purchase link.

Run directly (`python tools/bundle.py`) or import `bundle()`. The pre-commit
hook runs this whenever data/boards/* changes are staged.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BOARDS_DIR = REPO_ROOT / "data" / "boards"
OUT_PATH = REPO_ROOT / "frontend" / "public" / "boards.json"
RANGEFINDERS_DIR = REPO_ROOT / "data" / "rangefinders"
RF_OUT = REPO_ROOT / "frontend" / "public" / "rangefinders.json"
SITEMAP_OUT = REPO_ROOT / "frontend" / "public" / "sitemap.xml"
# Must match SITE_BASE_URL in tools/build.py.
SITE_BASE_URL = "https://fcpicker.pebnum.com"
MFR_SRC = REPO_ROOT / "data" / "manufacturers.json"
MFR_OUT = REPO_ROOT / "frontend" / "public" / "manufacturers.json"


def manufacturer_key(raw: str | None) -> str:
    """Normalise a free-text manufacturer string to an alias lookup key.

    Must stay in sync with manufacturerKey() in frontend/src/data.ts.
    """
    return re.sub(r"[^a-z0-9]+", " ", (raw or "").lower()).strip()


def bundle_manufacturers(src: Path = MFR_SRC, out_path: Path = MFR_OUT) -> int:
    """Copy the manufacturer registry into the frontend's public dir."""
    if not src.exists():
        print(f"warning: no manufacturer registry at {src}", file=sys.stderr)
        return 0
    payload = json.loads(src.read_text())
    entries = payload["manufacturers"]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"manufacturers": entries}, indent=2, ensure_ascii=False) + "\n")
    return len(entries)


def report_manufacturer_coverage(boards: list[dict], src: Path = MFR_SRC) -> None:
    """Print which manufacturer spellings have no registry entry.

    Advisory only — an unmapped manufacturer just means no purchase link.
    """
    if not src.exists():
        return
    alias_to_id: dict[str, str] = {}
    for e in json.loads(src.read_text())["manufacturers"]:
        for a in e["aliases"]:
            alias_to_id[a] = e["id"]

    unmapped: dict[str, int] = {}
    linked = blank = 0
    for b in boards:
        # manual.manufacturer wins: the top-level key is build-derived and is
        # still always null out of hwdef.
        raw = (b.get("manual") or {}).get("manufacturer") or b.get("manufacturer")
        key = manufacturer_key(raw)
        if not key:
            blank += 1
        elif key in alias_to_id:
            linked += 1
        else:
            unmapped[raw] = unmapped.get(raw, 0) + 1

    total = len(boards)
    print(f"  manufacturers: {linked}/{total} boards linked, "
          f"{blank} with no manufacturer, {sum(unmapped.values())} unmapped")
    if unmapped:
        top = sorted(unmapped.items(), key=lambda kv: -kv[1])[:10]
        shown = ", ".join(f"{n}x {m}" for m, n in top)
        more = f", +{len(unmapped) - len(top)} more" if len(unmapped) > len(top) else ""
        print(f"  unmapped: {shown}{more}")


def write_sitemap(out_path: Path = SITEMAP_OUT) -> int:
    """Write sitemap.xml covering every public route.

    Lives here rather than in build.py because build.py needs an ArduPilot
    checkout to run at all, so the sitemap only regenerated on a full import
    and drifted whenever boards changed through the bundler alone. It also
    omitted the rangefinder catalog entirely — 45 pages that were pre-rendered,
    linked and served, but advertised to nobody.
    """
    from datetime import date
    from xml.sax.saxutils import escape as xml_escape

    today = date.today().isoformat()
    boards = sorted(
        (json.loads(f.read_text())["slug"] for f in BOARDS_DIR.glob("*.json")),
        key=str.lower,
    )
    # Only advertise what frontend/prerender.mjs actually emits. Listing a URL
    # that has no file behind it is worse than omitting it: nginx serves a 404
    # to a crawler we invited. Keep this in step with INCLUDE_RANGEFINDERS.
    include_rangefinders = os.environ.get("INCLUDE_RANGEFINDERS") == "1"
    rangefinders = []
    if include_rangefinders and RF_OUT.exists():
        for rf in json.loads(RF_OUT.read_text())["rangefinders"]:
            # Route is /rangefinder/<kind>-<slug>; see routes/Rangefinders.tsx.
            rangefinders.append(f"{rf['kind']}-{rf['slug']}")
    rangefinders.sort(key=str.lower)

    def url(loc: str, freq: str, priority: str) -> str:
        return (f"  <url><loc>{SITE_BASE_URL}{loc}</loc><lastmod>{today}</lastmod>"
                f"<changefreq>{freq}</changefreq><priority>{priority}</priority></url>")

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
             url("/", "weekly", "1.0")]
    if rangefinders:
        lines.append(url("/rangefinders", "weekly", "0.9"))
    lines += [url(f"/board/{xml_escape(s)}", "monthly", "0.7") for s in boards]
    lines += [url(f"/rangefinder/{xml_escape(s)}", "monthly", "0.6") for s in rangefinders]
    lines.append("</urlset>\n")
    out_path.write_text("\n".join(lines))
    return len(lines) - 3  # minus the two header lines and the closing tag


def bundle(boards_dir: Path = BOARDS_DIR, out_path: Path = OUT_PATH) -> int:
    files = sorted(boards_dir.glob("*.json"))
    payload = [json.loads(f.read_text()) for f in files]
    payload.sort(key=lambda b: b["slug"].lower())
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"boards": payload}, indent=2) + "\n")
    return len(payload)


def main() -> int:
    if not BOARDS_DIR.exists():
        print(f"No board dir at {BOARDS_DIR}", file=sys.stderr)
        return 1
    n = bundle()
    print(f"Bundled {n} boards → {OUT_PATH.relative_to(REPO_ROOT)}")

    m = bundle_manufacturers()
    if m:
        print(f"Bundled {m} manufacturers → {MFR_OUT.relative_to(REPO_ROOT)}")
    urls = write_sitemap()
    print(f"Wrote {urls} URLs → {SITEMAP_OUT.relative_to(REPO_ROOT)}")

    boards = [json.loads(f.read_text()) for f in sorted(BOARDS_DIR.glob("*.json"))]
    report_manufacturer_coverage(boards)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
