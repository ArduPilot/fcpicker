"""Shared fixtures for the data-pipeline tests.

These run against the real committed catalog, not synthetic data. The failures
worth catching — a board with 15 barometers, a manufacturer that loses its
alias, a slug that stops matching its filename — are properties of the actual
322 files, and a fixture-sized mock would pass while the site was wrong.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "tools"))

BOARDS_DIR = REPO_ROOT / "data" / "boards"
RANGEFINDERS_DIR = REPO_ROOT / "data" / "rangefinders"
PUBLIC_DIR = REPO_ROOT / "frontend" / "public"


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return REPO_ROOT


@pytest.fixture(scope="session")
def board_files() -> list[Path]:
    files = sorted(BOARDS_DIR.glob("*.json"))
    assert files, f"no board files under {BOARDS_DIR}"
    return files


@pytest.fixture(scope="session")
def boards(board_files: list[Path]) -> list[dict]:
    return [json.loads(f.read_text()) for f in board_files]


@pytest.fixture(scope="session")
def boards_by_slug(boards: list[dict]) -> dict[str, dict]:
    return {b["slug"]: b for b in boards}


@pytest.fixture(scope="session")
def registry() -> list[dict]:
    path = REPO_ROOT / "data" / "manufacturers.json"
    return json.loads(path.read_text())["manufacturers"]


@pytest.fixture(scope="session")
def bundled_boards() -> list[dict]:
    return json.loads((PUBLIC_DIR / "boards.json").read_text())["boards"]
