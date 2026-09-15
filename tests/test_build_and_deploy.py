"""BUILD and DEPLOY machinery for fcPicker.

Covers two things that have nothing to do with the data pipeline tested
elsewhere in this directory:

1. The frontend build + pre-render step (`npm run build` = `tsc -b && vite
   build && node prerender.mjs`), which must emit one real, non-empty
   `index.html` per route — the site is served by nginx from a plain
   directory, so a route with no file on disk 404s on a deep link.
2. `tools/deploy/fcpicker-deploy.sh`, the cron job that polls upstream and
   publishes a build, and its guards against publishing a broken build.

Several of these tests run a full `npm run build`, which takes well over a
minute. They are marked `@pytest.mark.slow`; run only the fast subset with:

    .venv/bin/python -m pytest tests/test_build_and_deploy.py -m "not slow"

and the whole file (slow tests included) with:

    .venv/bin/python -m pytest tests/test_build_and_deploy.py

The default-base build is session-scoped: tests 1-3 all read the *same*
`frontend/dist` produced by a single `npm run build` invocation, rather than
rebuilding per test. The sub-path build (test 4) rebuilds `frontend/dist` a
second time and then rebuilds it back at the default base afterwards, so the
tree is left the way it started.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = REPO_ROOT / "frontend"
DIST_DIR = FRONTEND_DIR / "dist"
DEPLOY_SCRIPT = REPO_ROOT / "tools" / "deploy" / "fcpicker-deploy.sh"

EMPTY_ROOT_MARKER = '<div id="root"></div>'


def _run_build(env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    """Run `npm run build` from the repo root, the same entry point cron uses."""
    import os

    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    return subprocess.run(
        ["npm", "run", "build"],
        cwd=REPO_ROOT,
        env=full_env,
        capture_output=True,
        text=True,
        timeout=600,
    )


@pytest.fixture(scope="session")
def default_build() -> Path:
    """Run `npm run build` once at the default base path ("/") and hand back
    `frontend/dist` for every test that only needs to read its output.

    Session-scoped and shared by tests 1-3 specifically so the expensive
    build subprocess runs exactly once for this whole file.
    """
    result = _run_build()
    assert result.returncode == 0, (
        f"npm run build failed (default base):\nstdout:\n{result.stdout}\n"
        f"stderr:\n{result.stderr}"
    )
    return DIST_DIR


def _board_slugs() -> list[str]:
    import json

    payload = json.loads((FRONTEND_DIR / "public" / "boards.json").read_text())
    return [b["slug"] for b in payload["boards"]]


def _rangefinder_ids() -> list[str]:
    import json

    payload = json.loads((FRONTEND_DIR / "public" / "rangefinders.json").read_text())
    return [f"{r['kind']}-{r['slug']}" for r in payload["rangefinders"]]


@pytest.mark.slow
def test_prerender_emits_a_page_per_route(default_build: Path):
    dist = default_build
    slugs = _board_slugs()
    rf_ids = _rangefinder_ids()

    assert (dist / "index.html").is_file(), "no dist/index.html"
    assert (dist / "rangefinders" / "index.html").is_file(), "no dist/rangefinders/index.html"

    missing_boards = [s for s in slugs if not (dist / "board" / s / "index.html").is_file()]
    assert not missing_boards, f"missing board pages: {missing_boards[:10]}"

    missing_rf = [r for r in rf_ids if not (dist / "rangefinder" / r / "index.html").is_file()]
    assert not missing_rf, f"missing rangefinder pages: {missing_rf[:10]}"

    total_pages = len(list(dist.rglob("index.html")))
    expected = len(slugs) + len(rf_ids) + 2  # + "/" and "/rangefinders"
    assert total_pages == expected, (
        f"expected {expected} index.html files ({len(slugs)} boards + "
        f"{len(rf_ids)} rangefinders + 2), found {total_pages}"
    )


@pytest.mark.slow
def test_prerendered_pages_contain_real_content(default_build: Path):
    page = default_build / "board" / "MatekH743" / "index.html"
    assert page.is_file(), "dist/board/MatekH743/index.html missing"
    html = page.read_text()

    # An empty pre-rendered shell is ~800 bytes (just the template with an
    # empty #root div); real content pushes a board page well past that. If
    # this ever drops back near 800 bytes, the pre-render step ran but
    # silently rendered nothing for this route.
    assert len(html) > 5000, (
        f"MatekH743 page is only {len(html)} bytes — looks like an empty "
        "shell, not a rendered page (a real page is tens of KB)"
    )
    assert "MatekH743" in html, "board slug/name not found in its own page"
    assert "Retail versions" in html, (
        "'Retail versions' section not found — MatekH743 has manual.variants "
        "in data/boards/MatekH743.json, so this section should render"
    )


@pytest.mark.slow
def test_no_page_is_an_empty_shell(default_build: Path):
    """No emitted HTML file may still carry the empty-root marker.

    This is the guard that a single route silently failing to render (while
    every other route succeeds, so the build as a whole "passes") can't slip
    through into a published build.
    """
    offenders = [
        str(f.relative_to(default_build))
        for f in default_build.rglob("index.html")
        if EMPTY_ROOT_MARKER in f.read_text()
    ]
    assert not offenders, f"pages still containing an empty #root div: {offenders[:10]}"


@pytest.mark.slow
def test_base_path_rewrites_asset_urls(default_build: Path):
    """BASE_PATH must drive both Vite's asset URLs and the emitted internal
    links, since the site can be served either at the domain root or under
    ardupilot.org/fcpicker/.
    """
    # `default_build` establishes ordering (runs after tests 1-3, all reading
    # the default-base dist) even though this test rebuilds dist itself.
    del default_build

    try:
        result = _run_build(env={"BASE_PATH": "/fcpicker/"})
        assert result.returncode == 0, (
            f"npm run build failed (BASE_PATH=/fcpicker/):\nstdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )

        index_html = (DIST_DIR / "index.html").read_text()
        assert re.search(r'/fcpicker/assets/[^"\'\s]+', index_html), (
            "dist/index.html has no /fcpicker/assets/... reference"
        )
        assert "/fcpicker/favicon.svg" in index_html, (
            "dist/index.html does not reference /fcpicker/favicon.svg"
        )

        slug = _board_slugs()[0]
        board_html = (DIST_DIR / "board" / slug / "index.html").read_text()
        board_links = re.findall(r'href="(/[^"]*board/[^"]*)"', board_html)
        assert board_links, f"no board links found in {slug} page to check"
        bad_links = [l for l in board_links if not l.startswith("/fcpicker/board/")]
        assert not bad_links, (
            f"board page internal links not rewritten under /fcpicker/: {bad_links[:10]}"
        )
    finally:
        # Leave the tree built at the default base path, not the sub-path
        # used only for this test.
        restore = _run_build()
        assert restore.returncode == 0, (
            "failed to rebuild at the default base path after the "
            f"BASE_PATH=/fcpicker/ test:\nstdout:\n{restore.stdout}\n"
            f"stderr:\n{restore.stderr}"
        )


def test_deploy_script_is_valid_shell():
    result = subprocess.run(
        ["bash", "-n", str(DEPLOY_SCRIPT)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"bash -n failed:\n{result.stderr}"


def test_deploy_script_checks_dependencies_before_locking():
    """The `for cmd in ...` dependency check must appear before `flock` is
    used.

    If flock itself is missing, `flock -n 9` fails exactly the same way as
    "another run holds the lock" does (nonzero exit), so without an explicit
    dependency check first, a host missing flock would make cron silently
    skip every single tick forever instead of raising a clear error.
    """
    # Drop comment lines first: the script's own comment explaining this
    # ordering mentions "flock -n 9" in prose, which would otherwise be
    # mistaken for the real invocation below.
    code_lines = [
        line for line in DEPLOY_SCRIPT.read_text().splitlines()
        if not line.strip().startswith("#")
    ]
    text = "\n".join(code_lines)

    dep_check_match = re.search(r"for\s+cmd\s+in\b.*?done", text, re.DOTALL)
    assert dep_check_match, "no `for cmd in ...; do ... done` dependency-check loop found"

    flock_match = re.search(r"\bflock\s+-n\b", text)
    assert flock_match, "no `flock -n` call found"

    assert dep_check_match.start() < flock_match.start(), (
        "dependency-check loop must appear before the flock call, otherwise "
        "a missing flock binary looks identical to 'lock already held' and "
        "cron skips silently forever"
    )
    # The dependency loop should be the thing verifying flock is present.
    assert "flock" in dep_check_match.group(0), (
        "dependency-check loop does not verify flock is installed"
    )


def test_deploy_script_guards_against_publishing_a_shell():
    """The script must abort (via `die`), not merely warn, on either guard:
    a too-small index.html (pre-render didn't run) or too few pages built.
    """
    text = DEPLOY_SCRIPT.read_text()

    size_check = re.search(
        r"wc -c\s*<\"?\$DIST/index\.html\"?.*?-lt\s*\d+.*?die\s",
        text,
        re.DOTALL,
    )
    assert size_check, "no size-check-then-die on index.html found"

    count_check = re.search(
        r"page_count.*?-ge\s*\d+.*?die\s",
        text,
        re.DOTALL,
    )
    assert count_check, "no page-count-check-then-die found"


def test_deploy_script_never_targets_a_personal_fork():
    """Safety property: the cron job must publish only what has landed on
    ArduPilot's own upstream repo, never a personal fork — a fork could
    contain unreviewed changes that would then get served to real users.
    """
    text = DEPLOY_SCRIPT.read_text()

    match = re.search(r'^REPO_URL="([^"]+)"', text, re.MULTILINE)
    assert match, "no REPO_URL assignment found in the deploy script"

    repo_url = match.group(1)
    assert "ArduPilot/fcpicker" in repo_url, (
        f"REPO_URL does not point at ArduPilot/fcpicker: {repo_url!r}"
    )
    assert "freddygaffey" not in repo_url.lower(), (
        f"REPO_URL appears to point at a personal fork: {repo_url!r}"
    )
