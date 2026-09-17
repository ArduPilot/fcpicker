# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

fcPicker is a **fully static** site backed by an offline build pipeline. There is no server at runtime — Cloudflare Pages just serves the Vite build of `frontend/`.

Data flow:

```
~/ardupilot/.../hwdef/*    tools/build.py     data/boards/<slug>.json    tools/bundle.py    frontend/public/boards.json
  (hwdef.dat / .inc)    ─▶ (Python/SQLAlchemy) ─▶ (one per board,      ─▶ (concat)       ─▶ (committed; fetched by React)
                                                  hand-editable,
                                                  committed)
                                  │
                                  └─▶ data/fcpicker.sqlite (intermediate)
```

Key consequences:

- **`data/boards/<slug>.json` is the source of truth.** Each file has hwdef-derived keys plus a `manual` block that humans / the admin UI own. `tools/build.py` only overwrites its own keys; `manual` is preserved across re-runs, so anything that must survive a re-import belongs there. See `BoardManual` in `frontend/src/types.ts` for the full shape; the fields that carry policy:
  - `manufacturer` — the top-level `manufacturer` is build-derived, so a name written there is erased on the next import. Recovered vendor names go here.
  - `imu_count` — the verified override. `tools/sanity_check.py` fails when the parser reads more IMU chip-selects than ArduPilot can instantiate and no override exists, rather than silently clamping. Three boards legitimately expose a fourth; each records where its count was confirmed.
  - `variants` — retail products sharing one firmware target. ArduPilot ships one hwdef for the MatekH743, but Matek sells the -WING, -SLIM, -MINI and -WLITE against it, and those names appear nowhere else in the data.
  - `documents` — vendor datasheets and manuals, URLs only. Never hosted or proxied.
- **`data/docs_overrides.json`** maps a slug to a corrected `docs_url`, consulted by `build.py` ahead of its fuzzy matcher. Doc matching is the weakest link in the pipeline; this is how a bad match is pinned.
- **`frontend/public/boards.json` is bundled from those files** by `tools/bundle.py`. Committed because Cloudflare's build env does not run Python. The pre-commit hook re-bundles whenever any `data/boards/*.json` is staged.
- The build script is now mostly a **one-shot importer** — run it when ArduPilot adds a new hwdef board, and a new `data/boards/<slug>.json` appears. Existing files keep their `manual` block.
- The schema in `tools/build.py` is intentionally firmware-agnostic (Board / Sensor / FirmwareSupport with a `firmware` discriminator) so PX4 / INAV / Betaflight can be layered in later.
- The pipeline also reads `~/ardupilot_wiki` (cloned separately) to match boards to documentation URLs. Missing wiki dir is fine — boards just won't get `docs_url`.

### `tools/build.py` internals

- `parse_board()` reads `hwdef.dat` + `hwdef.inc` concatenated (fields are split across them) and returns `None` for non-autopilots (peripherals, bootloaders — see `PERIPHERAL_PATTERNS` and `is_autopilot()`). Boards without any IMU line are also dropped.
- Sensor lines (IMU/BARO/COMPASS) can be gated to a hardware revision via `BOARD_MATCH(...)`. The matched token is stored on `Sensor.variant` so the frontend can group sensors by physical board variant.
- Feature detection is regex-based against the concatenated hwdef text. Each peripheral has its own regex constant at module top (`SERIAL_ORDER_RE`, `SPIDEV_RE`, `CAN_PIN_RE`, `IOMCU_RE`, `BRICK_RE`, etc.) — extend those when adding a new peripheral field rather than parsing inside `parse_board`.
- `build_docs_map()` + `match_docs_url()` implement progressively looser slug-to-wiki-page matching (exact → "the"-prefix → substring → token overlap). The four strategies are intentional; tighten thresholds before adding a fifth.

### Frontend

- React 19 + Vite + TypeScript, react-router-dom v7. Routes live in `frontend/src/routes/` (`Layout`, `Selector`, `BoardDetail`).
- The app fetches `/boards.json` on mount; types for the payload are in `frontend/src/types.ts`. Keep these in sync with `export_json()` in `tools/build.py` — they are the contract between the two halves.

## Commands

Run from repo root unless noted.

```bash
# Re-import from hwdef (writes data/fcpicker.sqlite, updates data/boards/*.json,
# preserves manual blocks, re-bundles frontend/public/boards.json)
.venv/bin/python tools/build.py

# Re-bundle per-board JSON files into frontend/public/boards.json
# (run by the pre-commit hook automatically when data/boards/*.json is staged)
.venv/bin/python tools/bundle.py

# Frontend dev / lint / build (root package.json proxies to frontend/)
npm run dev
npm run lint
npm run build

# Cloudflare Pages deploy (uses wrangler.jsonc)
npm run deploy

# Local labeler UI (http://localhost:8765) — review/edit catalog entries,
# manage source URLs, queue AI extraction work
.venv/bin/python tools/labeler/server.py
```

A pre-commit hook in `.githooks/pre-commit` re-bundles, sanity-checks sensor
counts, and runs `npm run lint` + `npm run build`; it's wired up via
`npm run prepare` (`git config core.hooksPath .githooks`).

## Tests

