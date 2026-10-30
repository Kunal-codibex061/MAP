# Delhi property master (map handoff)

Finalized **2026-10-30** (Asia/Calcutta) from `"+MASTER.name+"`.

## Deliverables in this folder

| File | Role |
|------|------|
| `delhi_master_clean.csv` | Slim master (12,315 rows). Source of truth for this handoff. |
| `delhi_society_pins.csv` | Best first pass: priced + `geo_precision=society` (**4** rows — sparse). |
| `delhi_map_pins.csv` | All priced pins in NCT bbox with sane ₹/sqft (**2,558** rows; mostly area centroids). |
| `points_for_map.json` | Packed to live `/data/delhi/points.json` field schema (**2,608** points). |
| `points_for_map.meta.json` | Skip counts and stacking warning. |
| `societies_for_map.json` | Society list (**3,247**) matching `soc` indices; extras include rate summary. |
| `manifest_delhi_suggested.json` | Suggested manifest with `sample: false` (types/counts from this pack). |
| `README_columns.md` | This file. |
| `HANDOFF.md` | Paste-ready brief for an AI coding agent. |

## `delhi_master_clean.csv` columns

```
city,district,zone,area,sub_area,block_or_pocket,society_or_layout,row_level,property_type,source,bhk,area_sqft_min,area_sqft_max,total_price_min,total_price_max,price_per_sqft,price_per_sqyd,rent_monthly_min,rent_monthly_max,listing_count,circle_rate_category,circle_rate_per_sqm,as_of,url,lat,lon,geo_precision,map_locality_name,map_locality_id,map_district_id,map_ward_id
```

| Column | Meaning |
|--------|---------|
| `city` | Delhi / NCT |
| `district` | Revenue district (South West, East, …) |
| `zone` | MCD zone when known |
| `area` / `sub_area` / `block_or_pocket` | Locality hierarchy |
| `society_or_layout` | Project / society / DDA complex name |
| `row_level` | area \| sub_area \| society \| config |
| `property_type` | apartment \| DDA flat \| builder floor \| plot \| independent house |
| `source` | Origin page family for this row |
| `bhk` | e.g. 2BHK |
| `area_sqft_min` / `area_sqft_max` | Size band |
| `total_price_min` / `total_price_max` | INR totals |
| `price_per_sqft` / `price_per_sqyd` | Sale rates (`sqyd = sqft × 9`) |
| `rent_monthly_min` / `rent_monthly_max` | When source exposes rent |
| `listing_count` | Sample size when known |
| `circle_rate_category` / `circle_rate_per_sqm` | Delhi colony category A–H official floor |
| `as_of` | Scrape / gazette date |
| `url` | Source page |
| `lat` / `lon` | WGS84 |
| `geo_precision` | society \| block \| sector \| area \| area_approx |
| `map_locality_name` / `map_locality_id` | Join to live `areas.json` (ids 0–237) when matched |
| `map_district_id` / `map_ward_id` | From `areas.json` parents or district name match |

Dropped: `notes`, `geo_source` (debug).

## Sources

| Source tag | What it contributes |
|-----------|---------------------|
| SquareYards Projects / BHK summary | New-project societies + BHK configs |
| Magicbricks Society/Project + Property-Rates-Trends | Societies + locality rates |
| Housing.com price-trends | Locality ₹/sqft |
| Delhi Revenue Dept circle rates | Colony category A–H land rates (Rs/sqm→Rs/sqft ÷10.764) |
| Cross-site society audit (MB / DDA_CGHS) | Society names (often unpriced) |

**Rule:** never invent prices or coordinates. Missing values stay blank.

## Known gaps

- Only **~4** priced rows have `geo_precision=society`. Most pins sit on area centroids.
- Price filled on **~2,883** / 12,315 master rows.
- Lat/lon on **~5,992** / 12,315 rows.
- Live map `areas.json` has **238** colonies; master has **495** area names — many unmatched (sectors/pockets). Unmatched pins still plot by lat/lon with `area=-1`.
- Overnight scrape froze ~12:50–03:40 IST 2026-10-30; dataset is a prototype snapshot.
