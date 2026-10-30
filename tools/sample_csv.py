"""Write SAMPLE data for a city as a CSV in the client's data format.

  python tools/sample_csv.py bengaluru|delhi

Output: cities/<city>/raw/<city>_sample.csv with exactly the same columns as the real
masters, so it goes through tools/ingest.py like real data. Every price here is invented. When the real file arrives, delete the sample
file from raw/ and put the real one there.

To show the cleaning step working, the sample includes the problems real feeds
have: the same home posted on several portals and typos such as rent posted as sale.
Uses only the Python standard library.
"""
import csv
import json
import math
import random
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TODAY = date(2026, 10, 29)

COLUMNS = ["city", "region", "bmc_ward", "area", "sub_area", "society_or_layout", "row_level", "property_type",
           "source", "bhk", "area_sqft_min", "area_sqft_max", "area_type", "total_price_min", "total_price_max",
           "price_per_sqft", "price_per_sqyd", "rent_monthly_min", "rent_monthly_max", "listing_count",
           "ready_reckoner_rate_per_sqm", "rr_zone", "as_of", "url", "notes", "lat", "lon", "geo_source", "geo_precision"]

# Rough sample land rates (Rs per sq ft) at anchor points. Made up for the demo.
CITIES = {
    "bengaluru": {
        "name": "Bengaluru",
        "anchors": [
            (13.007, 77.580, 42000), (12.975, 77.606, 36000), (12.971, 77.641, 32000), (12.935, 77.624, 30000),
            (12.925, 77.583, 26000), (13.003, 77.570, 25000), (12.942, 77.574, 24000), (12.912, 77.638, 19000),
            (13.035, 77.597, 14000), (12.907, 77.585, 15000), (12.925, 77.546, 14000), (12.970, 77.535, 13000),
            (12.925, 77.676, 13000), (12.970, 77.750, 11500), (12.900, 77.620, 10000), (13.040, 77.640, 9000),
            (12.960, 77.510, 9000), (13.007, 77.695, 8000), (12.927, 77.519, 8000), (13.100, 77.596, 7500),
            (12.870, 77.630, 6500), (13.030, 77.520, 6000), (12.912, 77.485, 5500), (12.860, 77.560, 5000),
        ],
        # (type, share, sizes in sq ft, built-up rate = a + b * land rate)
        "mix": [("plot", 0.30, [600, 1200, 1200, 1500, 2400, 2400, 4000], None),
                ("apartment", 0.36, [650, 900, 1150, 1250, 1400, 1650, 1900, 2400, 3200], (3800, 0.32)),
                ("builder floor", 0.34, [1200, 1800, 2400, 3000, 3600, 4500], (2500, 0.62))],
        "rent_share": 0.4,
        "guidance": ("Sample guidance value (Kaveri format)", 0.42, 0.62),
        "region_file": "corporation.geojson",
    },
    "delhi": {
        "name": "Delhi",
        "anchors": [
            (28.6010, 77.2290, 130000), (28.6000, 77.2100, 160000), (28.5603, 77.1600, 80000), (28.5480, 77.2380, 55000),
            (28.5730, 77.2320, 70000), (28.5500, 77.2000, 55000), (28.5240, 77.2100, 40000), (28.6680, 77.1300, 45000),
            (28.6490, 77.1220, 35000), (28.6510, 77.1900, 30000), (28.6800, 77.2250, 50000), (28.5680, 77.2430, 38000),
            (28.5800, 77.0500, 17000), (28.7300, 77.1100, 20000), (28.6200, 77.0850, 25000), (28.6050, 77.2950, 20000),
            (28.6700, 77.2900, 14000), (28.6300, 77.2780, 16000), (28.6200, 77.0550, 9000), (28.8500, 77.0900, 4500),
            (28.6100, 76.9800, 5500), (28.7500, 77.2000, 7000), (28.5000, 77.2500, 6000), (28.5200, 77.1800, 12000),
            (28.4950, 77.1800, 15000),
        ],
        "mix": [("plot", 0.25, [450, 900, 1125, 1800, 2250, 2700, 4500], None),
                ("builder floor", 0.45, [900, 1100, 1350, 1600, 1800, 2250, 2700, 3600], (3000, 0.55)),
                ("apartment", 0.30, [600, 750, 900, 1100, 1300, 1600, 1900, 2200], (4500, 0.25))],
        "rent_share": 0.35,
        "guidance": ("Sample circle rate", 0.35, 0.6),
        "region_file": "district.geojson",
    },
}
SOURCES = [("Sample listing", 70), ("Sample registered deal", 20), ("Sample broker input", 10)]


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


def bhk_for(size):
    return "1BHK" if size < 700 else "2BHK" if size < 1150 else "3BHK" if size < 1700 else "4BHK" if size < 2600 else "5BHK"


