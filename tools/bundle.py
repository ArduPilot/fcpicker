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
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BOARDS_DIR = REPO_ROOT / "data" / "boards"
OUT_PATH = REPO_ROOT / "frontend" / "public" / "boards.json"
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
    boards = [json.loads(f.read_text()) for f in sorted(BOARDS_DIR.glob("*.json"))]
    report_manufacturer_coverage(boards)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
