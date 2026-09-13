"""Flag which manufacturers are ArduPilot Corporate Partners.

Source: common/source/docs/common-partners.rst in the ardupilot_wiki clone —
the page behind https://ardupilot.org/copter/docs/common-partners.html. Each
partner is a logo image whose filename carries the company name, plus a
:target: URL.

Matching is by registered domain first (a company's name is spelled several
ways, its domain is not), then by normalised name, then by an explicit
override for the handful whose logo filename resembles nothing (Darkmatter's
logo is "thedarkmatter", SparkNavi's is "xiang").

Writes `ardupilot_partner` onto every entry in data/manufacturers.json.
Re-run after pulling ardupilot_wiki:

    .venv/bin/python tools/partners.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parent.parent
REGISTRY = REPO_ROOT / "data" / "manufacturers.json"
PARTNERS_RST = Path.home() / "ardupilot_wiki/common/source/docs/common-partners.rst"

# Logo filenames that resemble nothing like the company name. Each was
# confirmed by fetching the URL and reading the page title.
NAME_OVERRIDES = {"darkmatter": "thedarkmatter", "sparknavi": "xiang"}

PARTNER_RE = re.compile(
    r"image::\s*\S*?supporters_logo_([A-Za-z0-9_\-.]+?)\.(?:png|jpg|jpeg|gif|svg)"
    r"(?:.|\n)*?:target:\s*(\S+)"
)
# Two-level public suffixes we care about, so "foo.co.uk" isn't cut to "co.uk".
TWO_LEVEL = {"co", "com", "org", "net"}


def registered_domain(url: str | None) -> str | None:
    if not url or url == "nan":
        return None
    host = urlparse(url if "//" in url else "https://" + url).netloc.lower()
    host = re.sub(r"^www\.", "", host)
    parts = host.split(".")
    if len(parts) > 2 and parts[-2] in TWO_LEVEL and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else None


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


def parse_partners(path: Path) -> dict[str, str]:
    """{logo name: target URL}, first occurrence wins."""
    text = path.read_text(errors="ignore")
    out: dict[str, str] = {}
    for name, url in PARTNER_RE.findall(text):
        out.setdefault(name.replace("_", " ").strip(), url)
    return out


def main() -> int:
    if not PARTNERS_RST.exists():
        print(f"No partners page at {PARTNERS_RST} — is ardupilot_wiki cloned?",
              file=sys.stderr)
        return 1

    partners = parse_partners(PARTNERS_RST)
    by_domain: dict[str, str] = {}
    by_name: dict[str, str] = {}
    for name, url in partners.items():
        dom = registered_domain(url)
        if dom:
            by_domain.setdefault(dom, name)
        by_name[norm(name)] = name

    payload = json.loads(REGISTRY.read_text())
    matched: list[str] = []
    for e in payload["manufacturers"]:
        hit = None
        for url in (e.get("website"), e.get("store_url"), e.get("distributors_url")):
            dom = registered_domain(url)
            if dom and dom in by_domain:
                hit = by_domain[dom]
                break
        if not hit:
            for a in e["aliases"] + [norm(e["name"])]:
                if a in by_name:
                    hit = by_name[a]
                    break
        if not hit:
            override = NAME_OVERRIDES.get(e["id"])
            if override and norm(override) in by_name:
                hit = override
        e["ardupilot_partner"] = bool(hit)
        if hit:
            matched.append(e["name"])

    REGISTRY.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(partners)} partners on the wiki page; "
          f"{len(matched)} matched to registry companies:")
    print("  " + ", ".join(sorted(matched)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