```bash
npm run test          # vitest — unit + component (jsdom)
npm run test:e2e      # playwright — chromium AND firefox, against the built dist/
npm run test:py       # pytest — data, parser, invariants, build/deploy
npm run test:all      # everything
.venv/bin/pytest -m "not slow"   # skip the tests that shell out to npm run build
```

Five layers, each catching what the others structurally cannot:

- **Data integrity** (`tests/test_board_data.py`) — schema shape, slug/filename
  agreement, manual-block completeness, and a bundle-drift check. `boards.json`
  is committed and Cloudflare cannot regenerate it, so a stale one ships silently.
- **Hardware invariants** (`tests/test_invariants.py`) — sensor counts within
  physical bounds, sitemap covering exactly the real routes, a board-count floor.
- **Parser** (`tests/test_parser.py`) — real hwdefs checked into
  `tests/fixtures/hwdef/`, one per parser path (plain board, `-bdshot` fold,
  `BOARD_MATCH` gating, IOMCU, Linux, a peripheral rejected by name, an
  autopilot-named directory with no IMU rejected by content), plus a golden
  snapshot.
- **Wiki coverage** (`tests/test_wiki_coverage.py`) — checks the catalog from the
  wiki side. ArduPilot's autopilot index lists every board page, so a page
  nothing references means a board we never imported or a `docs_url` that failed
  to match. The hwdef-derived tests cannot see that gap by construction.
- **AI/parser agreement** (`tests/test_ai_parser_agreement.py`) — compares the
  extraction pass's independent readings against the parser on every run.
  Computed rather than read from the stored `ai.discrepancies`, which is a
  snapshot and goes stale.

Tests run against the real committed catalog, not fixtures: the failures worth
catching are properties of the actual data.

**Ratchets.** Several tests carry a set of known-bad entries
(`KNOWN_UNREFERENCED`, `KNOWN_UART_DIVERGENCE`, `KNOWN_RAW_IMU_OVERCOUNT`…).
These may shrink, never grow. Adding an entry to make a failure go away defeats
the test — fix the data instead.

CI (`.github/workflows/ci.yml`) runs all three suites on every push and PR.
`.github/workflows/parser-drift.yml` re-runs the parser against upstream weekly
and opens an issue if a fresh build would change the catalog.

## Conventions

- Prereq for the build script: a clone of ArduPilot at `~/ardupilot` (only the `libraries/AP_HAL_ChibiOS/hwdef/` tree is needed) and optionally `~/ardupilot_wiki` for docs links.
- `data/fcpicker.sqlite` is gitignored and recreated from scratch on every build (`db_path.unlink()` at the top of `main()`).

## Labeler + AI extraction workflow

`data/<category>/<slug>.json` has up to three independent namespaces:

- top-level keys + `firmware_support`, `imus`, etc. — **build-derived**, owned by `tools/build*.py`, regenerated from hwdef/driver source on every build.
- **`ai`** block — populated by Claude subagents from vendor pages / docs / forum posts. Preserved across `build.py` re-runs (see `export_per_board`). Never authoritative; always promoted into `manual` before being trusted.
- **`manual`** block — human-curated, source of truth for physical/commercial fields. Preserved across re-runs.

Sibling files:

- `sources/<category>/<slug>.txt` — URL list, one per line, committed. Inputs for extraction.
- `data/_queue/queue.jsonl` — local-only (gitignored) work items written by the labeler UI; each line is `{"action":"find_sources"|"extract","category":...,"slug":...}`.

The loop:

1. Open the labeler (`.venv/bin/python tools/labeler/server.py`, http://localhost:8765).
2. Pick a slug, paste candidate source URLs into the Sources textarea (or click *Queue source discovery* to have Claude search for them).
3. Click *Queue extraction*. The UI appends to `data/_queue/queue.jsonl`.
4. In the Claude Code terminal, say **"drain the queue"** — Claude reads `queue.jsonl`, spawns one subagent per entry (parallel where possible), each subagent reads its sources and writes back to the `ai` block of the slug's JSON, then clears the queue file.
5. Refresh the labeler, review the `ai` block, click *→ manual* to promote individual fields, or edit them by hand. Commit.

## Roadmap

Planned features (not yet implemented):

- **Affiliate links.** Per-board purchase links (Amazon, AliExpress, vendor sites) stored in the `manual` block. Frontend renders them on board/peripheral detail pages.
- **PDF documentation.** Link to vendor-hosted datasheets / manuals (PDF) from the `manual` block — URLs only, no uploads. Avoids hosting untrusted binaries entirely; safest option and keeps vendors as the source of truth.
- **Improved admin panel.** Extend the existing admin workbench (commit `35b3f6b`): better editing UX for the `manual` block, support for the new affiliate / PDF fields, and parity for non-board catalogs (rangefinders, future peripherals).
- **More hardware categories.** Expand beyond flight controllers and rangefinders to additional peripherals (e.g. GPS modules, airspeed sensors, ESCs, telemetry radios, power modules), each following the same `data/<category>/<slug>.json` + bundle pattern.
- **GitHub-auth editing.** Anyone with push access to `ArduPilot/ardupilot` can edit the per-slug JSON files via the admin panel — auth through GitHub OAuth, check ArduPilot push permission, then commit edits as a PR (or direct push) to this repo. Keeps the "JSON in git is the source of truth" model intact.
