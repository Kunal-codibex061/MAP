# Property Price Map — prototype (Bengaluru · Mumbai · Delhi)

A map of what property costs, from city-wide areas down to individual streets and societies.

| City | Data | Levels |
|---|---|---|
| **Mumbai** | **Real, batch 1**: SquareYards project listings, Housing.com area averages, Maharashtra IGR ready reckoner (29 Oct 2026) | Region → BMC ward → Area → Society |
| **Bengaluru** | Sample (invented) | GBA corporation → Zone → Ward → Locality |
| **Delhi** | Sample (invented), until the real file arrives | District → Ward → Colony |

Live: https://bengaluru-price-map.vercel.app (`/mumbai`, `/delhi`, `/bengaluru`). Locally: `?city=mumbai`.

## Adding or updating data (the normal workflow)

All cities use one CSV format: the columns of `mumbai_master_batch1_snapshot.csv`.

1. Put the CSV file(s) in `cities/<city>/raw/`. Every CSV in that folder is merged, so add `batch2.csv` next to `batch1` rather than replacing it. Delete `<city>_sample.csv` once real data arrives for Bengaluru or Delhi.
2. Run:
   ```bash
   python3 tools/ingest.py mumbai
   ```
   It prints what was used and what was skipped, and why (no price, duplicate, outlier and so on). The same numbers appear in the app's About window.
3. Deploy (see below).

Only Python 3 is needed for this step, with nothing to install.

### What ingest does with each row
| `row_level` | Used as |
|---|---|
| `config` (or `unit`, `listing`, blank) | One data point. Sale rate = `price_per_sqft`, or total price ÷ size. Rent = `rent_monthly` ÷ size |
| `society` | A society summary. Ignored when that society already has unit rows, so nothing is counted twice |
| `area` / `sub_area` with `ready_reckoner_rate_per_sqm` (or a source mentioning ready reckoner / circle rate) | The area's government rate, shown as "Market vs ready reckoner / circle rate" |
| other `area` rows (e.g. Housing.com averages) | "Other published averages" in the area panel; not counted in the medians |

Cleaning steps:
- Rows without coordinates, inside a city's box or with an unknown property type are skipped.
- **Duplicates** are removed: the same society, configuration, size and price within 2%, or the same spot within 50 m.
- **Outliers** are removed: prices outside 0.3–3× the area median.
- Wards come from each point's **coordinates**. The CSV ward column is only a cross-check, and a fallback for points just outside the map's ward lines.

Column names are matched loosely (`bmc_ward`/`ward`/`mcd_ward`, `lat`/`latitude`, …; see `ALIASES` in `tools/ingest.py`). Missing optional columns are fine.

## Adding a new city
1. Create `cities/<city>/city.json`. Copy `cities/delhi/city.json` and change the name, bounding box, start view, default unit, government-rate label, property types, levels and landmarks.
2. Add boundary files to `cities/<city>/boundaries/` (one GeoJSON per polygon level, with a `name` property). Add the city to `tools/fetch_boundaries.py` to automate this.
3. Put CSVs in `cities/<city>/raw/` and run `python3 tools/ingest.py <city>`.
4. Optional: real building heights with `python3 tools/build_heights.py <city>`.
5. Add the city's id to the rewrite in `vercel.json`.

## Run locally
```bash
python3 -m http.server 8000
```
Run this from this folder, then open http://localhost:8000/?city=mumbai. Opening `index.html` directly from disk won't work.

## Deploy
```bash
npx vercel@65.7.0 deploy --prod
```
`cities/` and `tools/` are not uploaded (see `.vercelignore`); only the app and `data/` are.

## Files
- `index.html`, `styles.css`, `app.js`: the app (plain JavaScript and MapLibre GL JS 4.7.1). Everything city-specific is read from `data/<city>/`.
- `data/cities.json`: list of cities for the switcher.
- `data/<city>/`:
  - `manifest.json`: levels, property types, units, labels and the ingest report.
  - `levels/*.geojson`: boundaries with government-rate medians.
  - `areas.json`, `societies.json`, `points.json`, `places.json`.
  - `heights/`: building-height tiles.
- `cities/<city>/`: `city.json`, `raw/*.csv` and `boundaries/`.
- `tools/`:
  - `ingest.py`: CSV to map data.
  - `fetch_boundaries.py`: one-time boundary download; needs `shapely`.
  - `build_heights.py`: building heights; needs `rasterio numpy s2sphere`.
  - `sample_csv.py`: sample CSVs for Bengaluru and Delhi.
  - `requirements.txt`: optional dependencies for `fetch_boundaries.py` and `build_heights.py`.

## How the map works
- **Levels.** Each city's polygon levels fade into one another as you zoom. Point levels (areas, colonies, localities) appear next, then pins. Mumbai pins are societies; click one for every configuration and its source link.
- **Medians.** Every area shows the median. Where societies exist, it's the median of society medians, and "low confidence" means fewer than 3 societies, so one big project can't dominate. Elsewhere, "low confidence" means fewer than 5 data points.
- **Colours.** 10 percentile steps from the ward level (blue = cheaper, red = pricier), shared by every level.
- **Buildings.** Each building is coloured by the prices within about 1 km (nearer points count more) and stands at its real height from Google Open Buildings 2.5D (2023).
- **Filters.** Only property types and deals that exist in the data are offered. The BHK filter appears when the data has BHK.
- **Guided tour.** The **Tour** button builds itself from each city's data: levels, priciest ward, its top area, a society or street, then other types.

## Known limits
- **Mumbai batch 1:** SquareYards and Housing.com prices are asking prices, not registered deals. 3,000 rows had no price and were skipped. Using scraped portal data commercially carries legal risk (see the data report).
- **Mumbai wards:** 580 rows' `bmc_ward` differs from the ward at their coordinates. The file's ward appears to be set per area name; the map uses coordinates.
- **Delhi wards** are the pre-2022 delimitation; Delhi now has 250 wards.
- **Building heights** are satellite estimates (2023). Buildings missing from OpenStreetMap don't appear.
