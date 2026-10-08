"""Build data/build/ridings.v1.json.gz: one row per federal riding of the 2023 Representation Order.

    make ridings      (after layers and atlas: reads places.v1, layers/ridings.v1 and atlas.v1)

A unit table (format "meridian.unitTable", contract docs/schemas/unitTable.schema.json). House of
Cards plays on ridings, and only 215 of the 343 own a mesh cell, so every value here is built from the
census and boundary sources directly, never from mesh cells or attrs.

Methods:
- land: the Elections Canada polygon, which runs out to sea, intersected with the 2021 cartographic
  CSDs, which stop at the shore. `areaKm2` is its area; shares of a riding's area are shares of it.
- DAs: each 2021 DA's representative point (census.da_points) goes to the riding polygon holding it,
  else the nearest riding; its CSD and CMA/CA class are found as attributes.py finds them.
- population: each CSD's 2021 total apportioned over the ridings of its DAs by DA population (largest
  remainder, ties to the lower riding number), as attrs apportions it over cells; a CSD with people
  but no DA point is spread by its land in each riding. The ridings sum to the CSD totals.
- shares: DA counts summed over the riding (attributes.language_counts), then divided; a riding with
  no usable DA data takes the counts of its CSDs, weighted by each CSD's population share in it.
- labour by industry: each CSD's labour force by NAICS sector, spread over ridings by the CSD's
  population share in each (land share where the CSD has no people), as attrs spreads it over cells.
- score (docs/interop.md, "Scores for games"): population; gdp, allocation_v1 at riding level
  (provincial GDP by sector x the riding's share of the province's labour force in that sector, by
  population for a sector with no labour force in the province); resource_index, the NAICS 11 + 21
  share of the riding's labour force; exposure, its largest sector's share. cohesion is omitted: it is
  a variance over a region's sub-units, each lens column scaled over a split's scope, and a riding
  table has neither a split nor a scope.
- urbanClass: plurality of the riding's DA population by class (CMA 3, CA 2), else rural 1 if land
  density >= attributes.RURAL_DENSITY, else remote 0. industryDominant: the largest sector.
- places: each places.v1 place goes to the riding polygon holding its point, else the nearest riding.
- neighbours: ridings sharing an arc in layers/ridings.v1.topojson.gz.
- jurisdictions: for each interval between atlas event dates from 1867-07-01, the de jure unit whose
  drawing covers the largest share of the riding's land (an area overlap, never a point test: the
  atlas coast is simplified), consecutive intervals merged where unit, name, status and sovereign
  agree, `share` the smallest over the merged span. Where no unit overlaps the riding, the nearest
  unit, with share 0 and fallback: true.
"""

from __future__ import annotations

import json
import resource
import sys
import time
from collections import defaultdict

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from attributes import (
    C_ID_INDIG,
    C_ID_TOTAL,
    C_IMM,
    C_IMM_TOTAL,
    C_LF_SECTOR,
    C_MT_EN,
    C_MT_EN_FR,
    C_MT_EN_FR_NO,
    C_MT_EN_NO,
    C_MT_FR,
    C_MT_FR_NO,
    C_MT_INDIG,
    C_MT_NONOFF,
    C_MT_TOTAL,
    C_POP,
    NAICS_LABELS,
    NAICS_SECTORS,
    RURAL_DENSITY,
    URBAN_CLASSES,
    apportion,
    language_counts,
    load_csds,
    read_gdp_table,
)
from census import da_points, load_profile, release_memory
from common import BUILD, EQUAL_AREA_CRS, MESH_VERSION, WGS84, load_manifest, raw_file, write_json_gz
from geo import nearest_key, points_within, read_vector, zip_dataset
from unittables import (
    ATLAS_PATH,
    PROVINCES,
    START,
    arc_neighbours,
    intersect_pieces,
    jurisdictions,
    load_gz,
)

UNIT = "fed_2023"
TABLE_VERSION = 1
RIDINGS_PATH = BUILD / "ridings.v1.json.gz"
RIDINGS_LAYER = BUILD / "layers" / f"ridings.{MESH_VERSION}.topojson.gz"
PLACES_PATH = BUILD / f"places.{MESH_VERSION}.json.gz"

