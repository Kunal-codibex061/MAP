"""Download and prepare the boundary files each city uses. Run once per city.

  python tools/fetch_boundaries.py bengaluru|mumbai|delhi

Writes cities/<city>/boundaries/<level>.geojson (simplified polygons) and
places_osm.json (OpenStreetMap suburbs/neighbourhoods, used for search and as
locality names).

Needs: pip install shapely   (only this script; ingest.py needs nothing)

Sources
  Bengaluru: GBA corporations + zones 2025 (OpenCity, public domain),
             BBMP wards 2022 (DataMeet, CC BY-SA 2.5 IN)
  Mumbai:    BMC wards (DataMeet, CC BY-SA 2.5 IN), regions = wards merged,
             Navi Mumbai / Thane / Mira-Bhayandar outlines (OpenStreetMap, ODbL)
  Delhi:     13 districts (OpenStreetMap, ODbL), wards (DataMeet, CC BY-SA 2.5 IN)
"""
import hashlib
from collections import defaultdict
import json
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from shapely.geometry import LineString, MultiPolygon, Polygon, mapping, shape
from shapely.ops import polygonize, unary_union

ROOT = Path(__file__).resolve().parent.parent
DATAMEET = "https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master"
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
UA = {"User-Agent": "PriceMapPrototype/0.2 (boundary prep)"}
SIMPLIFY = 0.00008  # degrees, about 9 m


def get(url, data=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # network hiccup or busy server
            print(f"  retry {i + 1} for {url[:60]}: {e}")
            time.sleep(5 * (i + 1))
    raise SystemExit(f"Could not fetch {url}")


CACHE = ROOT / "tools" / ".overpass_cache"


def overpass(query):
    """Query OpenStreetMap's Overpass API. Answers are cached, so a rerun after a
    failure only fetches what is still missing. The public servers are often busy,
    so this retries patiently."""
    CACHE.mkdir(exist_ok=True)
    cached = CACHE / (hashlib.sha1(query.encode()).hexdigest() + ".json")
    if cached.exists():
        return json.loads(cached.read_text())
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(6):
        for url in OVERPASS:
            try:
                d = json.loads(get(url, body, tries=1))
            except (SystemExit, ValueError):
                continue
            if d.get("elements"):
                cached.write_text(json.dumps(d))
                return d
        wait = 15 * (attempt + 1)
        print(f"  Overpass busy, waiting {wait}s")
        time.sleep(wait)
    raise SystemExit("Overpass unavailable, try again later (finished parts are cached)")


def clean(geom):
    geom = geom.buffer(0).simplify(SIMPLIFY, preserve_topology=True)
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    polys = [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]
    return MultiPolygon(polys)


def round_coords(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], 5), round(obj[1], 5)]
        return [round_coords(o) for o in obj]
    return obj


