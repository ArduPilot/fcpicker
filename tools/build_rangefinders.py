"""Build script for fcPicker rangefinder catalog.

Parses ArduPilot's AP_RangeFinder (unidirectional, single-beam) and
AP_Proximity (omnidirectional, scanning) libraries to produce a
per-device JSON catalog with bus / protocol / tech classification and
best-effort range/weight scraped from the wiki.

Source of truth:    ~/ardupilot/libraries/AP_RangeFinder, AP_Proximity
Wiki:               ~/ardupilot_wiki/common/source/docs/common-*.rst
Output:             data/rangefinders/<slug>.json   (committed, manual block preserved)
                    frontend/public/rangefinders.json   (bundled)

Usage:
    python tools/build_rangefinders.py
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Reuse the wiki-matching machinery from build.py.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import (  # noqa: E402
    ARDUPILOT_WIKI_DOCS, build_docs_map, match_docs_url, _doc_url, _norm,
)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data" / "rangefinders"
OUT_BUNDLE = ROOT / "frontend" / "public" / "rangefinders.json"
AP_RF_DIR = Path.home() / "ardupilot" / "libraries" / "AP_RangeFinder"
AP_PRX_DIR = Path.home() / "ardupilot" / "libraries" / "AP_Proximity"

ENUM_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,", re.MULTILINE)
CLASS_RE = re.compile(
    r"^class\s+(AP_(?:RangeFinder|Proximity)_[A-Za-z0-9_]+)\s*:\s*public\s+([A-Za-z0-9_]+)",
    re.MULTILINE,
)

# Tech classification from filename / enum keywords. First matching keyword wins.
TECH_KEYWORDS: list[tuple[str, str]] = [
    ("radar", "radar"),
    ("hexsoon", "radar"),
    ("nra24", "radar"),
    ("rds02", "radar"),
    ("ainstein", "radar"),
    ("mr72", "radar"),
    ("hcsr04", "ultrasonic"),
    ("hc_sr04", "ultrasonic"),
    ("maxsonar", "ultrasonic"),
    ("maxbotix", "ultrasonic"),
    ("gyus42", "ultrasonic"),
    ("usd1", "radar"),  # uLanding USD1 is radar
    ("nmea", "sonar"),   # NMEA is for marine depth sonar
    ("blping", "sonar"),
    ("lowrance", "sonar"),
    ("hondex", "sonar"),
    ("kogger", "sonar"),
    ("vl53l", "tof"),
    ("tofsense", "tof"),
    ("nooploop", "tof"),
    ("cygbot", "tof"),
    ("rplidar", "lidar"),
    ("ld06", "lidar"),
    ("ld19", "lidar"),
    ("teraranger", "lidar"),
    ("leddar", "lidar"),
    ("lightware", "lidar"),
    ("lidar", "lidar"),
    ("benewake", "lidar"),
    ("lanbao", "lidar"),
    ("wasp", "lidar"),
    ("jre", "lidar"),
    ("dts6012", "lidar"),
    ("bebop", "ultrasonic"),  # Parrot Bebop's downward sonar
    ("pulsedlight", "lidar"),
    ("lrf", "lidar"),
    ("mavlink", "external"),
    ("msp", "external"),
    ("lua", "scripted"),
    ("scripting", "scripted"),
    ("sitl", "simulated"),
    ("airsim", "simulated"),
    ("bbb_pru", "ultrasonic"),  # BeagleBone PRU bit-bangs HC-SR04 ultrasonics
]

# Range / weight regexes — best-effort against the wiki intro prose.
RANGE_PATTERNS = [
    re.compile(r"range of\s+([\d.]+)\s*m\b", re.I),
    re.compile(r"\b([\d.]+)\s*m(?:eter)?\s+range\b", re.I),
    re.compile(r"\b([\d.]+)\s*-\s*([\d.]+)\s*m\b", re.I),
    re.compile(r"up to\s+([\d.]+)\s*m\b", re.I),
    re.compile(r"maximum range[^.]*?([\d.]+)\s*m\b", re.I),
]
WEIGHT_RE = re.compile(r"weigh(?:s|ing)?\s+([\d.]+)\s*g\b", re.I)
WEIGHT_RE2 = re.compile(r"\b([\d.]+)\s*g(?:ram)?s?\s+(?:weight|in weight)\b", re.I)
FOV_RE = re.compile(r"\b(360|270|180|120|90|60|45|30|15|8|4)\s*(?:°|degree|deg)\b", re.I)


@dataclass
class Driver:
    kind: str                 # "rangefinder" (unidirectional) | "proximity" (omnidirectional)
    slug: str                 # filename stem minus library prefix, lowercased
    class_name: str           # e.g. "AP_RangeFinder_Benewake_TFMini"
    display_name: str         # human label e.g. "Benewake TFMini"
    base_class: str | None = None
    bus: str | None = None    # serial | i2c | can | dronecan | analog | pwm | mavlink | msp | scripted | other
    tech: str | None = None   # lidar | sonar | ultrasonic | radar | tof | external | scripted | simulated
    type_ids: list[tuple[str, int]] = field(default_factory=list)  # enum_name → RNGFND/PRX param value
    docs_url: str | None = None
    range_min_m: float | None = None
    range_max_m: float | None = None
    weight_g: float | None = None
    fov_deg: int | None = None


BUS_BY_BASE = {
    "AP_RangeFinder_Backend_Serial": "serial",
    "AP_RangeFinder_Backend_I2C": "i2c",
    "AP_RangeFinder_Backend_CAN": "can",
    "AP_RangeFinder_DroneCAN": "dronecan",
    "AP_RangeFinder_analog": "analog",
    "AP_RangeFinder_PWM": "pwm",
    "AP_RangeFinder_MAVLink": "mavlink",
    "AP_RangeFinder_MSP": "msp",
    "AP_RangeFinder_Lua": "scripted",
    "AP_RangeFinder_HC_SR04": "gpio",
    "AP_RangeFinder_Bebop": "platform",
    "AP_RangeFinder_BBB_PRU": "platform",
    "AP_RangeFinder_PulsedLightLRF": "i2c",
    "AP_RangeFinder_SITL": "simulated",
    "AP_Proximity_Backend_Serial": "serial",
    "AP_Proximity_DroneCAN": "dronecan",
    "AP_Proximity_MAV": "mavlink",
    "AP_Proximity_RangeFinder": "derived",
    "AP_Proximity_Scripting": "scripted",
    "AP_Proximity_SITL": "simulated",
    "AP_Proximity_AirSimSITL": "simulated",
    "AP_Proximity_MR72_CAN": "can",
}


def build_class_graph(lib_dir: Path) -> dict[str, str]:
    """{ derived_class : direct_base_class } for every class in the library."""
    graph: dict[str, str] = {}
    for h in lib_dir.glob("*.h"):
        text = h.read_text(errors="ignore")
        for m in CLASS_RE.finditer(text):
            graph[m.group(1)] = m.group(2)
    return graph


def resolve_bus(class_name: str, graph: dict[str, str]) -> tuple[str | None, str | None]:
    """Walk inheritance until we hit a class with a known bus mapping."""
    seen: set[str] = set()
    current: str | None = class_name
    while current and current not in seen:
        seen.add(current)
        if current in BUS_BY_BASE:
            return BUS_BY_BASE[current], current
        current = graph.get(current)
    return None, None


def parse_enum(header: Path) -> list[tuple[str, int]]:
    """Extract `Name = N,` from the first `enum class Type { ... }` block."""
    text = header.read_text(errors="ignore")
    start = text.find("enum class Type")
    if start < 0:
        return []
    open_brace = text.find("{", start)
    if open_brace < 0:
        return []
    depth = 1
    i = open_brace + 1
    while i < len(text) and depth > 0:
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
        i += 1
    block = text[open_brace + 1: i - 1]
    return [(m.group(1), int(m.group(2))) for m in ENUM_RE.finditer(block)
            if m.group(1) != "NONE" and m.group(1) != "None"]


def classify_tech(slug: str) -> str | None:
    s = slug.lower()
    for needle, tech in TECH_KEYWORDS:
        if needle in s:
            return tech
    return None


def humanize(class_name: str, prefix: str) -> str:
    """`AP_RangeFinder_Benewake_TFMini` → `Benewake TFMini`."""
    s = class_name[len(prefix):] if class_name.startswith(prefix) else class_name
    s = s.replace("_", " ")
    return re.sub(r"\s+", " ", s).strip()


def discover_drivers(lib_dir: Path, kind: str, class_prefix: str) -> list[Driver]:
    graph = build_class_graph(lib_dir)
    # Any class that is a base of another class in this library is abstract for
    # our purposes (e.g. AP_RangeFinder_Benewake parents TF02/TF03/TFmini).
    abstract_bases = set(graph.values())
    drivers: dict[str, Driver] = {}
    for cls in graph:
        if cls.endswith("_Backend") or cls.endswith("_Backend_Serial") \
           or cls.endswith("_Backend_I2C") or cls.endswith("_Backend_CAN"):
            continue
        if cls in abstract_bases:
            continue
        if not cls.startswith(class_prefix):
            continue
        slug = _norm(cls[len(class_prefix):])
        # These are bus/protocol bridges, not specific devices:
        #   analog/pwm  → any voltage- or pulse-width-driven sensor
        #   mavlink/msp → distance fed in over a protocol from another system
        #   dronecan    → generic DroneCAN distance message (vendor-agnostic)
        #   lua/scripting → user-supplied driver
        #   sitl/airsim → simulator
        #   rangefinder (proximity-only) → wraps the AP_RangeFinder library
        if not slug or slug in {
            "analog", "pwm", "mavlink", "msp", "lua", "dronecan",
            "scripting", "sitl", "airsimsitl", "rangefinder", "mav",
        }:
            continue
        bus, base = resolve_bus(cls, graph)
        drivers[cls] = Driver(
            kind=kind,
            slug=slug,
            class_name=cls,
            display_name=humanize(cls, class_prefix),
            base_class=base,
            bus=bus,
            tech=classify_tech(cls),
        )
    return list(drivers.values())


# --- wiki scraping ---------------------------------------------------------

# Map driver normalized-slug → wiki page filename hints (extra ones the
# fuzzy matcher won't find on its own).
SLUG_TO_WIKI_HINT = {
    "benewaketfmini": "common-benewake-tfmini-lidar",
    "benewaketfminiplus": "common-benewake-tfmini-lidar",
    "benewaketf02": "common-benewake-tf02-lidar",
    "benewaketf03": "common-benewake-tf03-lidar",
    "benewakecan": "common-benewake-can-lidar",
    "lightwareserial": "common-lightware-lidar",
    "lightwarei2c": "common-lightware-lidar",
    "lightwaregrf": "common-lightware-grf250-lidar",
    "leddarone": "common-leddar-one-lidar",
    "leddarvu8": "common-leddartech-leddarvu8-lidar",
    "vl53l0x": "common-vl53l0x-lidar",
    "vl53l1xshort": "common-vl53l1x-lidar",
    "pulsedlightlrf": "common-rangefinder-lidarlite",
    "hcsr04": "common-rangefinder-hcsr04",
    "gyus42v2": "common-rangefinder-gy-us42",
    "wasp": "common-wasp200-lidar",
    "ainsteinlrd1": "common-ainstein-lr-d1-radar",
    "hexsoonradar": "common-rangefinder-hexsoon-radar",
    "nra24can": "common-rangefinder-nra24",
    "rds02uf": "common-rangefinder-rds02uf-radar",
    "noopl​oop": "common-rangefinder-nooploop-tofsense-f",
    "nooploop": "common-rangefinder-nooploop-tofsense-f",
    "tofsensefi2c": "common-rangefinder-nooploop-tofsense-f",
    "tofsensepcan": "common-rangefinder-nooploop-tofsense-p",
    "jreserial": "common-rangefinder-jae-jre-30",
    "dts6012m": "common-rangefinder-dts6012m",
    "blping": "common-bluerobotics-ping-sonar",
    "lanbao": "common-lanbao-psk-cm8jl65-distance-sensor",
    "maxsonari2cxl": "common-rangefinder-maxbotixi2c",
    "maxsonarseriallv": "common-rangefinder-maxbotix-analog",
    "teraserial": "common-teraranger-one-rangefinder",
    "terarangeri2c": "common-teraranger-one-rangefinder",
    "terarangerserial": "common-teraranger-one-rangefinder",
    # Proximity-only:
    "rplidara2": "common-rplidar-a2",
    "ld06": "common-ld06-lidar",
    "mr72can": "common-rangefinder-mr72",
    "mr72": "common-rangefinder-mr72",
    "sf40c": "common-lightware-sf40c-lidar",
    "sf45b": "common-lightware-sf45-lidar",
    "cygbotd1": "common-cygbot-d1-tof",
    "teratower": "common-teraranger-tower",
    "teratowerevo": "common-teraranger-tower-evo",
}


def docs_for(slug: str, docs_map) -> str | None:
    """Try hint table, then exact stem, then fuzzy."""
    hint = SLUG_TO_WIKI_HINT.get(slug)
    if hint:
        # Verify file actually exists; if not, fall through to fuzzy.
        p = ARDUPILOT_WIKI_DOCS / f"{hint}.rst"
        if p.exists():
            return _doc_url(hint, "copter")
    return match_docs_url(slug, docs_map)


def scrape_wiki_specs(url: str | None) -> tuple[float | None, float | None, float | None, int | None]:
    """Return (range_min_m, range_max_m, weight_g, fov_deg) by best-effort
    regex over the local wiki source for the matched doc."""
    if not url:
        return None, None, None, None
    # url is .../<platform>/docs/<stem>.html
    m = re.search(r"/docs/([^/]+?)\.html$", url)
    if not m:
        return None, None, None, None
    stem = m.group(1)
    p = ARDUPILOT_WIKI_DOCS / f"{stem}.rst"
    if not p.exists():
        # try platform dirs — skip; common-* dominates.
        return None, None, None, None
    text = p.read_text(errors="ignore")
    # Find the page title (first heading-text line followed by `===` underline)
    # and the first section heading after it. Intro is the slice between them.
    title = re.search(r"\n[A-Za-z][^\n]{0,120}\n={3,}\n", text)
    start = title.end() if title else 0
    next_heading = re.search(r"\n[A-Za-z][^\n]{0,120}\n[-=~^]{3,}\n", text[start:])
    end = start + next_heading.start() if next_heading else min(len(text), start + 2000)
    intro = text[start:end]

    rmin = rmax = None
    for pat in RANGE_PATTERNS:
        m = pat.search(intro)
        if not m:
            continue
        if m.lastindex and m.lastindex >= 2:
            rmin = float(m.group(1))
            rmax = float(m.group(2))
        else:
            rmax = float(m.group(1))
        break

    wm = WEIGHT_RE.search(intro) or WEIGHT_RE2.search(intro)
    weight = float(wm.group(1)) if wm else None

    fm = FOV_RE.search(intro)
    fov = int(fm.group(1)) if fm else None

    return rmin, rmax, weight, fov


# --- output ----------------------------------------------------------------

MANUAL_TEMPLATE = {
    "status": "not_started",
    "manufacturer": None,
    "product_url": None,
    "accuracy_cm": None,
    "update_rate_hz": None,
    "min_voltage_v": None,
    "max_voltage_v": None,
    "current_ma": None,
    "weight_g_override": None,
    "range_min_m_override": None,
    "range_max_m_override": None,
    "fov_deg_override": None,
    "notes": None,
}

GENERATED_KEYS = {
    "slug", "kind", "directionality", "display_name", "class_name",
    "bus", "tech", "type_ids", "docs_url",
    "wiki_range_min_m", "wiki_range_max_m", "wiki_weight_g", "wiki_fov_deg",
}


def driver_payload(d: Driver) -> dict:
    return {
        "slug": d.slug,
        "kind": d.kind,
        "directionality": "omnidirectional" if d.kind == "proximity" else "unidirectional",
        "display_name": d.display_name,
        "class_name": d.class_name,
        "bus": d.bus,
        "tech": d.tech,
        "type_ids": [{"enum": n, "param_value": v} for n, v in d.type_ids],
        "docs_url": d.docs_url,
        "wiki_range_min_m": d.range_min_m,
        "wiki_range_max_m": d.range_max_m,
        "wiki_weight_g": d.weight_g,
        "wiki_fov_deg": d.fov_deg,
    }


def export_per_driver(drivers: list[Driver], out_dir: Path) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for d in drivers:
        # Slug collisions across kinds (rangefinder + proximity) are possible
        # — namespace the file so both survive.
        path = out_dir / f"{d.kind}-{d.slug}.json"
        manual = dict(MANUAL_TEMPLATE)
        ai_block: dict | None = None
        if path.exists():
            try:
                existing = json.loads(path.read_text())
                if isinstance(existing.get("manual"), dict):
                    manual = {**MANUAL_TEMPLATE, **existing["manual"]}
                if isinstance(existing.get("ai"), dict):
                    ai_block = existing["ai"]
            except json.JSONDecodeError:
                pass
        payload = driver_payload(d)
        payload["manual"] = manual
        if ai_block is not None:
            payload["ai"] = ai_block
        path.write_text(json.dumps(payload, indent=2) + "\n")
        written += 1
    return written


def bundle_drivers(in_dir: Path, out_path: Path) -> int:
    files = sorted(in_dir.glob("*.json"))
    payload = [json.loads(f.read_text()) for f in files]
    payload.sort(key=lambda r: (r["kind"], r["slug"]))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"rangefinders": payload}, indent=2) + "\n")
    return len(payload)


# --- enum → driver matching ------------------------------------------------

# ArduPilot abbreviates some enum names past the point where they share any
# substring with the driver's own class name, so the substring match below
# silently finds nothing and the device ends up with no type_ids at all — which
# is the one field a user actually needs, since it is what RNGFNDx_TYPE gets
# set to. These are the abbreviations, mapped by hand.
ENUM_ALIASES: dict[str, str] = {
    # RangeFinder
    "MBI2C": "maxsonari2cxl",        # MaxBotix I2C
    "MBSER": "maxsonarseriallv",     # MaxBotix serial
    "PLI2C": "pulsedlightlrf",       # PulsedLight / LIDAR-Lite
    "PLI2CV3": "pulsedlightlrf",
    "PLI2CV3HP": "pulsedlightlrf",
    "LWI2C": "lightwarei2c",
    "LWSER": "lightwareserial",
    "TRI2C": "terarangeri2c",
    "LightWare_GRF_I2C": "lightwaregrf",
    # Proximity
    "TRTOWER": "terarangertower",
    "TRTOWEREVO": "terarangertowerevo",
}


def attach_enum_ids(drivers: list[Driver], enum: list[tuple[str, int]]) -> None:
    """Attach RNGFND/PRX type IDs to drivers.

    Exact slug match, then the hand-written alias table, then a normalised
    substring match. The aliases come before the substring pass because a
    fuzzy match on an abbreviation is as likely to hit the wrong driver as the
    right one.
    """
    norm_to_drivers = {d.slug: d for d in drivers}
    for name, val in enum:
        key = _norm(name)
        target = norm_to_drivers.get(key)
        if not target and name in ENUM_ALIASES:
            target = norm_to_drivers.get(ENUM_ALIASES[name])
        if not target:
            # Substring search both directions.
            candidates = [d for k, d in norm_to_drivers.items() if k in key or key in k]
            # Prefer longest-overlap match.
            candidates.sort(key=lambda d: -len(d.slug))
            target = candidates[0] if candidates else None
        if target:
            target.type_ids.append((name, val))


def main() -> int:
    if not AP_RF_DIR.exists() or not AP_PRX_DIR.exists():
        print("ArduPilot AP_RangeFinder / AP_Proximity dirs not found", file=sys.stderr)
        return 1

    drivers = (
        discover_drivers(AP_RF_DIR, kind="rangefinder", class_prefix="AP_RangeFinder_")
        + discover_drivers(AP_PRX_DIR, kind="proximity", class_prefix="AP_Proximity_")
    )

    rf_enum = parse_enum(AP_RF_DIR / "AP_RangeFinder.h")
    prx_enum = parse_enum(AP_PRX_DIR / "AP_Proximity.h")
    attach_enum_ids([d for d in drivers if d.kind == "rangefinder"], rf_enum)
    attach_enum_ids([d for d in drivers if d.kind == "proximity"], prx_enum)

    docs_map = build_docs_map()
    for d in drivers:
        d.docs_url = docs_for(d.slug, docs_map)
        d.range_min_m, d.range_max_m, d.weight_g, d.fov_deg = scrape_wiki_specs(d.docs_url)

    n = export_per_driver(drivers, DATA_DIR)
    bundle_drivers(DATA_DIR, OUT_BUNDLE)

    matched_docs = sum(1 for d in drivers if d.docs_url)
    matched_range = sum(1 for d in drivers if d.range_max_m)
    matched_type = sum(1 for d in drivers if d.type_ids)
    unidirectional = sum(1 for d in drivers if d.kind == "rangefinder")
    omnidirectional = sum(1 for d in drivers if d.kind == "proximity")

    print(f"Discovered {n} drivers "
          f"({unidirectional} unidirectional, {omnidirectional} omnidirectional)")
    print(f"  type_id assigned: {matched_type}/{n}")
    print(f"  wiki docs matched: {matched_docs}/{n}")
    print(f"  wiki range scraped: {matched_range}/{n}")
    print(f"  bundle: {OUT_BUNDLE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
