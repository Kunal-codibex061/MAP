"""Turn a city's CSV files into the data the map loads.

  python3 tools/ingest.py mumbai          (or bengaluru, delhi, or any city with a cities/<city>/city.json)

Reads every CSV in cities/<city>/raw/ (all batches are merged), cleans the rows and
writes data/<city>/. Prints a report of what was used and what was skipped, and why.
Needs only Python 3, nothing to install.

CSV format: the columns of the Mumbai v2 / Bengaluru masters. Column names are matched
loosely (see ALIASES), so a file with e.g. "ward" instead of "bmc_ward" or "society_name"
instead of "society_or_layout" still works, and missing optional columns are fine. Required per data row: coordinates (lat/lon), a
property type, and a price (price_per_sqft, or total price + size) or a monthly rent + size.

How rows are used
  row_level config/unit/listing  -> one data point (sale and/or rent)
  row_level society              -> a society summary; used only if that society has no unit rows
  row_level area/sub_area        -> with a ready-reckoner/circle rate: the area's government rate;
                                    otherwise a portal reference (e.g. Housing.com area average)
"""
import csv
import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SQM_PER_SQFT = 10.7639

ALIASES = {
    "city": ["city"],
    "region": ["region", "zone", "district"],
    "ward": ["bmc_ward", "ward", "mcd_ward", "bbmp_ward", "ward_name"],
    "area": ["area", "locality", "colony"],
    "sub_area": ["sub_area", "sublocality", "sub_locality"],
    "society": ["society_or_layout", "society_name", "society", "project", "layout", "building"],
    "row_level": ["row_level", "level", "row_type"],
    "type": ["property_type", "type"],
    "source": ["source"],
    "bhk": ["bhk", "configuration"],
    "size_min": ["area_sqft_min", "size_sqft_min", "area_sqft", "size_sqft"],
    "size_max": ["area_sqft_max", "size_sqft_max"],
    "area_type": ["area_type", "size_type"],
    "price_min": ["total_price_min", "price_min", "total_price", "price"],
    "price_max": ["total_price_max", "price_max"],
    "ppsf": ["price_per_sqft", "rate_per_sqft"],
    "ppsy": ["price_per_sqyd", "rate_per_sqyd"],
    "rent_min": ["rent_monthly_min", "rent_monthly", "rent"],
    "rent_max": ["rent_monthly_max"],
    "gov_sqm": ["ready_reckoner_rate_per_sqm", "circle_rate_per_sqm", "guidance_rate_per_sqm"],
    "as_of": ["as_of", "date", "listed_on"],
    "url": ["url", "link", "source_url"],
    "notes": ["notes", "note"],
    "lat": ["lat", "latitude"],
    "lon": ["lon", "lng", "long", "longitude"],
    "precision": ["geo_precision"],
}
TYPE_WORDS = {
    "apartment": "apartment", "apartments": "apartment", "flat": "apartment", "flats": "apartment",
    "plot": "plot", "land": "plot", "site": "plot", "residential plot": "plot",
    "builder floor": "floor", "builder_floor": "floor", "independent floor": "floor", "floor": "floor",
    "villa": "house", "independent house": "house", "house": "house",
}
UNIT_LEVELS = {"", "config", "unit", "listing", "transaction", "deal"}
GOV_WORDS = ("ready reckoner", "circle rate", "guidance", "igr", "asr", "kaveri")


# ---------- small helpers ----------
def num(s):
    s = (s or "").replace(",", "").replace("₹", "").strip()
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except ValueError:
        return None


def norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


