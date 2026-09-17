"""Check every outbound link in the catalog and report the dead ones.

Vendor links rot faster than anything else here. Over one working session:
mrobotics.io stopped resolving and now redirects to store.3dr.com, several
Matek product pages returned 404, three of the H743 family's pages are marked
EOL, and Flywoo sits behind a challenge that refuses automated requests
entirely. A dead link on a spec page is worse than no link — it sends someone
choosing hardware nowhere.

Checked in one pass rather than per-source because the failure is the same
whichever field it lives in:

    board.docs_url               ArduPilot wiki page
    board.repo_url               hwdef README / directory on GitHub
    manual.ardupilot_repo_url    vendor or repo link
    manual.documents[].url       vendor datasheets and manuals
    manufacturers[].website      vendor home page
    manufacturers[].store_url    direct store
    manufacturers[].distributors_url  reseller list

Some hosts refuse HEAD, so a failed HEAD is retried as a ranged GET before
being called dead. Sites that block automation outright (403/429 from a WAF)
are reported separately from genuine 404s — the first needs a human to look,
the second needs the link fixing.

    python tools/link_check.py                  # human-readable
    python tools/link_check.py --markdown       # for a GitHub issue
    python tools/link_check.py --only manufacturers
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BOARDS_DIR = REPO_ROOT / "data" / "boards"
REGISTRY = REPO_ROOT / "data" / "manufacturers.json"

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TIMEOUT = 20
# A WAF turning us away says nothing about whether the link works for a person.
BLOCKED_CODES = {401, 403, 405, 503}

# GitHub rate-limits unauthenticated requests hard, and a throttled run reports
# 429s and even sporadic 404s for files that are plainly there — which makes
# every GitHub verdict worthless. Requests to these hosts are serialised behind
# a lock with a delay, and a 429 is retried rather than believed.
THROTTLED_HOSTS = ("github.com", "raw.githubusercontent.com")
THROTTLE_DELAY = 1.2
_throttle_lock = threading.Lock()


def collect() -> list[tuple[str, str, str]]:
    """(url, kind, owner) for everything worth checking."""
    out: list[tuple[str, str, str]] = []
    for f in sorted(BOARDS_DIR.glob("*.json")):
        b = json.loads(f.read_text())
        slug = b["slug"]
        for key in ("docs_url", "repo_url"):
            if b.get(key):
                out.append((b[key], key, slug))
        manual = b.get("manual") or {}
        if manual.get("ardupilot_repo_url"):
            out.append((manual["ardupilot_repo_url"], "manual.ardupilot_repo_url", slug))
        for doc in manual.get("documents") or []:
            if doc.get("url"):
                out.append((doc["url"], f"document ({doc.get('kind', '?')})", slug))

    if REGISTRY.exists():
        for e in json.loads(REGISTRY.read_text())["manufacturers"]:
            for key in ("website", "store_url", "distributors_url"):
                if e.get(key):
                    out.append((e[key], f"manufacturer.{key}", e["id"]))

    # One check per distinct URL; the owners are merged in the report.
    seen: dict[str, tuple[str, str, str]] = {}
    for url, kind, owner in out:
        seen.setdefault(url, (url, kind, owner))
    return list(seen.values())


def _is_throttled(url: str) -> bool:
    return any(h in url.split("/")[2] for h in THROTTLED_HOSTS if len(url.split("/")) > 2)


def probe(url: str) -> tuple[int | None, str | None]:
    """(status, error). HEAD first, then a ranged GET for hosts that refuse it.

    The error string is the real cause, not the exception class. "URLError"
    told us nothing; "certificate has expired" is a vendor whose site shows a
    browser security warning, which is worth an email, while "unable to get
    local issuer certificate" is only an incomplete chain that most browsers
    paper over. Those want different responses and must not look alike.
    """
    if _is_throttled(url):
        # Serialise and pace: concurrent unauthenticated requests are what
        # produced the false 404s in the first place.
        with _throttle_lock:
            time.sleep(THROTTLE_DELAY)
            status, err = _request(url)
            if status == 429:
                time.sleep(5)
                status, err = _request(url)
            if status == 429:
                return None, "rate limited (inconclusive)"
            return status, err
    return _request(url)


def _request(url: str) -> tuple[int | None, str | None]:
    for method in ("HEAD", "GET"):
        req = urllib.request.Request(url, method=method, headers={
            "User-Agent": UA,
            "Accept": "*/*",
            **({"Range": "bytes=0-2048"} if method == "GET" else {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.status, None
        except urllib.error.HTTPError as e:
            if method == "HEAD" and e.code in {400, 403, 405, 501}:
                continue  # host dislikes HEAD; try GET before judging
            return e.code, None
        except Exception as e:  # DNS, TLS, timeout, redirect loop
            if method == "HEAD":
                continue
            return None, _explain(e)
    return None, "unreachable"


def _explain(exc: Exception) -> str:
    """A short, actionable reason rather than the exception class name."""
    text = str(exc)
    for needle, reason in (
        ("certificate has expired", "TLS: certificate expired"),
        ("unable to get local issuer", "TLS: incomplete chain"),
        ("self-signed certificate", "TLS: self-signed"),
        ("certificate verify failed", "TLS: verify failed"),
        ("Name or service not known", "DNS: no such host"),
        ("nodename nor servname", "DNS: no such host"),
        ("timed out", "timeout"),
        ("Connection refused", "connection refused"),
    ):
        if needle in text:
            return reason
    return f"{type(exc).__name__}: {text[:60]}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--markdown", action="store_true")
    ap.add_argument("--only", help="substring filter on the kind, e.g. 'manufacturer'")
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    targets = collect()
    if args.only:
        targets = [t for t in targets if args.only in t[1]]
    if not targets:
        print("nothing to check", file=sys.stderr)
        return 2

    dead: list[tuple[str, str, str, str]] = []
    blocked: list[tuple[str, str, str, str]] = []
    tls: list[tuple[str, str, str, str]] = []
    ok = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(probe, url): (url, kind, owner) for url, kind, owner in targets}
        for fut in concurrent.futures.as_completed(futures):
            url, kind, owner = futures[fut]
            status, err = fut.result()
            if status and 200 <= status < 400:
                ok += 1
            elif status in BLOCKED_CODES:
                blocked.append((owner, kind, url, f"HTTP {status}"))
            elif err == "rate limited (inconclusive)":
                # Not a verdict either way; reporting it as dead would be a lie.
                blocked.append((owner, kind, url, err))
            elif err and err.startswith("TLS:"):
                # The page is there; the certificate is the problem. That is the
                # vendor's to fix and shows users a security warning, so it is
                # neither a dead link nor something we can route around.
                tls.append((owner, kind, url, err))
            else:
                dead.append((owner, kind, url, err or f"HTTP {status}"))

    if args.markdown:
        print(f"Checked **{len(targets)}** links: {ok} OK, "
              f"**{len(dead)} dead**, {len(tls)} with TLS problems, "
              f"{len(blocked)} blocked by the host.\n")
        if dead:
            print("### Dead links\n")
            by_kind: dict[str, list] = defaultdict(list)
            for owner, kind, url, why in sorted(dead):
                by_kind[kind].append((owner, url, why))
            for kind, rows in sorted(by_kind.items()):
                print(f"**{kind}**\n")
                for owner, url, why in rows:
                    print(f"- `{owner}` — {why} — {url}")
                print()
        if tls:
            print("### Certificate problems\n")
            print("The page exists but the certificate does not validate. "
                  "An expired certificate shows visitors a browser security "
                  "warning; an incomplete chain usually does not.\n")
            for owner, kind, url, why in sorted(tls):
                print(f"- `{owner}` ({kind}) — {why} — {url}")
            print()
        if blocked:
            print("<details><summary>Blocked by the host "
                  f"({len(blocked)}) — usually a WAF, not a broken link</summary>\n")
            for owner, kind, url, why in sorted(blocked):
                print(f"- `{owner}` ({kind}) — {why} — {url}")
            print("\n</details>")
    else:
        print(f"Checked {len(targets)} links: {ok} OK, {len(dead)} dead, "
              f"{len(tls)} TLS problems, {len(blocked)} blocked by the host.\n")
        for owner, kind, url, why in sorted(tls):
            print(f"  TLS     {owner:28} {kind:26} {why:26} {url}")
        for owner, kind, url, why in sorted(dead):
            print(f"  DEAD    {owner:28} {kind:26} {why:12} {url}")
        for owner, kind, url, why in sorted(blocked):
            print(f"  blocked {owner:28} {kind:26} {why:12} {url}")

    # Dead links are reported, not fatal: third-party uptime must not fail CI.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
