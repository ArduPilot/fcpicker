"""Detect ArduPilot hwdef board directories that fcPicker does not yet carry.

Reuses `build.parse_board` so the filter is identical to the real import
pipeline: peripherals, bootloaders, and dirs without a usable autopilot hwdef
(no MCU / no IMU) return None and are ignored — only directories that would
actually produce a `data/boards/<slug>.json` count as "new".

Usage:
    python tools/check_new_boards.py <hwdef-dir> [<hwdef-dir> ...] [--out new_boards.json]

Each <hwdef-dir> is a checkout of an ArduPilot hwdef tree — pass the
AP_HAL_ChibiOS/hwdef and (optionally) AP_HAL_Linux/hwdef dirs. The includes
between board dirs mean the whole subtree must be present, not just one board.

Writes a JSON array of {slug, mcu, flash_kb} for each new board to --out
(default new_boards.json) and prints a human summary to stdout. Exit status is
always 0 unless arguments are wrong — "no new boards" is a normal result.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# build.py lives alongside this script; importing it only pulls in sqlalchemy
# (all filesystem work is guarded behind its __main__ block).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
BOARDS_DIR = REPO_ROOT / "data" / "boards"


def known_slugs() -> set[str]:
    return {p.stem for p in BOARDS_DIR.glob("*.json")}


def find_new_boards(hwdef_dirs: list[Path]) -> list[dict]:
    known = known_slugs()
    new: list[dict] = []
    seen: set[str] = set()
    for hwdef_dir in hwdef_dirs:
        # "linux" if this is the AP_HAL_Linux tree, else "chibios" — only
        # affects the labelled MCU/platform, not whether a dir counts as a board.
        platform = "linux" if "AP_HAL_Linux" in hwdef_dir.parts else "chibios"
        for board_dir in sorted(p for p in hwdef_dir.iterdir() if p.is_dir()):
            slug = board_dir.name
            if slug in known or slug in seen:
                continue
            # "<slug>-bdshot" is folded into its base board by build.py, so it
            # is never its own catalog entry (see merge_bdshot_targets).
            if slug.endswith("-bdshot") and (hwdef_dir / slug[: -len("-bdshot")]).is_dir():
                continue
            try:
                parsed = build.parse_board(board_dir, platform=platform)
            except Exception as exc:  # a malformed upstream hwdef shouldn't fail the run
                print(f"  ! skipped {slug}: parse error: {exc}", file=sys.stderr)
                continue
            if parsed is None:
                continue  # peripheral / bootloader / no autopilot hwdef
            seen.add(slug)
            new.append(
                {
                    "slug": slug,
                    "platform": platform,
                    "mcu": parsed.mcu_part or parsed.mcu_family or ("Linux" if platform == "linux" else "unknown"),
                    "flash_kb": parsed.flash_kb,
                }
            )
    return new


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("hwdef_dir", type=Path, nargs="+",
                    help="one or more hwdef trees (AP_HAL_ChibiOS/hwdef, AP_HAL_Linux/hwdef)")
    ap.add_argument("--out", type=Path, default=Path("new_boards.json"))
    args = ap.parse_args()

    missing = [d for d in args.hwdef_dir if not d.is_dir()]
    if missing:
        print(f"error: not a directory: {', '.join(map(str, missing))}", file=sys.stderr)
        return 2

    new = find_new_boards(args.hwdef_dir)
    args.out.write_text(json.dumps(new, indent=2) + "\n")

    if not new:
        print("No new boards. fcPicker is up to date with upstream hwdef.")
    else:
        print(f"{len(new)} new board(s) upstream not yet in fcPicker:")
        for b in new:
            print(f"  - {b['slug']}  [{b['platform']}] ({b['mcu']}, {b['flash_kb']} KB flash)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