MONTHS = {m.lower(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def iso_date(s):
    """Normalize the date formats the feeds use. Period start, so annual/quarterly
    values do not look newer than they are."""
    s = (s or "").strip()
    if not s:
        return ""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        return s
    m = re.match(r"^(\d{4})-(\d{2})$", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-01"
    m = re.match(r"^(\d{4})$", s)
    if m:
        return f"{s}-01-01"
    m = re.match(r"^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$", s)
    if m:
        mon = MONTHS.get(m.group(2)[:3].lower())
        if mon:
            return f"{m.group(3)}-{mon:02d}-01"
    m = re.match(r"^([A-Za-z]{3,9})\s*[-–]\s*([A-Za-z]{3,9})\s+(\d{4})$", s)
    if m:
        mon = MONTHS.get(m.group(1)[:3].lower())
        if mon:
            return f"{m.group(3)}-{mon:02d}-01"
    m = re.match(r"^([A-Za-z]{3,9})[-\s]+(\d{4})$", s)
    if m:
        mon = MONTHS.get(m.group(1)[:3].lower())
        if mon:
            return f"{m.group(2)}-{mon:02d}-01"
    return ""


def norm_bhk(s):
    """Collapse the 30+ BHK spellings in the feeds to '2BHK', '3BHK', '1RK'.
    Multi-configuration strings such as '2,3' keep the first number (lossy)."""
    v = norm(s).upper().replace(" ", "")
    v = v.replace("\\U003E", ">").replace("&GT;", ">")
    if not v or v in {"APARTMENT", "FLAT", "PLOT"}:
        return ""
    if v in {"STUDIO", "1RK"}:
        return "1RK"
    m = re.search(r"\d+", v)
    if not m:
        return ""
    n = int(m.group())
    return f"{n}BHK" if 0 < n <= 20 else ""


def code_norm(s):
    return norm(s).replace("ward ", "").replace(" ", "")


def mid(a, b):
    vals = [v for v in (a, b) if v]
    return sum(vals) / len(vals) if vals else None


def median(vals):
    return statistics.median(vals) if vals else None


def dist_km(lat1, lon1, lat2, lon2):
    dx = (lon2 - lon1) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, (lat2 - lat1) * 110.57)


def polys_of(geom):
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_geom(x, y, geom):
    return any(in_ring(x, y, p[0]) and not any(in_ring(x, y, h) for h in p[1:]) for p in polys_of(geom))


def ring_area(r):
    return abs(sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1))) / 2


def label_point(geom):
    ring = max((p[0] for p in polys_of(geom)), key=ring_area)
    a = cx = cy = 0.0
    for i in range(len(ring) - 1):
        f = ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
        a += f
        cx += (ring[i][0] + ring[i + 1][0]) * f
        cy += (ring[i][1] + ring[i + 1][1]) * f
    if abs(a) > 1e-12:
        cx, cy = cx / (3 * a), cy / (3 * a)
        if in_geom(cx, cy, geom):
            return cx, cy
    # Fall back to the middle of a horizontal line through the polygon.
    ys = sorted(p[1] for p in ring)
    y = ys[len(ys) // 2]
    xs = []
    for i in range(len(ring) - 1):
        (x1, y1), (x2, y2) = ring[i], ring[i + 1]
        if (y1 > y) != (y2 > y):
            xs.append(x1 + (y - y1) * (x2 - x1) / (y2 - y1))
    xs.sort()
    if len(xs) >= 2:
        return (xs[0] + xs[1]) / 2, y
    return ring[0][0], ring[0][1]


def bbox_of(geom):
    pts = [p for poly in polys_of(geom) for p in poly[0]]
    return min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)


class PolyLevel:
    def __init__(self, cfg, path):
        self.cfg = cfg
        self.features = json.loads(path.read_text())["features"]
        self.bboxes = [bbox_of(f["geometry"]) for f in self.features]
        self.by_code = {code_norm(f["properties"].get("code") or f["properties"]["name"]): i
                        for i, f in enumerate(self.features)}

    def find(self, x, y):
        for i, (x0, y0, x1, y1) in enumerate(self.bboxes):
            if x0 <= x <= x1 and y0 <= y <= y1 and in_geom(x, y, self.features[i]["geometry"]):
                return i
        return -1


def r5(v):
    return round(v, 5)


