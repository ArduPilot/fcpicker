"""Summarise what a fresh parser run would change in the committed catalog.

`tools/build.py` rewrites data/boards/*.json in place while preserving the
human-owned `manual` block and the AI-gathered `ai` block. So after running it
against a current ArduPilot checkout, any remaining git diff under data/boards
is *build-derived drift*: either upstream hwdef changed, or our parser did.

That distinction matters. A parser tweak that silently alters 90 boards looks
exactly like a quiet commit until someone notices a spec is wrong — which, for
a catalogue people buy hardware from, is the failure that actually costs
something.

Usage (expects `git` to see the modified working tree):

    python tools/drift_report.py                 # markdown to stdout
    python tools/drift_report.py --fail-on-drift # exit 1 when anything changed

Exit codes: 0 = no drift, 1 = drift found (only with --fail-on-drift), 2 = error.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BOARDS_DIR = REPO_ROOT / "data" / "boards"

# Owned by humans and by the extraction workflow respectively; build.py
# preserves both, so a change in either is not parser drift.
NON_BUILD_KEYS = {"manual", "ai"}


def _git(*args: str) -> str:
    out = subprocess.run(
        ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        print(f"git {' '.join(args)} failed: {out.stderr.strip()}", file=sys.stderr)
        raise SystemExit(2)
    return out.stdout


def committed_version(path: Path) -> dict | None:
    """The board as HEAD has it, or None when the file is newly added."""
    rel = path.relative_to(REPO_ROOT).as_posix()
    out = subprocess.run(
        ["git", "show", f"HEAD:{rel}"], cwd=REPO_ROOT, capture_output=True, text=True
    )
    if out.returncode != 0:
        return None
    return json.loads(out.stdout)


def flatten(obj: object, prefix: str = "") -> dict[str, object]:
    """Flatten nested dicts to dotted paths so fields can be compared one by one."""
    flat: dict[str, object] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            flat.update(flatten(v, f"{prefix}.{k}" if prefix else k))
    else:
        flat[prefix] = obj
    return flat


def build_derived(board: dict) -> dict[str, object]:
    return flatten({k: v for k, v in board.items() if k not in NON_BUILD_KEYS})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fail-on-drift", action="store_true")
    args = ap.parse_args()

    changed = [
        REPO_ROOT / line
        for line in _git("diff", "--name-only", "--", "data/boards").split("\n")
        if line.strip()
    ]
    untracked = [
        REPO_ROOT / line
        for line in _git(
            "ls-files", "--others", "--exclude-standard", "--", "data/boards"
        ).split("\n")
        if line.strip()
    ]
    deleted = [
        REPO_ROOT / line
        for line in _git("diff", "--name-only", "--diff-filter=D", "--", "data/boards").split("\n")
        if line.strip()
    ]

    field_hits: Counter[str] = Counter()
    per_board: dict[str, list[str]] = {}

    for path in changed:
        if path in deleted or not path.exists():
            continue
        after = json.loads(path.read_text())
        before = committed_version(path)
        if before is None:
            continue
        a, b = build_derived(after), build_derived(before)
        diffs = [
            f"{k}: {b.get(k)!r} → {a.get(k)!r}"
            for k in sorted(set(a) | set(b))
            if a.get(k) != b.get(k)
        ]
        if diffs:
            per_board[after["slug"]] = diffs
            for d in diffs:
                field_hits[d.split(":", 1)[0]] += 1

    added = [p.stem for p in untracked if p.suffix == ".json"]
    removed = [p.stem for p in deleted]

    drifted = bool(per_board or added or removed)

    lines: list[str] = []
    if not drifted:
        lines.append("No parser drift: a fresh build reproduces the committed catalog exactly.")
    else:
        lines.append("A fresh parser run would change the committed catalog.\n")
        lines.append(
            "`build.py` preserves the `manual` and `ai` blocks, so everything below is "
            "either an upstream hwdef change or a change in our own parser.\n"
        )
        if added:
            lines.append(f"### {len(added)} new board(s)\n")
            lines += [f"- `{s}`" for s in sorted(added)[:40]]
            lines.append("")
        if removed:
            lines.append(f"### {len(removed)} board(s) would disappear\n")
            lines.append(
                "This is the dangerous one — a parser change that stops recognising a "
                "board looks identical to the board being dropped upstream.\n"
            )
            lines += [f"- `{s}`" for s in sorted(removed)[:40]]
            lines.append("")
        if per_board:
            lines.append(f"### {len(per_board)} board(s) with changed fields\n")
            lines.append("Most-affected fields:\n")
            lines += [f"- `{f}` — {n} board(s)" for f, n in field_hits.most_common(15)]
            lines.append("\n<details><summary>Per-board detail</summary>\n")
            for slug in sorted(per_board)[:60]:
                lines.append(f"**{slug}**")
                lines += [f"  - {d}" for d in per_board[slug][:12]]
            if len(per_board) > 60:
                lines.append(f"\n_…and {len(per_board) - 60} more._")
            lines.append("\n</details>")

    print("\n".join(lines))
    if drifted and args.fail_on_drift:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
