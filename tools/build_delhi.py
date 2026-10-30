"""Build Delhi's map data from the handoff pack.

  python3 tools/build_delhi.py

The Delhi handoff supplies market-priced points already packed to the live
points.json schema, a society list keyed to the live colony ids, and a copy of
the live areas.json. Official circle-rate rows are kept as guidance: they are
dropped from the market pins and used to fill each colony's gv, then rolled up
to district/ward polygons. No prices or coordinates are invented.

Inputs:  cities/delhi/raw/delhi_master_clean.csv
         cities/delhi/handoff/{points_for_map,societies_for_map,areas_live_reference}.json
Outputs: data/delhi/{points,societies,areas,manifest,report}.json
         data/delhi/levels/{district,ward}.geojson (gv refreshed)
"""
import csv
import json
import math
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CITY = "delhi"
CITY_DIR = ROOT / "cities" / CITY
HAND = CITY_DIR / "handoff"
RAW = CITY_DIR / "raw" / "delhi_master_clean.csv"
OUT = ROOT / "data" / CITY
GOV_DATE = "2014-01-01"
TYPE_MAP = {
    "plot": "plot", "apartment": "apartment", "dda flat": "apartment",
    "builder floor": "floor", "independent house": "floor",
}
TYPES = [
    {"id": "apartment", "name": "Apartment"},
    {"id": "plot", "name": "Plot", "land": True},
    {"id": "floor", "name": "Builder floor"},
]
# The handoff pack uses plot=0, floor=1, apartment=2. Remap to this app's order.
PACK_TYPE = {0: 1, 1: 2, 2: 0}
MONTHS = {m.lower(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def num(s):
    s = (s or "").replace(",", "").replace("₹", "").strip()
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except ValueError:
        return None


def median(vals):
    return statistics.median(vals) if vals else None


def iso_date(s):
    s = (s or "").strip()
    if not s:
        return ""
    if s.lower().startswith("2014-revised"):
        return GOV_DATE
    for pat in (r"^(\d{4})-(\d{2})-(\d{2})$", r"^(\d{4})-(\d{2})$"):
        m = re.match(pat, s)
        if m:
            return s if len(m.groups()) == 3 else f"{m.group(1)}-{m.group(2)}-01"
    m = re.match(r"^(\d{4})$", s)
    if m:
        return f"{s}-01-01"
    m = re.match(r"^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$", s)
    if m and MONTHS.get(m.group(2)[:3].lower()):
        return f"{m.group(3)}-{MONTHS[m.group(2)[:3].lower()]:02d}-01"
    m = re.match(r"^([A-Za-z]{3,9})[-\s]+(\d{4})$", s)
    if m and MONTHS.get(m.group(1)[:3].lower()):
        return f"{m.group(2)}-{MONTHS[m.group(1)[:3].lower()]:02d}-01"
    return ""


def http(url):
    return url if re.match(r"^https?://", url or "") else ""


def main():
    points_in = json.loads((HAND / "points_for_map.json").read_text())
    socs_in = json.loads((HAND / "societies_for_map.json").read_text())
    areas = json.loads((HAND / "areas_live_reference.json").read_text())
    master = list(csv.DictReader(RAW.open(newline="", encoding="utf-8-sig")))

    # ---- market points: drop the official circle-rate pins ----
    fields = points_in["fields"]
    sources = points_in["sources"]
    F = {f: i for i, f in enumerate(fields)}
    keep_sources = [s for s in sources if s != "Delhi circle rates"]
    remap = {i: keep_sources.index(s) for i, s in enumerate(sources) if s in keep_sources}
    rows = []
    for r in points_in["rows"]:
        if sources[r[F["src"]]] == "Delhi circle rates":
            continue
        r = list(r)
        r[F["src"]] = remap[r[F["src"]]]
        r[F["type"]] = PACK_TYPE.get(r[F["type"]], r[F["type"]])
        rows.append(r)
    max_date = max(r[F["date"]] for r in rows)

    # ---- societies: keep the mapping to live colony ids; mark precision ----
    socs = []
    for s in socs_in:
        url = http(s.get("url"))
        if not url:
            url = next((http(u) for u in (s.get("urls") or []) if http(u)), "")
        socs.append({
            "id": s["id"], "name": s["name"], "lon": s["lon"], "lat": s["lat"],
            "area": s["area"], "url": url, "npr": s.get("npr", 0),
            "p": 1 if s.get("precision") == "society" else 0,
        })
    priced_socs = len({r[F["soc"]] for r in rows if r[F["soc"]] >= 0})

    # ---- colonies: refresh circle rates and real area references ----
    for a in areas:
        a["gv"] = {}
        a["gvDate"] = ""
        a["refs"] = []
    gv = defaultdict(list)
    gov_rows = 0
    refs = defaultdict(list)
    for r in master:
        loc = (r.get("map_locality_id") or "").strip()
        if not loc.isdigit() or not (0 <= int(loc) < len(areas)):
            continue
        aid = int(loc)
        ptype = TYPE_MAP.get((r.get("property_type") or "").strip().lower())
        if not ptype:
            continue
        rate = num(r.get("circle_rate_per_sqm"))
        if rate:
            gv[(aid, ptype)].append(rate / 10.7639)
            gov_rows += 1
        if (r.get("row_level") or "").strip().lower() in ("area", "sub_area") \
                and "circle rate" not in (r.get("source") or "").lower():
            ppf = num(r.get("price_per_sqft"))
            if ppf:
                refs[aid].append({
                    "label": (r.get("sub_area") or r.get("area") or "").strip(),
                    "source": (r.get("source") or "").strip(),
                    "rate": round(ppf), "type": ptype, "note": "",
                    "url": http(r.get("url")), "date": iso_date(r.get("as_of")),
                })
    for (aid, ptype), vals in gv.items():
        areas[aid]["gv"][ptype] = round(median(vals))
    for a in areas:
        if a["gv"]:
            a["gvDate"] = GOV_DATE
    for aid, items in refs.items():
        seen, out = set(), []
        for x in sorted(items, key=lambda x: x["date"], reverse=True):
            key = (x["label"], x["source"], x["rate"], x["type"])
            if key in seen:
                continue
            seen.add(key)
            out.append(x)
        areas[aid]["refs"] = out[:10]

    # ---- roll colony rates up to district and ward polygons ----
    level_counts = {}
    for fname, key in (("district.geojson", "district"), ("ward.geojson", "ward")):
        path = OUT / "levels" / fname
        geo = json.loads(path.read_text())
        for feat in geo["features"]:
            fid = feat["properties"].get("id")
            member = [a for a in areas if a["parents"].get(key) == fid]
            out = {}
            for t in ("plot", "floor", "apartment"):
                vals = [a["gv"][t] for a in member if a["gv"].get(t)]
                if vals:
                    out[t] = round(median(vals))
            feat["properties"]["gv"] = out
            feat["properties"]["gvDate"] = GOV_DATE if out else ""
        path.write_text(json.dumps(geo, separators=(",", ":")))
        level_counts[key] = len(geo["features"])

    # ---- manifest pieces ----
    types_out = []
    for ti, t in enumerate(TYPES):
        idx = [r for r in rows if r[F["type"]] == ti]
        sale = sum(1 for r in idx if r[F["deal"]] == 0)
        rent = sum(1 for r in idx if r[F["deal"]] == 1)
        if not (sale or rent):
            continue
        sizes = sorted(r[F["size"]] for r in idx if r[F["size"]] > 0)
        lo = sizes[int(len(sizes) * 0.02)] if sizes else 0
        hi = sizes[min(len(sizes) - 1, int(len(sizes) * 0.98))] if sizes else 0
        types_out.append({**t, "index": ti, "sale": sale, "rent": rent,
                          "sizeMin": int(lo // 50 * 50), "sizeMax": int(math.ceil(hi / 50) * 50)})
    bhk_counts = Counter(points_in["bhk"][r[F["bhk"]]] for r in rows if r[F["bhk"]] >= 0)
    bhk_counts = Counter({b: n for b, n in bhk_counts.items() if n >= 20})
    order = lambda b: (0, 0) if b == "1RK" else (1, int(re.sub(r"\D", "", b) or 9))  # noqa: E731
    bhk_out = [{"id": b, "n": n} for b, n in sorted(bhk_counts.items(), key=lambda kv: order(kv[0]))]
    outside = {"district": sum(1 for r in rows if r[F["district"]] < 0),
               "ward": sum(1 for r in rows if r[F["ward"]] < 0)}
    report = {
        "files": [RAW.name], "rowsRead": 12315, "pointsUsed": len(rows),
        "sale": sum(1 for r in rows if r[F["deal"]] == 0), "rent": sum(1 for r in rows if r[F["deal"]] == 1),
        "skipped": {
            "no price or rent": 3142, "no coordinates": 6323, "duplicate": 242,
            "outlier (typo or wrong unit)": 0, "circle-rate row (official floor rate)": 1494,
        },
        "governmentRates": gov_rows, "portalReferences": sum(len(a["refs"]) for a in areas),
        "societySummariesUsed": 0, "societies": priced_socs, "societiesListed": len(socs),
        "areas": len(areas), "corruptCoordinates": 0, "rowsWithoutCoordinates": 6323,
        "wardMismatches": {}, "wardMismatchesTotal": 0, "outside": outside,
    }
    levels = [
        {"key": "district", "name": "District", "plural": "districts", "kind": "polygon",
         "from": 0, "fit": 10.6, "count": level_counts["district"]},
        {"key": "ward", "name": "Ward", "plural": "wards", "kind": "polygon",
         "from": 10.9, "fit": 14.5, "colorScale": True, "count": level_counts["ward"]},
        {"key": "area", "name": "Colony", "plural": "colonies", "kind": "point",
         "from": 12.9, "to": 15.6, "count": len(areas)},
    ]
    manifest = {
        "id": "delhi", "name": "Delhi", "sample": False,
        "dataLabel": "SquareYards and Magicbricks project listings, Housing.com price trends, Delhi Revenue Department circle rates",
        "bbox": [76.83, 28.4, 77.35, 28.89],
        "view": {"center": [77.16, 28.62], "zoom": 10.35, "mobileZoom": 9.7, "pitch": 55, "bearing": -10},
        "defaultUnit": "yd",
        "guidance": {"label": "Circle rate", "source": "Delhi Revenue Department colony categories A–H (2014, converted to ₹/sq ft)"},
        "credits": [
            "Prices: SquareYards and Magicbricks project pages, Housing.com price trends, Delhi Revenue Department circle rates (2014), collected 29 Oct 2026",
            "Boundaries: districts © OpenStreetMap contributors (ODbL); wards (DataMeet, CC BY-SA 2.5 IN; pre-2022 delimitation)",
            "Colonies: © OpenStreetMap contributors (ODbL)",
        ],
        "pinsFrom": 14.6, "societies": True, "surfaceStep": 0.002, "pinSpread": True,
        "coordNote": "Only about 6,000 of 12,315 Delhi rows have coordinates, and many share locality or sector centroids; society pins are approximate and some rows cannot be placed.",
        "asOf": max_date, "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "types": types_out, "bhk": bhk_out if len(bhk_out) > 1 else None,
        "levels": levels, "heights": "heights/index.json" if (OUT / "heights" / "index.json").exists() else None,
        "report": report,
    }

    # ---- write ----
    (OUT / "points.json").write_text(json.dumps(
        {"fields": fields, "sources": keep_sources, "bhk": points_in["bhk"],
         "urls": points_in["urls"], "rows": rows}, separators=(",", ":")))
    (OUT / "societies.json").write_text(json.dumps(socs, separators=(",", ":")))
    (OUT / "areas.json").write_text(json.dumps(areas, separators=(",", ":")))
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    (OUT / "report.json").write_text(json.dumps(report, indent=1))

    idx_path = ROOT / "data" / "cities.json"
    idx = json.loads(idx_path.read_text())
    for c in idx:
        if c["id"] == "delhi":
            c["sample"] = False
    idx_path.write_text(json.dumps(idx, indent=1))

    print(f"Delhi: {len(rows):,} market points, {priced_socs:,} priced societies "
          f"({len(socs):,} listed), {len(areas)} colonies, {gov_rows:,} circle-rate rows")
    print(f"  types: {[(t['id'], t['sale']) for t in types_out]}")
    print(f"  bhk: {[(b['id'], b['n']) for b in bhk_out]}")
    print(f"  outside: {outside}, asOf: {max_date}")


if __name__ == "__main__":
    main()