# Mirrors UNIT_GDP_CAVEAT in app/src/schema/unitTable.ts, whose schema requires this exact text.
GDP_CAVEAT = (
    "GDP is an estimate: provincial GDP by industry shared over ridings by census labour force "
    "(allocation_v1), not a measurement of what a riding produces."
)
SOURCES = [
    "elections_fed_2023",
    "statcan_csd_2021",
    "statcan_da_2021",
    "statcan_cma_2021",
    "statcan_profile_da_2021",
    "statcan_profile_csd_2021",
    "statcan_gdp_36100711",
]
DA_CHARACTERISTICS = [
    C_POP, C_MT_TOTAL, C_MT_EN, C_MT_FR, C_MT_NONOFF, C_MT_INDIG, C_MT_EN_FR, C_MT_EN_NO, C_MT_FR_NO,
    C_MT_EN_FR_NO, C_ID_TOTAL, C_ID_INDIG, C_IMM_TOTAL, C_IMM,
]  # fmt: skip
SHARE_KEYS = [  # (row key, numerator, denominator) over attributes.language_counts
    ("english", "en", "mt_total"),
    ("french", "fr", "mt_total"),
    ("indigenous_language", "indig", "mt_total"),
    ("indigenous_identity", "id_indig", "id_total"),
    ("immigrant", "imm", "imm_total"),
]
EXTRACTIVE = ["11", "21"]


def log(message: str) -> None:
    peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    print(f"[ridings {time.strftime('%H:%M:%S')} peak {peak_mb:,.0f} MB] {message}", flush=True)


# --- geometry -------------------------------------------------------------------------------


def load_feds() -> gpd.GeoDataFrame:
    feds = read_vector(zip_dataset(raw_file("elections_fed_2023"), r"\.shp$")).to_crs(EQUAL_AREA_CRS)
    feds["fed"] = feds["FED_NUM"].astype(int)
    feds["geometry"] = shapely.make_valid(feds.geometry.to_numpy())
    feds = feds.sort_values("fed", kind="stable").reset_index(drop=True)
    return feds[["fed", "ED_NAMEE", "ED_NAMEF", "geometry"]]


def keys_of_points(points: gpd.GeoSeries, gdf: gpd.GeoDataFrame, key: str) -> tuple[list, int]:
    """The key of the polygon holding each point (smallest key on a shared edge), else of the nearest
    polygon. Returns (keys by position, how many fell back to the nearest)."""
    found = points_within(points, gdf, key)
    missing = [i for i in range(len(points)) if i not in found.index]
    for i, k in zip(missing, nearest_key(points.iloc[missing], gdf, key), strict=True):
        found.loc[i] = k
    return [found[i] for i in range(len(points))], len(missing)


# --- census ---------------------------------------------------------------------------------


def spread(weights_of: dict[str, tuple[np.ndarray, np.ndarray]], table: pd.DataFrame, n: int) -> np.ndarray:
    """Sum each CSD's row of `table` over riding positions, by that CSD's weights (summing to 1)."""
    out = np.zeros((n, table.shape[1]))
    for csd, (idx, weights) in sorted(weights_of.items()):
        if csd in table.index:
            out[idx] += np.outer(weights, np.nan_to_num(table.loc[csd].to_numpy(dtype=np.float64), nan=0.0))
    return out


def population(da: pd.DataFrame, csd_pop: pd.Series, land_of: dict, fed_pos: dict[int, int]) -> np.ndarray:
    """attributes.population_columns over ridings instead of cells."""
    out = np.zeros(len(fed_pos), dtype=np.int64)
    per = da.groupby(["csd", "fed"], as_index=False, sort=True)["pop"].sum()
    for csd, group in per.groupby("csd", sort=True):
        total = csd_pop.get(csd)
        if total is None or np.isnan(total):
            total = group["pop"].sum()
        feds = group["fed"].to_numpy()
        out[[fed_pos[f] for f in feds]] += apportion(group["pop"].to_numpy(), int(round(total)), feds)
    seen = set(per["csd"])
    for csd, total in csd_pop.dropna().items():
        if csd in seen or total <= 0 or csd not in land_of:
            continue
        feds, weights = land_of[csd]
        out[[fed_pos[f] for f in feds]] += apportion(weights, int(round(total)), feds)
    return out


def gdp_by_riding(provinces: np.ndarray, labour: np.ndarray, people: np.ndarray) -> tuple[np.ndarray, str]:
    """allocation_v1 (attributes.gdp_column) over ridings: every province's ridings sum to its total."""
    if "statcan_gdp_36100711" not in load_manifest():
        raise FileNotFoundError(
            "statcan_gdp_36100711 not downloaded: run the Fetch StatCan GDP table workflow, "
            "then make download"
        )
    gdp, year = read_gdp_table(raw_file("statcan_gdp_36100711"))
    out = np.zeros(len(provinces))
    for province in sorted(set(provinces)):
        mask = provinces == province
        prov_labour = labour[mask].sum(axis=0)
        for j, sector in enumerate(NAICS_SECTORS):
            value = gdp[(province, sector)]
            if prov_labour[j] > 0:
                out[mask] += value * labour[mask, j] / prov_labour[j]
            else:
                weights = people[mask].astype(np.float64)
                out[mask] += value * weights / weights.sum()
    return out, year


