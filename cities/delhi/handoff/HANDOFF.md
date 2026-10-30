# Delhi price-map handoff (for AI coding agent)

**Target app:** https://bengaluru-price-map.vercel.app/  
**City id:** `delhi`  
**Goal:** replace the current **sample** Delhi prices with this real dataset (pins + rates). Do **not** invent prices or coordinates.

## Give the friend these files only

| File | Use |
|------|-----|
| `delhi_master_clean.csv` | Full clean master (12,315 rows). Source of truth. |
| `delhi_society_pins.csv` | Best first pass for pins: priced + `geo_precision=society` (**4** rows only — very sparse). |
| `delhi_map_pins.csv` | All priced rows in NCT bbox with sane ₹/sqft (includes area-centroid stacks). |
| `points_for_map.json` | Already packed to the live `points.json` **field schema for Delhi**. |
| `societies_for_map.json` | Society list matching `soc` indices in `points_for_map.json`. |
| `manifest_delhi_suggested.json` | Suggested `manifest.json` with `sample: false` and real counts. |
| `areas_live_reference.json` | Copy of live `areas.json` ids/names (0–237) for locality joins — **do not invent new areas**. |
| `README_columns.md` | Column dictionary + provenance. |
| `HANDOFF.md` | This file. |

## What the live map expects

Loads `/data/delhi/` (see comment at top of `/app.js`):

- `manifest.json` — set **`"sample": false`**, real `asOf`, property `types` with indices
- `points.json` — packed rows (see below)
- `levels/*.geojson` — district / ward polygons (**already on the deploy for Delhi**)
- `areas.json` — colonies (**already deployed; ids 0–237**)
- `places.json` — landmarks (already deployed)
- `societies.json` — **only if** `manifest.societies === true` (ship our `societies_for_map.json`)
- `heights/` — optional 3D building tint

### Critical: Delhi field list ≠ Bengaluru

Live **Delhi** `points.json` fields (14):

```json
{
  "fields": ["lon","lat","type","deal","size","rate","date","src","bhk","soc","url","district","ward","area"],
  "sources": ["SquareYards Projects", "..."],
  "bhk": ["2BHK","3BHK"],
  "urls": ["https://..."],
  "rows": [[77.05, 28.59, 2, 0, 1200, 14000, "2026-10-29", 0, 0, -1, 0, 11, 80, 56]]
}
```

Bengaluru uses `corporation,zone,ward,area` (15 fields). **Do not** paste Bengaluru field names into Delhi.

| Field | Meaning |
|-------|---------|
| `lon`,`lat` | WGS84; app uses `[lon, lat]` |
| `type` | Index into `manifest.types` — live Delhi: **plot=0, floor=1, apartment=2** |
| `deal` | 0=sale, 1=rent |
| `size` | sqft; `0` = unknown (app skips size filter when size is 0) |
| `rate` | **₹ per sq ft** (sale) or ₹/sqft/mo (rent). UI ×9 for sq yd. |
| `date` | `YYYY-MM-DD` |
| `src` | Index into `sources[]` |
| `bhk` | Index into `bhk[]`, or -1 |
| `soc` | Index into `societies.json`, or -1 |
| `url` | Index into `urls[]`, or -1 |
| `district`,`ward`,`area` | Indices into those layers / `areas.json`, or -1 |

Live Delhi is still **`sample: true`** (~11k fake points).

## Recommended integration path

1. Prefer running the repo’s **`tools/ingest.py`** on `delhi_master_clean.csv` or `delhi_map_pins.csv` if you have the map source repo.
2. If you only have the Vercel static output: copy  
   - `points_for_map.json` → `public/data/delhi/points.json`  
   - `societies_for_map.json` → `public/data/delhi/societies.json`  
   - `manifest_delhi_suggested.json` → `public/data/delhi/manifest.json` (or merge: set `"sample": false`, `"societies": true`, update `types` / `report`)  
   Keep existing `levels/*.geojson`, `areas.json`, `places.json`, `heights/`.
3. Redeploy. Confirm the top pill says **real data**, not sample.

## Data quality the agent must know

- **12,315** master rows in source; clean CSV **12,315** rows; UTF-8; **0** exact duplicate master rows.
- **Priced points packed:** **2,608**. Unpriced society-name rows stay in the master for search coverage.
- **geo_precision on map pins:** society **4** · other/area-centroid **2554**.  
  → Only **254** unique coordinate pairs among map pins — **heavy stacking**. For a clean prototype, start with `delhi_society_pins.csv` **or** enable `societies: true` and show society medians.
- **Out of bbox** (lon 76.83–77.35, lat 28.4–28.89): **0** excluded.
- **Lat/lon swaps:** **0**.
- **Rate outliers** outside 200–100,000 ₹/sqft: **0**.
- **Circle rates:** included with `src` = `Delhi circle rates` (official floor; already converted to ₹/sqft in master).
- **Locality ids:** when `map_locality_id` is set it **exists** in live `areas.json`. Many master areas (sectors/pockets) have no colony match → `area=-1` but coordinates still plot.
- **Corporation / MCD:** live Delhi map has **no corporation layer** (district replaces it). Zone/ward names in the CSV are labels only; ward **index** comes from `areas.json` parents when matched, else -1.

## Prompt you can paste to the friend’s AI

```
Integrate real Delhi property prices into https://bengaluru-price-map.vercel.app/

Use the files in this handoff folder. Read HANDOFF.md first.

Rules:
- Do not invent prices or coordinates.
- Prefer delhi_society_pins.csv for the first prototype pins if any exist; otherwise use points_for_map.json which already matches /data/delhi/points.json field names.
- IMPORTANT: Delhi points fields are lon,lat,type,deal,size,rate,date,src,bhk,soc,url,district,ward,area (NOT corporation/zone).
- Live types: plot=0, floor=1, apartment=2. Rates are ₹/sqft.
- Set manifest.sample=false after swapping in real points. Set societies=true if you ship societies_for_map.json as societies.json.
- Warn in the UI/about copy that many non-society rows share locality centroids (geo_precision=area) — show them as area averages, not distinct building pins.
- Keep conflicting sources as separate pins; never average blindly.
- Keep existing areas.json / levels geojson; do not invent new locality ids.
```