def write_fc(path, items):
    """items: list of (properties, shapely geometry)"""
    feats = []
    for props, geom in items:
        g = mapping(clean(geom))
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": g["type"], "coordinates": round_coords(g["coordinates"])}})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    print(f"  {path.relative_to(ROOT)}: {len(feats)} areas, {path.stat().st_size // 1024} KB")


def assemble(rel):
    lines = [LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
             for m in rel["members"] if m["type"] == "way" and m.get("role") in ("outer", "") and m.get("geometry")]
    return unary_union(list(polygonize(unary_union(lines))))


def osm_relation(rel_id):
    """Assemble an OSM boundary relation into a shapely polygon."""
    rel = overpass(f"[out:json][timeout:120];rel({rel_id});out geom;")["elements"][0]
    return rel["tags"], assemble(rel)


def osm_places(bbox, path):
    w, s, e, n = bbox
    d = overpass(f'[out:json][timeout:120];node["place"~"^(suburb|neighbourhood|quarter)$"]["name"]({s},{w},{n},{e});out body;')
    places = [{"name": x["tags"]["name"].strip(), "kind": x["tags"]["place"],
               "lon": round(x["lon"], 5), "lat": round(x["lat"], 5)} for x in d["elements"]]
    path.write_text(json.dumps(places, separators=(",", ":")))
    print(f"  {path.relative_to(ROOT)}: {len(places)} places")


def read_kml(path):
    root = ET.parse(path).getroot()
    ns = {"k": root.tag.split("}")[0].strip("{")}
    out = []
    for pm in root.findall(".//k:Placemark", ns):
        props = {d.get("name"): d.text for d in pm.findall(".//k:SimpleData", ns)}
        polys = []
        for pg in pm.findall(".//k:Polygon", ns):
            rings = []
            for tag in ("k:outerBoundaryIs", "k:innerBoundaryIs"):
                for b in pg.findall(tag, ns):
                    txt = b.findtext(".//k:coordinates", namespaces=ns) or ""
                    rings.append([tuple(float(v) for v in c.split(",")[:2]) for c in txt.split()])
            if rings and len(rings[0]) >= 4:
                polys.append(Polygon(rings[0], rings[1:]))
        out.append((props, unary_union(polys)))
    return out


# ---------- Cities ----------
def bengaluru(out):
    src = ROOT / "tools" / "sources"
    order = ["Central", "North", "South", "East", "West"]
    corps = sorted(read_kml(src / "gba_corporations_sep2025.kml"), key=lambda x: order.index(x[0]["corporatio"].strip()))
    write_fc(out / "corporation.geojson", [
        ({"name": f"Bengaluru {p['corporatio'].strip()} City Corporation", "short": f"{p['corporatio'].strip()} Corporation"}, g)
        for p, g in corps])
    zones = sorted(read_kml(src / "gba_zones_2025.kml"),
                   key=lambda x: (order.index(x[0]["Corporatio"].strip()), x[0]["Zone"]))
    write_fc(out / "zone.geojson", [
        ({"name": f"{p['Corporatio'].strip()} Zone {p['Zone'].replace('Zone', '').strip()}"}, g) for p, g in zones])
    wards = json.loads((src / "bbmp_wards_2022.geojson").read_text())["features"]
    write_fc(out / "ward.geojson", [
        ({"name": f["properties"]["KGISWardName"].replace("  ", " ").strip(), "code": f["properties"]["KGISWardNo"]},
         shape(f["geometry"])) for f in wards])
    places = json.loads((src / "osm_places.json").read_text())["elements"]
    (out / "places_osm.json").write_text(json.dumps([
        {"name": p["tags"]["name"].strip(), "kind": p["tags"]["place"], "lon": round(p["lon"], 5), "lat": round(p["lat"], 5)}
        for p in places], separators=(",", ":")))
    print(f"  places_osm.json: {len(places)} places")


MUMBAI_REGIONS = {
    "Island City": ["A", "B", "C", "D", "E", "F/N", "F/S", "G/N", "G/S"],
    "Western Suburbs": ["H/E", "H/W", "K/E", "K/W", "P/N", "P/S", "R/C", "R/N", "R/S"],
    "Central Suburbs": ["L", "N", "S", "T"],
    "Harbour": ["M/E", "M/W"],
}
WARD_LONG = {"N": "North", "S": "South", "E": "East", "W": "West", "C": "Central"}


def mumbai(out):
    wards = json.loads(get(f"{DATAMEET}/Mumbai/BMC_Wards.geojson"))["features"]
    ward_geom = {f["properties"]["name"]: shape(f["geometry"]).buffer(0) for f in wards}
    extra = []
    for name, rel in (("Navi Mumbai", 13180880), ("Mira-Bhayandar", 13180677)):
        tags, g = osm_relation(rel)
        extra.append((name, g))
        print(f"  OSM {name}: {tags.get('name')}")
    # Panvel (Kharghar, Panvel) via Nominatim: one light request.
    res = json.loads(get("https://nominatim.openstreetmap.org/lookup?osm_ids=R13182526&format=geojson"
                         "&polygon_geojson=1&polygon_threshold=0.00005"))["features"]  # Panvel city boundary
    res = [f for f in res if f["geometry"]["type"] in ("Polygon", "MultiPolygon")]
    if res:
        extra.append(("Panvel", shape(res[0]["geometry"])))
        print(f"  OSM Panvel: {res[0]['properties'].get('display_name', '')[:60]}")
    for name, pattern, box in (("Thane", "^Thane", "19.1,72.9,19.35,73.1"),):
        d = overpass(f'[out:json][timeout:90];rel["boundary"="administrative"]["name"~"{pattern}"]({box});out tags;')
        cand = [e for e in d["elements"] if e["tags"].get("admin_level") in ("7", "8")]
        if cand:
            tags, g = osm_relation(cand[0]["id"])
            extra.append((name, g))
            print(f"  OSM {name}: {tags.get('name')} (admin_level {tags.get('admin_level')})")
        else:
            print(f"  {name} outline not found in OSM")

    def long_name(code):  # "F/N" -> "F/North"
        if "/" in code:
            a, b = code.split("/")
            return f"{a}/{WARD_LONG.get(b, b)}"
        return code

    items = []
    for region, codes in MUMBAI_REGIONS.items():
        for c in codes:
            items.append(({"name": f"Ward {long_name(c)}", "code": long_name(c), "region": region}, ward_geom[c]))
    region_of = {"Panvel": "Navi Mumbai"}
    for name, g in extra:
        items.append(({"name": name, "code": name, "region": region_of.get(name, name)}, g))
    write_fc(out / "ward.geojson", items)
    regions = [({"name": r}, unary_union([ward_geom[c] for c in codes])) for r, codes in MUMBAI_REGIONS.items()]
    grouped = defaultdict(list)
    for name, g in extra:
        grouped[region_of.get(name, name)].append(g)
    regions += [({"name": r}, unary_union(gs)) for r, gs in grouped.items()]
    write_fc(out / "region.geojson", regions)
    try:
        osm_places((72.77, 18.88, 73.22, 19.33), out / "places_osm.json")
    except SystemExit as e:
        print(f"  place names skipped ({e}); rerun later with: fetch_boundaries.py mumbai places")


DELHI_DISTRICTS = range(21181211, 21181224)  # OSM relations for Delhi's 13 districts (2023)


def delhi(out):
    # Nominatim returns ready-made outlines in one light request, which works even when
    # the Overpass servers are too busy for a 13-relation geometry query.
    ids = ",".join(f"R{i}" for i in DELHI_DISTRICTS)
    url = f"https://nominatim.openstreetmap.org/lookup?osm_ids={ids}&format=geojson&polygon_geojson=1&polygon_threshold=0.00005"
    feats = json.loads(get(url))["features"]
    items = []
    for f in sorted(feats, key=lambda f: f["properties"].get("name", "")):
        name = f["properties"].get("name") or f["properties"].get("display_name", "").split(",")[0]
        items.append(({"name": name}, shape(f["geometry"])))
        print(f"  district {name}")
    write_fc(out / "district.geojson", items)
    wards = json.loads(get(f"{DATAMEET}/Delhi/Delhi_Wards.geojson"))["features"]
    write_fc(out / "ward.geojson", [
        ({"name": " ".join((f["properties"]["Ward_Name"] or f"Ward {f['properties']['Ward_No']}").split()).title(),
          "code": f["properties"]["Ward_No"]}, shape(f["geometry"]))
        for f in wards if f.get("geometry")])
    osm_places((76.83, 28.40, 77.35, 28.89), out / "places_osm.json")


if __name__ == "__main__":
    city = sys.argv[1]
    if len(sys.argv) > 2 and sys.argv[2] == "places":  # just refresh the place names
        bbox = {"bengaluru": (77.40, 12.80, 77.85, 13.20), "mumbai": (72.77, 18.88, 73.22, 19.33),
                "delhi": (76.83, 28.40, 77.35, 28.89)}[city]
        osm_places(bbox, ROOT / "cities" / city / "boundaries" / "places_osm.json")
        raise SystemExit
    out = ROOT / "cities" / city / "boundaries"
    out.mkdir(parents=True, exist_ok=True)
    print(f"Preparing boundaries for {city}")
    {"bengaluru": bengaluru, "mumbai": mumbai, "delhi": delhi}[city](out)
