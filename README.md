# Property Price Map — prototype (Bengaluru · Mumbai · Delhi)

A map of what property costs, from city-wide areas down to individual streets and societies.

| City | Data | Levels |
|---|---|---|
| **Mumbai** | **Real, v2 (batches 1–4)**: SquareYards, Magicbricks, NoBroker and Housing.com listings, Maharashtra IGR ready reckoner (29 Oct 2026) | Region → BMC ward → Area → Society |
| **Bengaluru** | **Real**: SquareYards and Magicbricks project listings, Housing.com area averages, Karnataka IGR guidance values (Gazette 30 Sep 2023) | GBA corporation → Zone → Ward → Locality → Society |
| **Delhi** | **Real**: SquareYards and Magicbricks project listings, Housing.com price trends, Delhi Revenue Department circle rates (2014; listings 29 Oct 2026) | District → Ward → Colony → Society |

The map draws 15,758 Bengaluru points (5,698 priced societies), 13,572 Mumbai points
(7,881 priced societies) and 1,114 Delhi points (160 priced societies); another 13,020,
17,177 and 3,087 societies are searchable without prices.

Live: https://bengaluru-price-map.vercel.app (`/mumbai`, `/delhi`, `/bengaluru`). Locally: `?city=mumbai`.

## Adding or updating data (the normal workflow)

All cities use the same broad CSV shape: the columns of `mumbai_master_v2_final.csv`.
Bengaluru's master uses `society_name` instead of `society_or_layout`. Its `guidance_value`
column is ₹ per sq ft and is deliberately not treated as a per-sq-m rate; Karnataka IGR rows
are recognised by their source name and use `price_per_sqft`.

1. Put the CSV file(s) in `cities/<city>/raw/`. Every CSV in that folder is merged, so add a new batch next to the existing one rather than replacing it. Bengaluru and Mumbai use their real masters; Delhi uses `delhi_master_clean.csv` plus the handoff pack, built with `python3 tools/build_delhi.py` (its source has many rows without coordinates, so the general ingest would produce a much smaller market set).
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
| `society` | A society summary. Ignored when that society already has unit rows, so nothing is counted twice. Priced societies get a map pin; unpriced ones are listed for search only |
| `area` / `sub_area` with `ready_reckoner_rate_per_sqm` (or a source mentioning ready reckoner / circle rate) | The area's government rate, shown as "Market vs ready reckoner / circle rate" |
| other `area` rows (e.g. Housing.com averages) | "Other published averages" in the area panel; not counted in the medians |

Cleaning steps:
- Rows without coordinates, inside a city's box or with an unknown property type are skipped.
- **Corrupt coordinates** are skipped and counted: `lat == lon`, swapped lat/lon, out of range, or implausible for the city.
- **Duplicates** are removed: the same society, configuration, size and price within 2%, or the same spot within 50 m.
- **Outliers** are removed: prices outside 0.3–3× the area median.
- **Dates** are normalised to ISO at the start of their period (`2026`, `2026-10`, `Jul-Sep 2026`, `1 Oct 2023`). **BHK** spellings are collapsed to `2BHK`, `3BHK`, `1RK`, …; multi-configuration strings such as `2,3` keep the first number (lossy).
- Wards come from each point's **coordinates**. Mumbai's CSV ward is only a cross-check and a fallback; Bengaluru's ward boundary codes use a different numbering, so no cross-check is applied there.

Column names are matched loosely (`bmc_ward`/`ward`/`mcd_ward`, `society_or_layout`/`society_name`, `lat`/`latitude`, …; see `ALIASES` in `tools/ingest.py`). Missing optional columns are fine.

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
This is a static site: `vercel.json` sets `framework: null`, and `cities/` and `tools/`
are not uploaded (see `.vercelignore`); only the app and `data/` are. If the Vercel
project was created with a Python preset (the repo has Python tools), set
**Settings → Build & Development Settings → Framework Preset** to **Other** once, then
redeploy.

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
  - `build_delhi.py`: Delhi handoff build (market pins + circle-rate guidance).
  - `fetch_boundaries.py`: one-time boundary download; needs `shapely`.
  - `build_heights.py`: building heights; needs `rasterio numpy s2sphere`.
  - `sample_csv.py`: sample CSVs for a city without real data (Delhi).
  - `optional-requirements.txt`: optional dependencies for `fetch_boundaries.py` and `build_heights.py`.

## How the map works
- **Levels.** Each city's polygon levels fade into one another as you zoom. Point levels (areas, colonies, localities) appear next, then pins. Mumbai, Bengaluru and Delhi pins are societies; click one for every configuration and its source link.
- **Society pins.** Only priced societies are pinned (5,698 in Bengaluru, 7,881 in Mumbai, 160 in Delhi). Societies without prices are searchable and open a "no price yet" panel. Where many societies share a locality centroid, pins are fanned slightly on a golden-angle spiral for display; panels disclose when a location is approximate.
- **Medians.** Every area shows the median. Where societies exist, it's the median of society medians, and "low confidence" means fewer than 3 societies, so one big project can't dominate. Elsewhere, "low confidence" means fewer than 5 data points.
- **Colours.** 10 percentile steps from the ward level (blue = cheaper, red = pricier), shared by every level.
- **Buildings.** Each building is coloured by the prices within about 1 km (nearer points count more) and stands at its real height from Google Open Buildings 2.5D (2023).
- **Filters.** Only property types and deals that exist in the data are offered. The BHK filter appears when the data has BHK.
- **Search.** Choosing a result highlights the boundary that contains it — the ward, zone or district polygon itself, or the containing ward for a locality, society, street or landmark — and opens its details.
- **Guided tour.** The **Tour** button builds itself from each city's data: levels, priciest ward, its top area, a society or street, then other types.

## Known limits
- **Mumbai:** asking prices, not registered deals. 5,247 rows had no coordinates and 9 had corrupt coordinates, so they are not on the map; the CSV ward differs from the coordinate's ward on 1,164 rows (the map uses coordinates). 3,209 priced rows are above ₹50,000/sq ft; the 0.3–3× area-median rule trims the implausible ones, but prime-area medians stay high. Using scraped portal data commercially carries legal risk (see `data/<city>/report.json`).
- **Bengaluru:** 43,755 of 49,792 rows are located at their locality or sub-locality centroid, not the building (2,589 distinct coordinates overall). Pins are spread where several societies share one point. 2,812 cleaned points (about 18%) fall outside the BBMP ward polygons, mostly in the Outskirts; they still appear as pins and area data.
- **Delhi:** real listings and circle rates, but only about 5,990 of 12,315 rows have coordinates (6,323 cannot be placed). 1,494 circle-rate rows are kept as guidance, not as market pins. Only 3 of the 160 priced societies have society-level coordinates, so most Delhi pins are locality/sector centroids fanned out for clicking. 207 points have no matching ward polygon (district is still assigned). No rent data.
- **No rent data** in any real master, so the Rent switch is disabled.
- **Building heights** are satellite estimates (2023) and the tiles cover the previous city boxes; buildings on the new outskirts are flat.
- **Raw masters:** the three real CSVs are tracked in Git (~33 MB) for reproducibility, but are excluded from Vercel deploys.