# ---------- main ----------
def main(city_id):
    cdir = ROOT / "cities" / city_id
    city = json.loads((cdir / "city.json").read_text())
    out = ROOT / "data" / city_id
    (out / "levels").mkdir(parents=True, exist_ok=True)
    W, S, E, N = city["bbox"]
    type_ids = [t["id"] for t in city["types"]]
    poly_levels = [lv for lv in city["levels"] if lv["kind"] == "polygon"]
    point_level = next((lv for lv in city["levels"] if lv["kind"] == "point"), None)
    P = {lv["key"]: PolyLevel(lv, cdir / "boundaries" / lv["file"]) for lv in poly_levels}

    files = sorted((cdir / "raw").glob("*.csv"))
    if not files:
        raise SystemExit(f"No CSV files in {cdir / 'raw'}")

    rep = Counter()
    skipped = Counter()
    units, summaries, gov_rows, ref_rows = [], [], [], []
    no_price_by_soc = Counter()
    soc_geo = {}          # every society with coordinates, priced or not
    sources, urls, bhks = [], [], []

    def intern(lst, v):
        if v in lst:
            return lst.index(v)
        lst.append(v)
        return len(lst) - 1

    for path in files:
        with path.open(newline="", encoding="utf-8-sig") as fh:
            reader = csv.DictReader(fh)
            header = {norm(h).replace(" ", "_"): h for h in reader.fieldnames or []}
            colmap = {}
            for key, names in ALIASES.items():
                for n in names:
                    if n in header:
                        colmap[key] = header[n]
                        break
            for row in reader:
                rep["rows_read"] += 1
                g = lambda k: (row.get(colmap[k]) or "").strip() if k in colmap else ""  # noqa: E731
                level = norm(g("row_level"))
                ptype = TYPE_WORDS.get(norm(g("type")))
                lat, lon = num(g("lat")), num(g("lon"))
                rec = {
                    "file": path.name, "type": ptype, "lat": lat, "lon": lon,
                    "area": g("area"), "sub_area": g("sub_area"), "society": g("society"),
                    "ward_csv": g("ward"), "source": g("source") or "Unknown source",
                    "bhk": norm_bhk(g("bhk")), "url": g("url"), "date": iso_date(g("as_of")),
                    "notes": g("notes"), "level": level, "prec": norm(g("precision")),
                }
                if lat is not None and lon is not None:
                    if abs(lat) > 90 or abs(lon) > 180:
                        skipped["corrupt coordinates (out of range)"] += 1
                        continue
                    if abs(lat - lon) < 1e-9:
                        skipped["corrupt coordinates (lat = lon)"] += 1
                        continue
                    if not (W <= lon <= E and S <= lat <= N):
                        if W <= lat <= E and S <= lon <= N:
                            skipped["corrupt coordinates (swapped)"] += 1
                            continue
                        if not (W - 1 <= lon <= E + 1 and S - 1 <= lat <= N + 1):
                            skipped["corrupt coordinates (implausible for city)"] += 1
                            continue
                if level in ("area", "sub_area", "locality"):
                    gov = num(g("gov_sqm"))
                    is_gov = gov is not None or any(w in rec["source"].lower() for w in GOV_WORDS)
                    rate = gov / SQM_PER_SQFT if gov else num(g("ppsf"))
                    if not rate or not ptype:
                        skipped["area row without a usable rate"] += 1
                        continue
                    rec["rate"] = rate
                    (gov_rows if is_gov else ref_rows).append(rec)
                    continue
                if not ptype or ptype not in type_ids:
                    skipped[f"property type not used for {city['name']} ({g('type') or 'blank'})"] += 1
                    continue
                if lat is None or lon is None:
                    skipped["no coordinates"] += 1
                    continue
                if not (W <= lon <= E and S <= lat <= N):
                    skipped["coordinates outside the city"] += 1
                    continue
                if rec["society"]:
                    key = (norm(rec["society"]), norm(rec["area"]))
                    g0 = soc_geo.get(key)
                    if g0 is None:
                        g0 = soc_geo[key] = {"names": Counter(), "lats": [], "lons": [], "url": "", "prec": False}
                    g0["names"][rec["society"].strip()] += 1
                    g0["lats"].append(lat)
                    g0["lons"].append(lon)
                    if rec["url"] and not g0["url"]:
                        g0["url"] = rec["url"]
                    if rec["prec"] in ("society", "exact"):
                        g0["prec"] = True
                size = mid(num(g("size_min")), num(g("size_max")))
                price = mid(num(g("price_min")), num(g("price_max")))
                rent = mid(num(g("rent_min")), num(g("rent_max")))
                sale_rate = num(g("ppsf")) or (price / size if price and size else None) \
                    or (num(g("ppsy")) / 9 if num(g("ppsy")) else None)
                rent_rate = rent / size if rent and size else None
                if not sale_rate and not rent_rate:
                    skipped["no price or rent"] += 1
                    if rec["society"]:
                        no_price_by_soc[(norm(rec["society"]), norm(rec["area"]))] += 1
                    continue
                rec["size"] = size or 0
                bucket = summaries if level == "society" else units
                if level not in UNIT_LEVELS and level != "society":
                    skipped[f"unknown row_level '{level}'"] += 1
                    continue
                for deal, rate in ((0, sale_rate), (1, rent_rate)):
                    if rate:
                        bucket.append({**rec, "deal": deal, "rate": rate})

    # Society summaries only count when a society has no unit rows.
    unit_socs = {(norm(u["society"]), norm(u["area"])) for u in units if u["society"]}
    for s in summaries:
        if s["society"] and (norm(s["society"]), norm(s["area"])) in unit_socs:
            skipped["society summary (its units are already counted)"] += 1
        else:
            units.append(s)
            rep["society_summaries_used"] += 1

    # Duplicates: same home/config seen twice (another portal or another batch).
    units.sort(key=lambda u: u["date"])
    seen = defaultdict(list)
    kept = []
    for u in units:
        key = (u["type"], u["deal"], u["bhk"], round(u["size"]), norm(u["society"]))
        dup = False
        for (la, lo, ra) in seen[key]:
            near = bool(u["society"]) or dist_km(u["lat"], u["lon"], la, lo) < 0.05
            if near and abs(u["rate"] - ra) / ra < 0.02:
                dup = True
                break
        if dup:
            skipped["duplicate"] += 1
            continue
        seen[key].append((u["lat"], u["lon"], u["rate"]))
        kept.append(u)

    # Outliers against the area median (or the city median where an area has few rows).
    city_med = defaultdict(list)
    grp = defaultdict(list)
    for u in kept:
        city_med[(u["type"], u["deal"])].append(u["rate"])
        grp[(norm(u["area"]), u["type"], u["deal"])].append(u["rate"])
    city_med = {k: median(v) for k, v in city_med.items()}
    clean = []
    for u in kept:
        g = grp[(norm(u["area"]), u["type"], u["deal"])]
        ref, lo, hi = (median(g), 0.3, 3.0) if len(g) >= 4 else (city_med[(u["type"], u["deal"])], 0.15, 6.0)
        if not (lo * ref <= u["rate"] <= hi * ref):
            skipped["outlier (typo or wrong unit)"] += 1
            continue
        clean.append(u)

    # Each polygon's parents (which region/zone a ward sits in), from its label point.
    feat_parents = {}
    for k, lv in enumerate(poly_levels):
        for i, f in enumerate(P[lv["key"]].features):
            cx, cy = label_point(f["geometry"])
            feat_parents[(lv["key"], i)] = {up["key"]: P[up["key"]].find(cx, cy) for up in poly_levels[:k]}

    # Assign polygon levels from coordinates. A CSV ward column is only a cross-check,
    # and a fallback for points that land outside every ward (e.g. on the coast).
    mismatches = Counter()
    for u in clean:
        for lv in poly_levels:
            pl = P[lv["key"]]
            i = pl.find(u["lon"], u["lat"])
            if lv.get("csvColumn") == "ward" and u["ward_csv"]:
                j = pl.by_code.get(code_norm(u["ward_csv"]), -1)
                if i < 0:
                    i = j
                elif j >= 0 and i != j:
                    mismatches[f"{u['ward_csv']} -> location is in {pl.features[i]['properties'].get('code')}"] += 1
            u[lv["key"]] = i
        # Fill missing upper levels from the most detailed level found.
        for k in range(len(poly_levels) - 1, 0, -1):
            low = poly_levels[k]["key"]
            if u[low] >= 0:
                for up_key, up_i in feat_parents[(low, u[low])].items():
                    if u[up_key] < 0:
                        u[up_key] = up_i
    for lv in poly_levels:
        rep[f"outside_{lv['key']}"] = sum(1 for u in clean if u[lv["key"]] < 0)

    # Point level: areas named in the CSV.
    areas = {}
    def area_entry(name, lat, lon):
        k = norm(name)
        if k not in areas:
            areas[k] = {"names": Counter(), "lats": [], "lons": [], "gov": defaultdict(list), "refs": [], "units": 0}
        a = areas[k]
        a["names"][name.strip()] += 1
        if lat is not None:
            a["lats"].append(lat)
            a["lons"].append(lon)
        return a
    for u in clean:
        if u["area"]:
            area_entry(u["area"], u["lat"], u["lon"])["units"] += 1
    for gr in gov_rows:
        if gr["area"]:
            a = area_entry(gr["area"], None, None)
            a["gov"][gr["type"]].append(gr["rate"])
            if not a["units"] and gr["lat"] is not None:
                a["lats"].append(gr["lat"])
                a["lons"].append(gr["lon"])
            a["gov_date"] = gr["date"]
    for rr in ref_rows:
        if rr["area"]:
            a = area_entry(rr["area"], None, None)
            a["refs"].append({"label": rr["sub_area"] or rr["area"], "source": rr["source"], "rate": round(rr["rate"]), "type": rr["type"],
                              "note": rr["notes"][:140], "url": rr["url"], "date": rr["date"]})
            if not a["lats"] and rr["lat"] is not None:
                a["lats"].append(rr["lat"])
                a["lons"].append(rr["lon"])
    area_list = []
    for k, a in sorted(areas.items(), key=lambda kv: kv[0]):
        if not a["lats"]:
            skipped["area without coordinates"] += 1
            continue
        a["id"] = len(area_list)
        a["name"] = a["names"].most_common(1)[0][0]
        a["lat"], a["lon"] = median(a["lats"]), median(a["lons"])
        area_list.append(a)
    area_idx = {norm(a["name"]): a["id"] for a in area_list}
    for u in clean:
        u["area_i"] = area_idx.get(norm(u["area"]), -1)
    # Area parents: where most of its points fall, else where its centre falls.
    for a in area_list:
        a["parents"] = {}
        for lv in poly_levels:
            votes = Counter(u[lv["key"]] for u in clean if u["area_i"] == a["id"] and u[lv["key"]] >= 0)
            a["parents"][lv["key"]] = votes.most_common(1)[0][0] if votes else P[lv["key"]].find(a["lon"], a["lat"])

    # Societies. Priced ones get pins; the rest are listed for search only.
    soc_list, soc_idx = [], {}
    priced_socs = 0
    if city.get("societies"):
        groups = defaultdict(list)
        for u in clean:
            if u["society"]:
                groups[(norm(u["society"]), norm(u["area"]))].append(u)
        priced_socs = len(groups)
        for key, items in sorted(groups.items()):
            soc_idx[key] = len(soc_list)
            soc_list.append({
                "id": len(soc_list), "name": items[0]["society"],
                "lon": r5(median([i["lon"] for i in items])), "lat": r5(median([i["lat"] for i in items])),
                "area": items[0]["area_i"], "url": Counter(i["url"] for i in items if i["url"]).most_common(1)[0][0] if any(i["url"] for i in items) else "",
                "npr": no_price_by_soc.get(key, 0),
                "p": 1 if any(i["prec"] in ("society", "exact") for i in items) else 0,
            })
        for key, g0 in sorted(soc_geo.items()):
            if key in soc_idx:
                continue
            soc_idx[key] = len(soc_list)
            soc_list.append({
                "id": len(soc_list), "name": g0["names"].most_common(1)[0][0],
                "lon": r5(median(g0["lons"])), "lat": r5(median(g0["lats"])),
                "area": area_idx.get(key[1], -1), "url": g0["url"],
                "npr": no_price_by_soc.get(key, 0),
                "p": 1 if g0["prec"] else 0,
            })

    # ---------- write ----------
    level_keys = [lv["key"] for lv in city["levels"]]
    fields = ["lon", "lat", "type", "deal", "size", "rate", "date", "src", "bhk", "soc", "url"] + level_keys
    rows = []
    for u in clean:
        row = [r5(u["lon"]), r5(u["lat"]), type_ids.index(u["type"]), u["deal"], round(u["size"]),
               round(u["rate"], 1) if u["deal"] else round(u["rate"]), u["date"],
               intern(sources, u["source"]), intern(bhks, u["bhk"]) if u["bhk"] else -1,
               soc_idx.get((norm(u["society"]), norm(u["area"])), -1) if u["society"] else -1,
               intern(urls, u["url"]) if u["url"] and city.get("societies") else -1]
        for lv in city["levels"]:
            row.append(u["area_i"] if lv["kind"] == "point" else u[lv["key"]])
        rows.append(row)

    # Government rate for polygons = median of their areas' rates.
    def gv_for(member_areas):
        gv = {}
        for t in type_ids:
            vals = [median(a["gov"][t]) for a in member_areas if a["gov"].get(t)]
            if vals:
                gv[t] = round(median(vals))
        return gv
    gov_dates = sorted({gr["date"] for gr in gov_rows if gr["date"]})
    gv_date = gov_dates[-1] if gov_dates else ""

    for lv in poly_levels:
        pl = P[lv["key"]]
        feats = []
        for i, f in enumerate(pl.features):
            cx, cy = label_point(f["geometry"])
            parents = {}
            for up in poly_levels[: poly_levels.index(lv)]:
                parents[up["key"]] = P[up["key"]].find(cx, cy)
            props = {"id": i, "name": f["properties"]["name"], "cx": r5(cx), "cy": r5(cy), "parents": parents,
                     "gv": gv_for([a for a in area_list if a["parents"].get(lv["key"]) == i]), "gvDate": gv_date}
            for extra in ("short", "code"):
                if f["properties"].get(extra):
                    props[extra] = f["properties"][extra]
            feats.append({"type": "Feature", "id": i, "properties": props, "geometry": f["geometry"]})
        (out / "levels" / f"{lv['key']}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))

    (out / "areas.json").write_text(json.dumps([{
        "id": a["id"], "name": a["name"], "lon": r5(a["lon"]), "lat": r5(a["lat"]), "parents": a["parents"],
        "gv": {t: round(median(v)) for t, v in a["gov"].items() if v}, "gvDate": a.get("gov_date", ""),
        "refs": a["refs"],
    } for a in area_list], separators=(",", ":")))
    (out / "points.json").write_text(json.dumps({
        "fields": fields, "sources": sources, "bhk": bhks, "urls": urls, "rows": rows,
    }, separators=(",", ":")))
    if city.get("societies"):
        (out / "societies.json").write_text(json.dumps(soc_list, separators=(",", ":")))

    osm = json.loads((cdir / "boundaries" / "places_osm.json").read_text()) if (cdir / "boundaries" / "places_osm.json").exists() else []
    (out / "places.json").write_text(json.dumps({
        "landmarks": [{"name": n, "lat": la, "lon": lo} for n, la, lo in city.get("landmarks", [])],
        "colonies": [{"name": p["name"], "lat": p["lat"], "lon": p["lon"]} for p in osm if norm(p["name"]) not in area_idx],
    }, separators=(",", ":")))

    # Manifest: everything the app needs to know about this city.
    types_out = []
    for t in city["types"]:
        ti = type_ids.index(t["id"])
        sizes = sorted(r[4] for r in rows if r[2] == ti and r[4] > 0)
        counts = [sum(1 for r in rows if r[2] == ti and r[3] == d) for d in (0, 1)]
        if not any(counts):
            continue
        lo = sizes[int(len(sizes) * 0.02)] if sizes else 0
        hi = sizes[min(len(sizes) - 1, int(len(sizes) * 0.98))] if sizes else 0
        types_out.append({**t, "index": ti, "sale": counts[0], "rent": counts[1],
                          "sizeMin": int(lo // 50 * 50), "sizeMax": int(math.ceil(hi / 50) * 50)})
    bhk_counts = Counter(bhks[r[8]] for r in rows if r[8] >= 0)
    bhk_counts = Counter({b: n for b, n in bhk_counts.items() if n >= 20})
    order = lambda b: (0, 0) if b == "1RK" else (1, int(re.sub(r"\D", "", b) or 9))  # noqa: E731
    dates = sorted(r[6] for r in rows if r[6])
    report = {
        "files": [f.name for f in files], "rowsRead": rep["rows_read"],
        "pointsUsed": len(rows), "sale": sum(1 for r in rows if r[3] == 0), "rent": sum(1 for r in rows if r[3] == 1),
        "skipped": dict(skipped.most_common()), "governmentRates": len(gov_rows), "portalReferences": len(ref_rows),
        "societySummariesUsed": rep["society_summaries_used"], "societies": priced_socs, "societiesListed": len(soc_list),
        "areas": len(area_list), "corruptCoordinates": sum(v for k, v in skipped.items() if k.startswith("corrupt coordinates")),
        "rowsWithoutCoordinates": skipped.get("no coordinates", 0),
        "wardMismatches": dict(mismatches.most_common(10)), "wardMismatchesTotal": sum(mismatches.values()),
        "outside": {lv["key"]: rep[f"outside_{lv['key']}"] for lv in poly_levels},
    }
    heights = (out / "heights" / "index.json").exists()
    manifest = {
        "id": city["id"], "name": city["name"], "sample": city.get("sample", False), "dataLabel": city.get("dataLabel", ""),
        "bbox": city["bbox"], "view": city["view"], "defaultUnit": city.get("defaultUnit", "yd"),
        "guidance": city.get("guidance", {"label": "Government rate"}), "credits": city.get("credits", []),
        "pinsFrom": city.get("pinsFrom", 14.6), "societies": bool(city.get("societies")),
        "surfaceStep": city.get("surfaceStep", 0.002), "pinSpread": bool(city.get("pinSpread", False)),
        "coordNote": city.get("coordNote", ""),
        "asOf": dates[-1] if dates else "", "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "types": types_out,
        "bhk": [{"id": b, "n": n} for b, n in sorted(bhk_counts.items(), key=lambda kv: order(kv[0]))] if len(bhk_counts) > 1 else None,
        "levels": [{**{k: v for k, v in lv.items() if k not in ("file", "csvColumn")},
                    "count": len(P[lv["key"]].features) if lv["kind"] == "polygon" else len(area_list)} for lv in city["levels"]],
        "heights": "heights/index.json" if heights else None,
        "report": report,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    (out / "report.json").write_text(json.dumps(report, indent=1))

    idx_path = ROOT / "data" / "cities.json"
    idx = json.loads(idx_path.read_text()) if idx_path.exists() else []
    idx = [c for c in idx if c["id"] != city["id"]] + [{"id": city["id"], "name": city["name"], "sample": city.get("sample", False)}]
    order_ids = ["bengaluru", "mumbai", "delhi"]
    idx.sort(key=lambda c: order_ids.index(c["id"]) if c["id"] in order_ids else 99)
    idx_path.write_text(json.dumps(idx, indent=1))

    # ---------- report ----------
    print(f"\n{city['name']}: {len(files)} file(s), {report['rowsRead']:,} rows read")
    print(f"  used: {len(rows):,} data points ({report['sale']:,} sale, {report['rent']:,} rent)"
          f"{f', {len(soc_list):,} societies' if soc_list else ''}, {len(area_list)} {point_level['plural'] if point_level else 'areas'}")
    print(f"  government rates: {len(gov_rows)} rows, portal references: {len(ref_rows)} rows")
    for reason, n in skipped.most_common():
        print(f"  skipped {n:>6,}  {reason}")
    for lv in poly_levels:
        covered = len({r[fields.index(lv['key'])] for r in rows if r[fields.index(lv['key'])] >= 0})
        print(f"  {lv['plural']}: {covered} of {len(P[lv['key']].features)} have data; {report['outside'][lv['key']]} points outside them")
    if mismatches:
        print(f"  CSV ward differs from the ward at the point's location (location used): {sum(mismatches.values())},"
              f" e.g. {list(mismatches)[:3]}")
    print(f"  written to {out.relative_to(ROOT)}/")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