def main(city_id):
    cfg = CITIES[city_id]
    bdir = ROOT / "cities" / city_id / "boundaries"
    wards = json.loads((bdir / "ward.geojson").read_text())["features"]
    regions = json.loads((bdir / cfg["region_file"]).read_text())["features"]
    places = [p for p in json.loads((bdir / "places_osm.json").read_text())]
    random.seed(7 if city_id == "delhi" else 42)

    def land_rate(lat, lon):
        num = den = 0.0
        for alat, alon, rate in cfg["anchors"]:
            w = 1 / max(dist_km(lat, lon, alat, alon), 0.4) ** 2.2
            num += w * math.log(rate)
            den += w
        return math.exp(num / den)

    def area_name(lon, lat):
        best, bd = None, 2.0
        for p in places:
            if abs(p["lat"] - lat) > 0.02 or abs(p["lon"] - lon) > 0.02:
                continue
            d = dist_km(lat, lon, p["lat"], p["lon"])
            if d < bd and p["kind"] != "neighbourhood":
                best, bd = p, d
        return best["name"] if best else None

    def region_name(lon, lat):
        for f in regions:
            if in_geom(lon, lat, f["geometry"]):
                return f["properties"].get("short") or f["properties"]["name"]
        return ""

    rows = []
    for ward in wards:
        geom = ward["geometry"]
        ring = max((p[0] for p in polys_of(geom)), key=len)
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        roll = random.random()
        n = random.randint(1, 4) if roll < 0.08 else random.randint(14, 30) if roll < 0.3 else random.randint(30, 70)
        wbase = None
        made = tries = 0
        while made < n and tries < n * 80:
            tries += 1
            x, y = random.uniform(min(xs), max(xs)), random.uniform(min(ys), max(ys))
            if not in_geom(x, y, geom):
                continue
            made += 1
            if wbase is None:
                wbase = land_rate(y, x) * math.exp(random.gauss(0, 0.08))
            local = land_rate(y, x) * 0.5 + wbase * 0.5
            r, acc = random.random(), 0
            for ptype, share, sizes, built in cfg["mix"]:
                acc += share
                if r < acc:
                    break
            size = random.choice(sizes)
            base = local if built is None else built[0] + built[1] * local
            rate = base * math.exp(random.gauss(0, 0.15))
            rent = ptype != "plot" and random.random() < cfg["rent_share"]
            src = random.choices([s for s, _ in SOURCES], weights=[w for _, w in SOURCES])[0]
            row = dict.fromkeys(COLUMNS, "")
            row.update({
                "city": cfg["name"], "region": region_name(x, y),
                "area": area_name(x, y) or ward["properties"]["name"],
                "row_level": "config", "property_type": ptype, "source": src,
                "bhk": "" if ptype == "plot" else bhk_for(size),
                "area_sqft_min": size, "area_sqft_max": size,
                "as_of": (TODAY - timedelta(days=random.randint(3, 200))).isoformat(),
                "notes": "SAMPLE DATA - not a real listing",
                "lat": round(y, 6), "lon": round(x, 6), "geo_source": "sample", "geo_precision": "exact",
            })
            if rent:
                monthly = round(rate * random.uniform(0.0022, 0.0032) * size, -2)
                row.update({"rent_monthly_min": int(monthly), "rent_monthly_max": int(monthly)})
            else:
                total = round(rate * size, -4)
                row.update({"total_price_min": int(total), "total_price_max": int(total),
                            "price_per_sqft": round(total / size), "price_per_sqyd": round(total / size * 9)})
            rows.append(row)

    # The same home posted again on another portal a few days later.
    for row in random.sample(rows, int(len(rows) * 0.07)):
        dup = dict(row)
        dup["lat"] = round(float(row["lat"]) + random.uniform(-0.0001, 0.0001), 6)
        dup["lon"] = round(float(row["lon"]) + random.uniform(-0.0001, 0.0001), 6)
        dup["as_of"] = (date.fromisoformat(row["as_of"]) + timedelta(days=random.randint(0, 9))).isoformat()
        rows.append(dup)
    # Typos: rent posted as a sale price, an extra zero, a missing zero.
    for row in random.sample(rows, int(len(rows) * 0.012)):
        if row["price_per_sqft"] == "":
            continue
        k = random.random()
        f = 0.0027 if k < 0.4 and row["property_type"] != "plot" else 10 if k < 0.75 else 0.1
        row["price_per_sqft"] = max(1, round(row["price_per_sqft"] * f))
        row["price_per_sqyd"] = row["price_per_sqft"] * 9
        row["total_price_min"] = row["total_price_max"] = row["price_per_sqft"] * int(row["area_sqft_min"])

    # Government reference rates per area (sample), one row per area for land and for flats.
    label, lo, hi = cfg["guidance"]
    by_area = {}
    for row in rows:
        by_area.setdefault(row["area"], []).append(row)
    for name, items in by_area.items():
        lat = sorted(float(r["lat"]) for r in items)[len(items) // 2]
        lon = sorted(float(r["lon"]) for r in items)[len(items) // 2]
        land = land_rate(lat, lon) * random.uniform(lo, hi)
        for ptype, rate in (("plot", land), ("apartment", (3800 + 0.3 * land / ((lo + hi) / 2)) * random.uniform(0.55, 0.75))):
            row = dict.fromkeys(COLUMNS, "")
            row.update({"city": cfg["name"], "region": items[0]["region"], "area": name, "row_level": "area",
                        "property_type": ptype, "source": label,
                        "ready_reckoner_rate_per_sqm": round(rate * 10.7639, -1), "as_of": "2026-02-01",
                        "notes": "SAMPLE DATA - official floor rate, invented for the demo",
                        "lat": round(lat, 6), "lon": round(lon, 6), "geo_source": "sample", "geo_precision": "area",
                        "price_per_sqft": round(rate)})
            rows.append(row)

    random.shuffle(rows)
    out = ROOT / "cities" / city_id / "raw" / f"{city_id}_sample.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    print(f"{out.relative_to(ROOT)}: {len(rows)} rows, {len(by_area)} areas")


if __name__ == "__main__":
    main(sys.argv[1])