def urban_classes(da: pd.DataFrame, fed_pos: dict[int, int], people: np.ndarray, land_km2: np.ndarray):
    """attributes.urban_class_column over ridings, density over land area."""
    per = da.groupby(["fed", "cma_class"], as_index=False)["pop"].sum()
    per = per.sort_values(["fed", "pop", "cma_class"], ascending=[True, False, False], kind="stable")
    top = per.drop_duplicates("fed").set_index("fed")
    out = np.zeros(len(fed_pos), dtype=np.int64)
    for fed, i in fed_pos.items():
        k = int(top["cma_class"][fed]) if fed in top.index and top["pop"][fed] > 0 else 0
        out[i] = k if k else (1 if land_km2[i] > 0 and people[i] / land_km2[i] >= RURAL_DENSITY else 0)
    return out


# --- the table ------------------------------------------------------------------------------


def build() -> dict:
    # DA points first, while little else is resident: the DA read is this step's largest transient
    # allocation, as in attributes.py (docs/perf.md).
    log("DA representative points")
    points = da_points()
    release_memory()
    feds = load_feds()
    fed_ids = feds["fed"].tolist()
    fed_pos = {fed: i for i, fed in enumerate(fed_ids)}
    n = len(fed_ids)
    log(f"{n} ridings")

    csds = load_csds()
    cma = read_vector(raw_file("statcan_cma_2021"), crs=EQUAL_AREA_CRS, columns=["CMATYPE"])
    cma["k"] = cma["CMATYPE"].map({"B": 3, "K": 2, "D": 2}).astype(int)
    log("DA points → ridings, CSDs and CMA/CA classes")
    da_fed, da_fed_fallback = keys_of_points(points.geometry, feds, "fed")
    da_csd, _ = keys_of_points(points.geometry, csds, "csd")
    class_of = points_within(points.geometry, cma[["k", "geometry"]], "k")
    da = pd.DataFrame(
        {
            "dauid": points["dauid"].to_numpy(),
            "csd": da_csd,
            "fed": [int(f) for f in da_fed],
            "pop": points["population"].to_numpy(),
            "cma_class": [int(class_of.get(i, 0)) for i in range(len(points))],
        }
    )
    log(f"{len(da):,} DAs; {da_fed_fallback} outside every riding polygon, given the nearest")
    del points, cma, class_of
    release_memory()

    log("land: ridings × cartographic CSDs")
    land = intersect_pieces(feds, "fed", csds, "csd")
    del csds
    release_memory()
    land_m2 = np.zeros(n)
    for fed, a in land.groupby("a", sort=True)["area"].sum().items():
        land_m2[fed_pos[int(fed)]] = a
    if (land_m2 <= 0).any():
        raise ValueError(f"ridings with no land: {[fed_ids[i] for i in np.flatnonzero(land_m2 <= 0)]}")
    land_of: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for csd, g in land.groupby(["b", "a"], as_index=False, sort=True)["area"].sum().groupby("b", sort=True):
        land_of[csd] = (g["a"].to_numpy().astype(int), g["area"].to_numpy())

    da_prof = load_profile("statcan_profile_da_2021", DA_CHARACTERISTICS)
    csd_prof = load_profile("statcan_profile_csd_2021")
    people = population(da, csd_prof[C_POP], land_of, fed_pos)
    log(f"population {int(people.sum()):,}")

    # CSD → riding weights: population share where the CSD has people, else land share.
    weights_of: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    per = da.groupby(["csd", "fed"], as_index=False, sort=True)["pop"].sum()
    for csd, g in per.groupby("csd", sort=True):
        if g["pop"].sum() > 0:
            weights_of[csd] = (np.array([fed_pos[f] for f in g["fed"]]), g["pop"].to_numpy() / g["pop"].sum())
    for csd, (feds_of, areas) in land_of.items():
        if csd not in weights_of and areas.sum() > 0:
            weights_of[csd] = (np.array([fed_pos[f] for f in feds_of]), areas / areas.sum())

    log("shares")
    counts = language_counts(da_prof).reindex(da["dauid"]).reset_index(drop=True)
    counts["fed"] = da["fed"].to_numpy()
    sums = counts.groupby("fed").sum(min_count=1).reindex(fed_ids)
    csd_counts = language_counts(csd_prof)
    fallback = pd.DataFrame(spread(weights_of, csd_counts, n), columns=csd_counts.columns, index=fed_ids)
    ratios: dict[str, np.ndarray] = {}
    no_da = 0
    for key, num, den in SHARE_KEYS:
        value = (sums[num] / sums[den]).where(sums[den] > 0)
        no_da += int(value.isna().sum())
        backup = (fallback[num] / fallback[den]).where(fallback[den] > 0)
        ratios[key] = value.fillna(backup).fillna(0.0).clip(0, 1).to_numpy()
    if no_da:
        log(f"{no_da} riding shares from CSD counts (no usable DA data)")
    other = np.clip(1.0 - ratios["english"] - ratios["french"] - ratios["indigenous_language"], 0, 1)

    log("industry and GDP")
    sector_ids = [C_LF_SECTOR[s] for s in NAICS_SECTORS]
    labour = spread(weights_of, csd_prof.reindex(columns=sector_ids), n)
    totals = labour.sum(axis=1)
    if (totals <= 0).any():
        raise ValueError(f"ridings with no labour force: {[fed_ids[i] for i in np.flatnonzero(totals <= 0)]}")
    industry = labour / totals[:, None]
    provinces = np.array([PROVINCES[str(fed)[:2]] for fed in fed_ids])
    gdp, gdp_year = gdp_by_riding(provinces, labour, people)
    land_km2 = land_m2 / 1e6
    urban = urban_classes(da, fed_pos, people, land_km2)
    del da, da_prof, csd_prof
    release_memory()

    log("places")
    places = load_gz(PLACES_PATH)["places"]
    place_points = gpd.GeoSeries(
        gpd.points_from_xy([p["lng"] for p in places], [p["lat"] for p in places]), crs=WGS84
    ).to_crs(EQUAL_AREA_CRS)
    place_fed, place_fallback = keys_of_points(place_points, feds, "fed")
    places_of: dict[int, list[dict]] = defaultdict(list)
    for place, fed in zip(places, place_fed, strict=True):
        entry = {"csd": place["csd"], "name": place["name"], "population": place["population"]}
        places_of[int(fed)].append(entry)
    log(f"{len(places):,} places; {place_fallback} outside every riding polygon, given the nearest")

    neighbours = arc_neighbours(load_gz(RIDINGS_LAYER), "ridings", "fed")

    log("jurisdictions")
    spans = jurisdictions(
        fed_ids, feds.geometry.to_numpy(), land["a"].to_numpy(), land["geometry"].to_numpy(), land_m2, log
    )
    del land
    release_memory()

    rows = []
    extractive = [NAICS_SECTORS.index(s) for s in EXTRACTIVE]
    for i, r in enumerate(feds.itertuples()):
        top = int(np.argmax(industry[i]))
        rows.append(
            {
                "id": int(r.fed),
                "name": r.ED_NAMEE,
                "nameFr": r.ED_NAMEF,
                "province": str(provinces[i]),
                "population": int(people[i]),
                "areaKm2": round(float(land_km2[i]), 2),
                "score": {
                    "population": int(people[i]),
                    "gdp": int(round(gdp[i])),
                    "resource_index": round(float(industry[i, extractive].sum()), 3),
                    "exposure": round(float(industry[i, top]), 3),
                },
                "shares": {
                    "english": round(float(ratios["english"][i]), 4),
                    "french": round(float(ratios["french"][i]), 4),
                    "indigenous_language": round(float(ratios["indigenous_language"][i]), 4),
                    "other_language": round(float(other[i]), 4),
                    "indigenous_identity": round(float(ratios["indigenous_identity"][i]), 4),
                    "immigrant": round(float(ratios["immigrant"][i]), 4),
                },
                "urbanClass": int(urban[i]),
                "industryDominant": int(NAICS_SECTORS[top][:2]),
                "places": sorted(places_of[int(r.fed)], key=lambda p: (-p["population"], p["csd"])),
                "neighbours": neighbours.get(int(r.fed), []),
                "jurisdictions": spans[i],
            }
        )

    from polygons import attribution_rows

    return {
        "format": "meridian.unitTable",
        "version": TABLE_VERSION,
        "unit": UNIT,
        "meta": {
            "unitName": "Federal electoral districts, 2023 Representation Order",
            "censusYear": 2021,
            "gdpMethod": "allocation_v1",
            "gdpReferenceYear": gdp_year,
            "gdpPrices": "current_dollars_basic_prices",
            "atlasVersion": atlas_version(),
            "jurisdictionsFrom": START,
            "sources": attribution_rows(SOURCES),
        },
        "gdpCaveat": GDP_CAVEAT,
        "lookups": {
            "urbanClass": {str(k): v for k, v in URBAN_CLASSES.items()},
            "industryDominant": {s[:2]: NAICS_LABELS[s] for s in NAICS_SECTORS},
        },
        "rows": rows,
    }


def atlas_version() -> str:
    return json.loads(ATLAS_PATH.read_text(encoding="utf-8"))["version"]


def main() -> int:
    table = build()
    write_json_gz(RIDINGS_PATH, table)
    log(f"wrote {RIDINGS_PATH} ({RIDINGS_PATH.stat().st_size:,} bytes, {len(table['rows'])} rows)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
