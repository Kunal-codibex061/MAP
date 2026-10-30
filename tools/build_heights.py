"""Build real building heights for a city: data/<city>/heights/*.png + index.json.

  python tools/build_heights.py bengaluru|mumbai|delhi

Source: Google Open Buildings 2.5D Temporal, 2023 (CC BY 4.0),
https://sites.research.google/gr/open-buildings/temporal/

Steps: find the Google tiles covering the city's bounding box (cities/<city>/city.json),
read each at its 4 m level, keep heights where building-presence confidence >= 0.5,
max-pool onto a ~11 m lon/lat grid, then cut that grid into 1024 x 1024 PNG tiles
(pixel value = tallest building there, in metres; empty tiles are skipped). The app
loads only the tiles for the area on screen, so big cities stay light on phones.

Needs: pip install rasterio numpy s2sphere
The list of India tile URLs (tools/sources/gob_IND_2023_urls.txt) comes from
https://github.com/saiga143/google-2.5d-bulk-download (urls_part1.zip, IND_2023.txt).
"""
import json
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import rasterio
import s2sphere
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform_bounds

warnings.filterwarnings("ignore", category=rasterio.errors.NotGeoreferencedWarning)
ROOT = Path(__file__).resolve().parent.parent
URLS = ROOT / "tools" / "sources" / "gob_IND_2023_urls.txt"
CACHE = ROOT / "tools" / ".gob_cache"
STEP = 0.0001         # degrees, about 11 m
TILE = 1024
LEVEL_4M = 11         # overview index of the 4 m level in these files
MIN_PRESENCE = 0.5
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif")


def overlaps(b, box):
    return b[2] >= box[0] and b[0] <= box[2] and b[3] >= box[1] and b[1] <= box[3]


def tiles_for(box):
    """Google tiles are grouped in folders named after S2 cells; check folders first, then tiles."""
    urls = URLS.read_text().split()
    folders = {}
    for u in urls:
        folders.setdefault(u.split("/")[6], []).append(u)
    CACHE.mkdir(exist_ok=True)
    bounds_cache = CACHE / "tile_bounds.json"
    known = json.loads(bounds_cache.read_text()) if bounds_cache.exists() else {}
    hits = []
    with rasterio.Env(**ENV):
        for folder, items in folders.items():
            cell = s2sphere.Cell(s2sphere.CellId.from_token(folder.split("_")[0]))
            lats, lons = [], []
            for i in range(4):
                ll = s2sphere.LatLng.from_point(cell.get_vertex(i))
                lats.append(ll.lat().degrees)
                lons.append(ll.lng().degrees)
            if not overlaps((min(lons), min(lats), max(lons), max(lats)), box):
                continue
            for u in items:
                if u not in known:
                    with rasterio.open("/vsicurl/" + u) as ds:
                        known[u] = list(transform_bounds(ds.crs, "EPSG:4326", *ds.bounds))
                if overlaps(known[u], box):
                    hits.append(u)
    bounds_cache.write_text(json.dumps(known))
    return hits


def main(city):
    cfg = json.loads((ROOT / "cities" / city / "city.json").read_text())
    W, S, E, N = cfg["bbox"]
    width, height = round((E - W) / STEP), round((N - S) / STEP)
    dst_transform = from_origin(W, N, STEP, STEP)
    grid = np.zeros((height, width), dtype=np.float32)

    urls = tiles_for((W, S, E, N))
    print(f"{city}: {len(urls)} Google tiles cover the city", flush=True)
    with rasterio.Env(**ENV):
        for n, url in enumerate(urls, 1):
            t0 = time.time()
            with rasterio.open("/vsicurl/" + url, overview_level=LEVEL_4M) as ds:
                h = ds.read(2)
                p = ds.read(3)
                h[(p < MIN_PRESENCE) | ~np.isfinite(h)] = 0
                part = np.zeros_like(grid)
                reproject(h, part, src_transform=ds.transform, src_crs=ds.crs, dst_transform=dst_transform,
                          dst_crs="EPSG:4326", resampling=Resampling.max, src_nodata=None, dst_nodata=0)
                np.maximum(grid, part, out=grid)
            print(f"  tile {n}/{len(urls)}  {time.time() - t0:.1f}s", flush=True)

    out = np.clip(np.rint(grid), 0, 250).astype(np.uint8)
    hdir = ROOT / "data" / city / "heights"
    hdir.mkdir(parents=True, exist_ok=True)
    for old in hdir.glob("*.png"):
        old.unlink()
    keys, size = [], 0
    for r in range(0, height, TILE):
        for c in range(0, width, TILE):
            block = out[r:r + TILE, c:c + TILE]
            if not block.any():
                continue
            full = np.zeros((TILE, TILE), dtype=np.uint8)
            full[: block.shape[0], : block.shape[1]] = block
            key = f"{r // TILE}_{c // TILE}"
            path = hdir / f"{key}.png"
            with rasterio.open(path, "w", driver="PNG", width=TILE, height=TILE, count=1, dtype="uint8") as dst:
                dst.write(full, 1)
            for aux in hdir.glob(f"{key}.png.aux.xml"):
                aux.unlink()
            keys.append(key)
            size += path.stat().st_size
    (hdir / "index.json").write_text(json.dumps({
        "west": W, "north": N, "step": STEP, "width": width, "height": height, "tile": TILE, "tiles": keys,
        "source": "Google Open Buildings 2.5D Temporal 2023 (CC BY 4.0)",
    }))
    nz = out[out > 0]
    print(f"  grid {width}x{height}, {len(keys)} tiles, {size // 1024} KB total; "
          f"heights (m) median {np.median(nz):.0f}, 99th {np.percentile(nz, 99):.0f}, max {nz.max()}")


if __name__ == "__main__":
    main(sys.argv[1])
