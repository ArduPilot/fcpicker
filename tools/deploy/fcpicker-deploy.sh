#!/usr/bin/env bash
#
# Poll ArduPilot/fcpicker and publish a new static build when main moves.
#
# Intended to run from cron every 5 minutes on the web host. It watches the
# UPSTREAM repo (ArduPilot), not a personal fork, so only what has landed
# upstream is ever served.
#
# Design notes:
#   * Detection is `git ls-remote`, which is a single cheap request and is not
#     subject to the GitHub API's unauthenticated rate limit (60/hour would be
#     tight at this interval, and needs no token).
#   * The build happens in a staging directory. The live directory is only
#     touched once a build has fully succeeded, so a failed or half-finished
#     build can never take the site down.
#   * flock prevents a slow build from overlapping the next tick.
#   * cron runs with a minimal PATH; node/npm are located explicitly below.
#
# Install:
#   sudo install -m 755 fcpicker-deploy.sh /usr/local/bin/fcpicker-deploy
#   crontab -e
#     */5 * * * * /usr/local/bin/fcpicker-deploy >> /var/log/fcpicker-deploy.log 2>&1
#
# First run clones and builds; later runs exit in well under a second when
# upstream has not moved.

set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────
REPO_URL="https://github.com/ArduPilot/fcpicker.git"
BRANCH="main"

# Where the built site is served from. This is the hard-coded target.
PUBLISH_DIR="/var/www/ardupilot.org/fcpicker"

# Sub-path the site is served under. Must match the nginx location and end
# with a slash. Use "/" if it is served at the domain root.
BASE_PATH="/fcpicker/"

# Working area: the checkout, the staging build and the state file.
WORK_DIR="/var/lib/fcpicker-deploy"

# node/npm are not on cron's PATH by default. Point NODE_BIN at the directory
# holding them (`dirname "$(command -v npm)"` in an interactive shell).
NODE_BIN="/usr/local/bin"
# ─────────────────────────────────────────────────────────────────────────────

export PATH="$NODE_BIN:$PATH"

CHECKOUT="$WORK_DIR/repo"
STAGING="$WORK_DIR/staging"
STATE_FILE="$WORK_DIR/deployed.sha"
LOCK_FILE="$WORK_DIR/deploy.lock"

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

mkdir -p "$WORK_DIR"

# Check tooling before anything else. In particular flock must be verified
# here rather than relied on below: if it is missing, `flock -n 9` fails and
# is indistinguishable from "another run holds the lock", which would make
# cron skip silently forever.
for cmd in git npm rsync flock; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found in PATH ($PATH)"
done

# Only one deploy at a time. A build that outlives the 5-minute tick must not
# be joined by a second one; skipping quietly is the right response.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another deploy is still running; skipping this tick"
  exit 0
fi

# ── Has upstream moved? ──────────────────────────────────────────────────────
remote_sha="$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | awk '{print $1}')"
[ -n "$remote_sha" ] || die "could not read $BRANCH from $REPO_URL"

deployed_sha=""
[ -f "$STATE_FILE" ] && deployed_sha="$(cat "$STATE_FILE")"

if [ "$remote_sha" = "$deployed_sha" ]; then
  # Quiet on the common path so the log stays readable.
  exit 0
fi

prev_desc="none"
[ -n "$deployed_sha" ] && prev_desc="${deployed_sha:0:12}"
log "upstream $BRANCH is ${remote_sha:0:12} (deployed: $prev_desc); building"

# ── Fetch ────────────────────────────────────────────────────────────────────
if [ -d "$CHECKOUT/.git" ]; then
  git -C "$CHECKOUT" remote set-url origin "$REPO_URL"
  git -C "$CHECKOUT" fetch --depth 1 origin "$BRANCH" --quiet
  git -C "$CHECKOUT" checkout --quiet --force FETCH_HEAD
  git -C "$CHECKOUT" clean -qfdx -e node_modules
else
  rm -rf "$CHECKOUT"
  git clone --depth 1 --branch "$BRANCH" --quiet "$REPO_URL" "$CHECKOUT"
fi

built_sha="$(git -C "$CHECKOUT" rev-parse HEAD)"

# ── Build ────────────────────────────────────────────────────────────────────
# The repo commits frontend/public/*.json, so no Python is needed here — the
# data pipeline runs on a maintainer's machine, not on the web host.
log "building $built_sha at base $BASE_PATH"
(
  cd "$CHECKOUT/frontend"
  npm ci --no-audit --no-fund --silent
  BASE_PATH="$BASE_PATH" npm run build --silent
) || die "build failed; leaving the live site untouched"

DIST="$CHECKOUT/frontend/dist"
[ -f "$DIST/index.html" ] || die "build produced no index.html"

# A trivially small index.html means pre-rendering silently did not run, which
# would publish empty shells over a working site.
if [ "$(wc -c <"$DIST/index.html")" -lt 4096 ]; then
  die "index.html is only $(wc -c <"$DIST/index.html") bytes — the pre-render step did not run.
       An SPA shell cannot be served from a directory: deep links have no file to resolve to.
       This build is being rejected rather than published over a working site."
fi
page_count="$(find "$DIST" -name index.html | wc -l | tr -d ' ')"
[ "$page_count" -ge 100 ] || die "only $page_count pages built; refusing to publish"

# ── Publish ──────────────────────────────────────────────────────────────────
# Stage first, then sync into place, so the live directory is only ever
# updated from a complete build.
rm -rf "$STAGING"
mkdir -p "$STAGING"
cp -R "$DIST/." "$STAGING/"

mkdir -p "$PUBLISH_DIR"
rsync -a --delete "$STAGING/" "$PUBLISH_DIR/"
rm -rf "$STAGING"

printf '%s\n' "$built_sha" >"$STATE_FILE"
log "published $built_sha — $page_count pages to $PUBLISH_DIR"
