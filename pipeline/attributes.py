"""Build data/build/attrs.v1.json.gz: present-day attribute columns for every mesh cell.

    make attrs        (requires mesh.v1.json.gz)

Named attributes.py, not attrs.py as in the plan: a module called attrs shadows the PyPI
`attrs` package that jsonschema imports.

Methods (each also recorded on its column as `method`):
- population (count): dasymetric. DA counts go to the H3 cell containing the DA's representative
  point, then each CSD's total is apportioned exactly (largest remainder) across the cells its DAs
  fell in. Sum over cells = sum of CSD totals. population_2016 spreads 2016 CSD totals with the same
  2021 DA weights (2016 counts are not published at DA level).
- language shares, indigenous_identity_share, immigrant_share (share): population-weighted from
  DAs in the cell. Multiple mother-tongue responses split equally among the languages named.
  Cells with no usable DA data take their CSD's shares.
- urban_class (id): plurality of the cell's population by DA class (CMA 3, CA 2); otherwise
  rural 1 if density >= RURAL_DENSITY persons/km², else remote 0.
- industry_share_<naics> and industry_dominant: CSD labour force by NAICS sector, allocated to
  cells by each CSD's population share in the cell (area share for unpopulated cells).
- gdp_estimate (money, cad_millions): provincial GDP by industry × the cell's share of the
  province's labour force in that industry, summed. Only when statcan_gdp_36100711 is present.
- overlay ids (ecozone_id, basin_id, ocean_drainage_id, subbasin_id, fed_riding_id, treaty_id,
  metis_settlement, inuit_region): largest area overlap; metis_settlement and inuit_region need
  >= MAJORITY of the cell. 0 = none. Labels in `lookups`.
- treaty_code (id): the largest of modern / numbered / other historic / unceded (no treaty),
  where modern agreements take precedence where they overlap historic treaties.
- reserve_share (share): Indian Reserve area / cell area.
- riding_party_2025 (id): party of the candidate elected in the cell's riding at the 45th GE.
- distance_to_capital_km (measure, km): great-circle distance from cell centre to the
  provincial or territorial capital.
"""

from __future__ import annotations

import csv
import io
import json
import math
import re
import sys
import time
import zipfile
from collections import defaultdict

import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import shapely

from census import da_points, load_profile
from columns import MONEY_UNIT, check_column_name, encode_column, file_meta
from common import BUILD, EQUAL_AREA_CRS, MESH_VERSION, WGS84, load_manifest, raw_file, write_json_gz
from geo import cell_polygons, largest, nearest_key, overlap_areas, points_within, read_vector, zip_dataset
from mesh import MESH_PATH

ATTRS_PATH = BUILD / f"attrs.{MESH_VERSION}.json.gz"
RURAL_DENSITY = 0.4  # persons per km²; below this a non-urban cell is "remote"
MAJORITY = 0.5
EARTH_RADIUS_KM = 6371.0088

CAPITALS = {  # legislature locations (lat, lng)
    "NL": (47.5615, -52.7126),
    "PE": (46.2382, -63.1311),
    "NS": (44.6488, -63.5752),
    "NB": (45.9636, -66.6431),
    "QC": (46.8081, -71.2143),
    "ON": (43.6629, -79.3957),
    "MB": (49.8844, -97.1470),
    "SK": (50.4321, -104.6153),
    "AB": (53.5335, -113.5064),
    "BC": (48.4197, -123.3700),
    "YT": (60.7197, -135.0523),
    "NT": (62.4540, -114.3718),
    "NU": (63.7467, -68.5170),
}

# Census Profile characteristic ids (statcan_profile_*_2021).
C_POP, C_POP16 = 1, 2
C_MT_TOTAL, C_MT_EN, C_MT_FR, C_MT_NONOFF, C_MT_INDIG = 379, 382, 383, 384, 385
C_MT_EN_FR, C_MT_EN_NO, C_MT_FR_NO, C_MT_EN_FR_NO = 705, 706, 707, 708
C_ID_TOTAL, C_ID_INDIG = 1388, 1389
C_IMM_TOTAL, C_IMM = 1513, 1515
C_LF_ALL = 2261
NAICS_SECTORS = [
    "11", "21", "22", "23", "31_33", "41", "44_45", "48_49", "51", "52",
    "53", "54", "55", "56", "61", "62", "71", "72", "81", "91",
]  # fmt: skip
C_LF_SECTOR = {sector: 2262 + i for i, sector in enumerate(NAICS_SECTORS)}
NAICS_LABELS = {
    "11": "Agriculture, forestry, fishing and hunting", "21": "Mining, quarrying, and oil and gas extraction",
    "22": "Utilities", "23": "Construction", "31_33": "Manufacturing", "41": "Wholesale trade",
    "44_45": "Retail trade", "48_49": "Transportation and warehousing",
    "51": "Information and cultural industries",
    "52": "Finance and insurance", "53": "Real estate and rental and leasing",
    "54": "Professional, scientific and technical services", "55": "Management of companies and enterprises",
    "56": "Administrative and support, waste management and remediation services",
    "61": "Educational services",
    "62": "Health care and social assistance", "71": "Arts, entertainment and recreation",
    "72": "Accommodation and food services", "81": "Other services (except public administration)",
    "91": "Public administration",
}  # fmt: skip

PARTIES = [  # (code, Elections Canada label suffix, short label)
    (1, "Liberal/Libéral", "Liberal"),
    (2, "Conservative/Conservateur", "Conservative"),
    (3, "Bloc Québécois/Bloc Québécois", "Bloc Québécois"),
    (4, "NDP-New Democratic Party/NPD-Nouveau Parti démocratique", "NDP"),
    (5, "Green Party/Parti Vert", "Green"),
    (6, "People's Party - PPC/Parti populaire - PPC", "People's Party"),
    (7, "Independent/Indépendant(e)", "Independent"),
    (8, "No Affiliation/Aucune appartenance", "No affiliation"),
]

TREATY_CODES = {
    0: "none (open water)",
    1: "numbered treaty",
    2: "other historic treaty",
    3: "modern treaty",
    4: "unceded (no treaty)",
}
URBAN_CLASSES = {0: "remote", 1: "rural", 2: "small urban (CA)", 3: "CMA"}


def log(message: str) -> None:
    print(f"[attrs {time.strftime('%H:%M:%S')}] {message}", flush=True)


# --- inputs ---------------------------------------------------------------------------------


def load_mesh() -> dict:
    import gzip

    with gzip.open(MESH_PATH, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def load_csds() -> gpd.GeoDataFrame:
    gdf = read_vector(raw_file("statcan_csd_2021"), crs=EQUAL_AREA_CRS)
    gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
    return gdf.rename(columns={"CSDUID": "csd"}).sort_values("csd", kind="stable")


# --- helpers --------------------------------------------------------------------------------


def apportion(weights: np.ndarray, total: int, tiebreak: np.ndarray) -> np.ndarray:
    """Integers proportional to weights summing exactly to total (largest remainder)."""
    if total == 0:
        return np.zeros(len(weights), dtype=np.int64)
    w = weights.astype(np.float64)
    if w.sum() <= 0:
        w = np.ones(len(weights))
    exact = w * total / w.sum()
    base = np.floor(exact).astype(np.int64)
    short = int(total - base.sum())
    order = np.lexsort((tiebreak, -(exact - base)))
    base[order[:short]] += 1
    return base


def haversine_km(lat1, lng1, lat2, lng2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def id_from_overlap(
    polys: gpd.GeoSeries, gdf: gpd.GeoDataFrame, key: str, min_share: float = 0.0
) -> np.ndarray:
    overlaps = overlap_areas(polys, gdf, key)
    out = np.zeros(len(polys), dtype=np.int64)
    if overlaps.empty:
        return out
    best = largest(overlaps)
    areas = polys.area.to_numpy()
    for cell, row in best.iterrows():
        if row["area"] / areas[cell] >= min_share:
            out[cell] = int(row["key"])
    return out


def subbasin_name(sub: object, major: object) -> str:
    """Some NHN work units have no sub-drainage name (e.g. 050 Lake Winnipeg); use the major area."""
    for name in (sub, major):
        if isinstance(name, str) and name.strip():
            return name.strip()
    return "unnamed"


def cells_of_points(
    lats: np.ndarray, lngs: np.ndarray, mesh_cells: list[dict], index: dict[str, int]
) -> list[int]:
    """Mesh cell containing each point; points outside the mesh (tiny offshore islands such as
    Sable Island) go to the nearest mesh cell centre by great-circle distance, ties by index."""
    out = []
    centres = np.radians(np.array([[c["centroid"][1], c["centroid"][0]] for c in mesh_cells]))
    for lat, lng in zip(lats, lngs, strict=True):
        cell = h3.latlng_to_cell(lat, lng, 5)
        if cell in index:
            out.append(index[cell])
            continue
        p = np.radians([lat, lng])
        a = (
            np.sin((centres[:, 0] - p[0]) / 2) ** 2
            + np.cos(p[0]) * np.cos(centres[:, 0]) * np.sin((centres[:, 1] - p[1]) / 2) ** 2
        )
        out.append(int(np.argmin(a)))
    return out


# --- builders -------------------------------------------------------------------------------


def das_to_cells(
    mesh: dict, index: dict[str, int], csds: gpd.GeoDataFrame, cma: gpd.GeoDataFrame
) -> pd.DataFrame:
    das = da_points()
    points = das.geometry
    csd_of = points_within(points, csds, "csd")
    missing = [i for i in range(len(das)) if i not in csd_of.index]
    if missing:
        for i, csd in zip(missing, nearest_key(points.iloc[missing], csds, "csd"), strict=True):
            csd_of.loc[i] = csd
    cma = cma.copy()
    cma["cma_class"] = cma["CMATYPE"].map({"B": 3, "K": 2, "D": 2}).astype(int)
    class_of = points_within(points, cma.rename(columns={"cma_class": "k"})[["k", "geometry"]], "k")
    wgs = points.to_crs(WGS84)
    cells = cells_of_points(wgs.y.to_numpy(), wgs.x.to_numpy(), mesh["cells"], index)
    return pd.DataFrame(
        {
            "dauid": das["dauid"].to_numpy(),
            "csd": [csd_of[i] for i in range(len(das))],
            "cell": cells,
            "cma_class": [int(class_of.get(i, 0)) for i in range(len(das))],
        }
    )


def population_columns(mesh, das, da_prof, csd_prof, cell_csd_weight) -> dict[str, np.ndarray]:
    n = len(mesh["cells"])
    out = {}
    # 2016 counts are not published at DA level (FLAG 2), so 2016 CSD totals are spread with
    # 2021 DA weights.
    for name, char in (("population", C_POP), ("population_2016", C_POP16)):
        da_vals = das["dauid"].map(da_prof[C_POP]).fillna(0).to_numpy()
        frame = pd.DataFrame({"csd": das["csd"], "cell": das["cell"], "w": da_vals})
        per = frame.groupby(["csd", "cell"], as_index=False, sort=True)["w"].sum()
        column = np.zeros(n, dtype=np.int64)
        for csd, group in per.groupby("csd", sort=True):
            total = csd_prof[char].get(csd)
            if total is None or np.isnan(total):
                total = group["w"].sum()
            column[group["cell"].to_numpy()] += apportion(
                group["w"].to_numpy(), int(round(total)), group["cell"].to_numpy()
            )
        # CSDs with a population but no DA point in the mesh: spread over their cells by area.
        seen = set(per["csd"])
        for csd, total in csd_prof[char].dropna().items():
            if csd in seen or total <= 0 or csd not in cell_csd_weight:
                continue
            cells, weights = cell_csd_weight[csd]
            column[cells] += apportion(weights, int(round(total)), cells)
        out[name] = column
    return out


def share_columns(mesh, das, da_prof, csd_prof) -> dict[str, np.ndarray]:
    def language_counts(prof: pd.DataFrame) -> pd.DataFrame:
        g = lambda c: prof[c].fillna(0) if c in prof else 0  # noqa: E731
        return pd.DataFrame(
            {
                "mt_total": prof[C_MT_TOTAL],
                "en": g(C_MT_EN) + g(C_MT_EN_FR) / 2 + g(C_MT_EN_NO) / 2 + g(C_MT_EN_FR_NO) / 3,
                "fr": g(C_MT_FR) + g(C_MT_EN_FR) / 2 + g(C_MT_FR_NO) / 2 + g(C_MT_EN_FR_NO) / 3,
                "indig": g(C_MT_INDIG),
                "id_total": prof[C_ID_TOTAL],
                "id_indig": prof[C_ID_INDIG],
                "imm_total": prof[C_IMM_TOTAL],
                "imm": prof[C_IMM],
            }
        )

    n = len(mesh["cells"])
    da = language_counts(da_prof).reindex(das["dauid"]).reset_index(drop=True)
    da["cell"] = das["cell"].to_numpy()
    sums = da.groupby("cell").sum(min_count=1).reindex(range(n))
    csd = language_counts(csd_prof)
    cell_csd = [c["csd"] for c in mesh["cells"]]
    fallback = csd.reindex(cell_csd).reset_index(drop=True)

    def ratio(num: str, den: str) -> np.ndarray:
        value = (sums[num] / sums[den]).where(sums[den] > 0)
        backup = (fallback[num] / fallback[den]).where(fallback[den] > 0)
        return value.fillna(backup).fillna(0.0).clip(0, 1).to_numpy()

    english, french, indigenous = ratio("en", "mt_total"), ratio("fr", "mt_total"), ratio("indig", "mt_total")
    return {
        "english_share": english,
        "french_share": french,
        "indigenous_language_share": indigenous,
        "other_language_share": np.clip(1.0 - english - french - indigenous, 0, 1),
        "indigenous_identity_share": ratio("id_indig", "id_total"),
        "immigrant_share": ratio("imm", "imm_total"),
    }


def urban_class_column(mesh, das, population) -> np.ndarray:
    n = len(mesh["cells"])
    frame = pd.DataFrame({"cell": das["cell"], "k": das["cma_class"], "w": das["pop"]})
    per = frame.groupby(["cell", "k"], as_index=False)["w"].sum()
    per = per.sort_values(["cell", "w", "k"], ascending=[True, False, False], kind="stable")
    top = per.drop_duplicates("cell").set_index("cell")
    out = np.zeros(n, dtype=np.int64)
    for i, cell in enumerate(mesh["cells"]):
        k = int(top["k"].get(i, 0)) if i in top.index and top["w"].get(i, 0) > 0 else 0
        if k:
            out[i] = k
        else:
            out[i] = 1 if population[i] / cell["area"] >= RURAL_DENSITY else 0
    return out


def industry_columns(mesh, csd_prof, cell_from_csd) -> tuple[dict[str, np.ndarray], np.ndarray, dict]:
    """cell_from_csd: csd → (cell indices, weights summing to 1 over the CSD)."""
    n = len(mesh["cells"])
    counts = np.zeros((n, len(NAICS_SECTORS)))
    by_cd: dict[str, np.ndarray] = defaultdict(lambda: np.zeros(len(NAICS_SECTORS)))
    sector_ids = [C_LF_SECTOR[s] for s in NAICS_SECTORS]
    table = csd_prof.reindex(columns=sector_ids)
    for csd, row in table.iterrows():
        if not row.isna().all():
            by_cd[csd[:4]] += row.fillna(0).to_numpy()
    for csd, (cells, weights) in sorted(cell_from_csd.items()):
        row = table.loc[csd].to_numpy() if csd in table.index else np.full(len(sector_ids), np.nan)
        counts[cells] += np.outer(weights, np.nan_to_num(row, nan=0.0))
    totals = counts.sum(axis=1)
    shares = np.zeros_like(counts)
    for i, cell in enumerate(mesh["cells"]):
        if totals[i] > 0:
            shares[i] = counts[i] / totals[i]
        else:  # no labour force data: use the census division's mix
            cd = by_cd.get(cell["cd"])
            if cd is not None and cd.sum() > 0:
                shares[i] = cd / cd.sum()
    columns = {f"industry_share_{s}": shares[:, j] for j, s in enumerate(NAICS_SECTORS)}
    dominant = np.array(
        [int(NAICS_SECTORS[int(np.argmax(shares[i]))][:2]) if shares[i].sum() > 0 else 0 for i in range(n)]
    )
    return columns, dominant, counts


GDP_PROVINCES = {
    "Newfoundland and Labrador": "NL", "Prince Edward Island": "PE", "Nova Scotia": "NS",
    "New Brunswick": "NB", "Quebec": "QC", "Ontario": "ON", "Manitoba": "MB", "Saskatchewan": "SK",
    "Alberta": "AB", "British Columbia": "BC", "Yukon": "YT",
    "Northwest Territories": "NT", "Nunavut": "NU",
}  # fmt: skip


def gdp_column(mesh, labour_counts, population) -> tuple[np.ndarray, str] | None:
    """allocation_v1: for each province and NAICS sector, the table's GDP is shared across the
    province's cells in proportion to the cell's census labour force in that sector. A sector
    with no census labour force in a province is shared by population instead, so every
    province's cells sum to the table's provincial total."""
    if "statcan_gdp_36100711" not in load_manifest():
        log("statcan_gdp_36100711 not present; gdp_estimate omitted")
        return None
    gdp, year = read_gdp_table(raw_file("statcan_gdp_36100711"))
    provinces = np.array([c["province"] for c in mesh["cells"]])
    out = np.zeros(len(mesh["cells"]))
    for province in sorted(set(provinces)):
        mask = provinces == province
        prov_labour = labour_counts[mask].sum(axis=0)
        for j, sector in enumerate(NAICS_SECTORS):
            value = gdp[(province, sector)]
            if prov_labour[j] > 0:
                out[mask] += value * labour_counts[mask, j] / prov_labour[j]
            else:
                weights = population[mask].astype(np.float64)
                out[mask] += value * weights / weights.sum()
    return out, year


def read_gdp_table(path) -> tuple[dict[tuple[str, str], float], str]:
    """(province, NAICS sector) → GDP at basic prices in millions of current dollars, for the latest
    reference year in which every province and territory has all 20 sectors (current-dollar
    values for recent years are published later than chained-dollar ones)."""
    with zipfile.ZipFile(path) as zf:
        member = next(m for m in zf.namelist() if re.fullmatch(r"\d{8}\.csv", m))
        rows = list(csv.DictReader(io.TextIOWrapper(zf.open(member), encoding="utf-8-sig")))
    naics_col = next(c for c in rows[0] if c.startswith("North American Industry Classification System"))
    prices_col = next((c for c in rows[0] if c.lower() == "prices"), None)
    by_year: dict[str, dict[tuple[str, str], float]] = defaultdict(dict)
    for r in rows:
        if r["GEO"] not in GDP_PROVINCES or not r["VALUE"]:
            continue
        if prices_col is not None and r[prices_col] != "Current dollars":
            continue
        code = re.search(r"\[(\d{2}(?:-\d{2})?)\]\s*$", r[naics_col])
        sector = code.group(1).replace("-", "_") if code else None
        if sector not in NAICS_SECTORS:
            continue
        scale = {"units": 1e-6, "thousands": 1e-3, "millions": 1.0}[
            r.get("SCALAR_FACTOR", "millions").lower()
        ]
        by_year[r["REF_DATE"]][(GDP_PROVINCES[r["GEO"]], sector)] = float(r["VALUE"]) * scale
    complete = [y for y, values in by_year.items() if len(values) == len(GDP_PROVINCES) * len(NAICS_SECTORS)]
    if not complete:
        raise ValueError("no reference year has current-dollar GDP for every province and sector")
    year = max(complete)
    log(f"GDP table: reference year {year} (latest complete in current dollars)")
    return by_year[year], year


def treaty_columns(polys) -> tuple[np.ndarray, np.ndarray, dict]:
    historic = read_vector(zip_dataset(raw_file("cirnac_historic_treaties"))).to_crs(EQUAL_AREA_CRS)
    modern = read_vector(zip_dataset(raw_file("cirnac_modern_treaties"))).to_crs(EQUAL_AREA_CRS)
    for gdf in (historic, modern):
        gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
    historic = historic.sort_values("TAG_ID", kind="stable").reset_index(drop=True)
    modern = modern.sort_values("TAG_ID", kind="stable").reset_index(drop=True)

    labels = {}
    tag_ids = {}
    for offset, gdf in ((1000, historic), (2000, modern)):
        for i, row in gdf.iterrows():
            tag_ids[row["TAG_ID"]] = offset + i + 1
            labels[str(offset + i + 1)] = row["ENAME"]
    historic["tid"] = historic["TAG_ID"].map(tag_ids)
    modern["tid"] = modern["TAG_ID"].map(tag_ids)

    modern_union = shapely.union_all(modern.geometry.to_numpy())
    historic["geometry"] = shapely.difference(historic.geometry.to_numpy(), modern_union)
    historic["kind"] = np.where(historic["SBTP_ENAME"].str.strip() == "Numbered Treaty", 1, 2)
    modern["kind"] = 3

    both = pd.concat(
        [historic[["tid", "kind", "geometry"]], modern[["tid", "kind", "geometry"]]], ignore_index=True
    )
    both = gpd.GeoDataFrame(both, geometry="geometry", crs=EQUAL_AREA_CRS)
    treaty_id = id_from_overlap(polys, both, "tid")
    by_kind = overlap_areas(polys, both.dissolve("kind", as_index=False), "kind")
    kind_area = np.zeros((len(polys), 5))
    for row in by_kind.itertuples():
        kind_area[row.cell, int(row.key)] = row.area
    return treaty_id, kind_area, labels


def overlay_inputs():
    eco = read_vector(raw_file("aafc_ecozones")).to_crs(EQUAL_AREA_CRS)
    eco = eco.dissolve("ECOZONE_ID", as_index=False)
    drainage_path = zip_dataset(raw_file("statcan_drainage_regions"), r"\.gdb/?$")
    drainage = read_vector(drainage_path).to_crs(EQUAL_AREA_CRS)
    return eco, drainage


def build() -> dict:
    mesh = load_mesh()
    cells = [c["id"] for c in mesh["cells"]]
    index = {cell: i for i, cell in enumerate(cells)}
    n = len(cells)
    log(f"{n:,} mesh cells")
    polys = cell_polygons(cells)
    areas_m2 = polys.area.to_numpy()

    csds = load_csds()
    cma = read_vector(raw_file("statcan_cma_2021"), crs=EQUAL_AREA_CRS)
    log("DA representative points → cells")
    das = das_to_cells(mesh, index, csds, cma)
    da_prof = load_profile("statcan_profile_da_2021")
    csd_prof = load_profile("statcan_profile_csd_2021")

    # Area weights of each CSD over mesh cells (for unpopulated fallbacks).
    csd_overlap = overlap_areas(polys, csds, "csd")
    cell_csd_weight = {
        csd: (g["cell"].to_numpy(), g["area"].to_numpy()) for csd, g in csd_overlap.groupby("key", sort=True)
    }

    log("population")
    pops = population_columns(mesh, das, da_prof, csd_prof, cell_csd_weight)
    population = pops["population"]
    das["pop"] = das["dauid"].map(da_prof[C_POP]).fillna(0).to_numpy()

    columns: dict[str, dict] = {}
    lookups: dict[str, dict[str, str]] = {}

    def add(name, values, kind, **kw):
        columns[check_column_name(name)] = encode_column(np.asarray(values), kind, **kw)

    add("population", population, "count", method="dasymetric_da_points_csd_exact_v1")
    add("population_2016", pops["population_2016"], "count", method="csd_2016_totals_by_2021_da_weights_v1")

    log("shares")
    for name, values in share_columns(mesh, das, da_prof, csd_prof).items():
        add(name, values, "share", method="da_population_weighted_csd_fallback_v1")

    add(
        "urban_class",
        urban_class_column(mesh, das, population),
        "id",
        method="da_cma_ca_plurality_density_v1",
    )
    lookups["urban_class"] = {str(k): v for k, v in URBAN_CLASSES.items()}

    log("industry")
    # CSD → cells weights: population share where the CSD has people in the mesh, else area share.
    per = pd.DataFrame({"csd": das["csd"], "cell": das["cell"], "w": das["pop"]})
    per = per.groupby(["csd", "cell"], as_index=False, sort=True)["w"].sum()
    cell_from_csd = {}
    for csd, g in per.groupby("csd", sort=True):
        if g["w"].sum() > 0:
            cell_from_csd[csd] = (g["cell"].to_numpy(), g["w"].to_numpy() / g["w"].sum())
    for csd, (cells_idx, weights) in cell_csd_weight.items():
        if csd not in cell_from_csd and weights.sum() > 0:
            cell_from_csd[csd] = (cells_idx, weights / weights.sum())
    industry, dominant, labour = industry_columns(mesh, csd_prof, cell_from_csd)
    for name, values in industry.items():
        add(name, values, "share", method="csd_labour_force_by_population_share_v1")
    add("industry_dominant", dominant, "id", method="argmax_industry_share_v1")
    lookups["industry_dominant"] = {"0": "no data"} | {s[:2]: NAICS_LABELS[s] for s in NAICS_SECTORS}

    gdp = gdp_column(mesh, labour, population)
    gdp_year = None
    if gdp is not None:
        values, gdp_year = gdp
        add("gdp_estimate", values, "money", unit=MONEY_UNIT, method="allocation_v1", confidence=0.5)

    log("ecozones and drainage")
    eco, drainage = overlay_inputs()
    add("ecozone_id", id_from_overlap(polys, eco, "ECOZONE_ID"), "id", method="largest_overlap_v1")
    lookups["ecozone_id"] = {"0": "none"} | {
        str(int(r.ECOZONE_ID)): r.ECOZONE_NAME_EN for r in eco.itertuples()
    }
    drainage["region"] = drainage["Drainage_region_code"].astype(int)
    drainage["ocean"] = drainage["Ocean_drainage_area_code"].astype(int)
    add("basin_id", id_from_overlap(polys, drainage, "region"), "id", method="largest_overlap_v1")
    lookups["basin_id"] = {"0": "none"} | {
        str(r.region): r.Drainage_region_name for r in drainage.sort_values("region").itertuples()
    }
    oceans = drainage.dissolve("ocean", as_index=False)
    add("ocean_drainage_id", id_from_overlap(polys, oceans, "ocean"), "id", method="largest_overlap_v1")
    lookups["ocean_drainage_id"] = {"0": "none"} | {
        str(r.ocean): r.Ocean_drainage_area_name
        for r in drainage.drop_duplicates("ocean").sort_values("ocean").itertuples()
    }

    log("sub-basins (NHN work units)")
    nhn = read_vector(
        zip_dataset(raw_file("nrcan_nhn_workunits")), columns=["WSCSDA", "WSCSDANAME", "WSCMDANAME"]
    )
    nhn = nhn[nhn["WSCSDA"].notna()].to_crs(EQUAL_AREA_CRS)
    nhn["geometry"] = shapely.make_valid(nhn.geometry.to_numpy())
    codes = sorted(nhn["WSCSDA"].unique())
    code_id = {code: i + 1 for i, code in enumerate(codes)}
    nhn["sid"] = nhn["WSCSDA"].map(code_id)
    nhn = nhn.dissolve("sid", as_index=False, aggfunc="first")
    add("subbasin_id", id_from_overlap(polys, nhn, "sid"), "id", method="largest_overlap_wsc_sda_v1")
    lookups["subbasin_id"] = {"0": "none"} | {
        str(r.sid): f"{r.WSCSDA} {subbasin_name(r.WSCSDANAME, r.WSCMDANAME)}"
        for r in nhn.sort_values("sid").itertuples()
    }

    log("treaties")
    treaty_id, kind_area, treaty_labels = treaty_columns(polys)
    land = np.zeros(n)
    for row in csd_overlap.groupby("cell")["area"].sum().items():
        land[row[0]] = row[1]
    kind_area[:, 4] = np.clip(land - kind_area[:, 1:4].sum(axis=1), 0, None)
    treaty_code = np.where(land > 0, np.argmax(kind_area[:, 1:], axis=1) + 1, 0)
    add("treaty_code", treaty_code, "id", method="largest_of_modern_numbered_historic_unceded_v1")
    lookups["treaty_code"] = {str(k): v for k, v in TREATY_CODES.items()}
    add("treaty_id", treaty_id, "id", method="largest_overlap_modern_precedence_v1")
    lookups["treaty_id"] = {"0": "none"} | treaty_labels

    log("reserves, Métis settlements, Inuit regions")
    lands = read_vector(zip_dataset(raw_file("nrcan_aboriginal_lands"), r"\.shp$"))
    reserves = lands[lands["ALTYPE"] == "Indian Reserve"].to_crs(EQUAL_AREA_CRS)
    reserves = gpd.GeoDataFrame(
        {"k": 1},
        index=reserves.index,
        geometry=shapely.make_valid(reserves.geometry.to_numpy()),
        crs=EQUAL_AREA_CRS,
    ).dissolve("k", as_index=False)
    reserve_area = np.zeros(n)
    for row in overlap_areas(polys, reserves, "k").itertuples():
        reserve_area[row.cell] += row.area
    add("reserve_share", np.clip(reserve_area / areas_m2, 0, 1), "share", method="area_share_v1")

    metis = read_vector(raw_file("ab_metis_settlements")).to_crs(EQUAL_AREA_CRS)
    metis["code"] = metis["METIS_CODE"].astype(int)
    metis = metis.dissolve("code", as_index=False, aggfunc="first")
    add(
        "metis_settlement",
        id_from_overlap(polys, metis, "code", MAJORITY),
        "id",
        method="majority_overlap_v1",
    )
    lookups["metis_settlement"] = {"0": "none"} | {str(r.code): r.METIS_NAME for r in metis.itertuples()}

    inuit = read_vector(zip_dataset(raw_file("cirnac_inuit_regions"))).to_crs(EQUAL_AREA_CRS)
    inuit = inuit.sort_values("REGION", kind="stable").reset_index(drop=True)
    inuit["rid"] = np.arange(1, len(inuit) + 1)
    add("inuit_region", id_from_overlap(polys, inuit, "rid", MAJORITY), "id", method="majority_overlap_v1")
    lookups["inuit_region"] = {"0": "none"} | {str(r.rid): r.REGION for r in inuit.itertuples()}

    log("ridings and 2025 results")
    feds = read_vector(zip_dataset(raw_file("elections_fed_2023"), r"\.shp$")).to_crs(EQUAL_AREA_CRS)
    feds["fed"] = feds["FED_NUM"].astype(int)
    feds["geometry"] = shapely.make_valid(feds.geometry.to_numpy())
    riding = id_from_overlap(polys, feds, "fed")
    missing = np.flatnonzero(riding == 0)
    if len(missing):
        for i, fed in zip(missing, nearest_key(polys.iloc[missing], feds, "fed"), strict=True):
            riding[i] = int(fed)
    add("fed_riding_id", riding, "id", method="largest_overlap_nearest_fallback_v1")
    lookups["fed_riding_id"] = {str(r.fed): r.ED_NAMEE for r in feds.sort_values("fed").itertuples()}
    winners = read_ge45_winners(raw_file("elections_results_ge45"))
    add(
        "riding_party_2025",
        np.array([winners.get(int(r), 0) for r in riding]),
        "id",
        method="ge45_elected_candidate_v1",
    )
    lookups["riding_party_2025"] = {"0": "unknown"} | {str(code): short for code, _, short in PARTIES}

    log("distance to capital")
    distance = np.array(
        [haversine_km(c["centroid"][1], c["centroid"][0], *CAPITALS[c["province"]]) for c in mesh["cells"]]
    )
    add(
        "distance_to_capital_km",
        distance,
        "measure",
        unit="km",
        method="great_circle_centre_to_legislature_v1",
    )

    if "native_land_territories" not in load_manifest():
        log("native_land_territories not fetched (native_land_permission pending); side table omitted")

    return {
        "format": "meridian.attrs",
        "version": MESH_VERSION,
        "meshVersion": mesh["version"],
        "cellCount": n,
        "meta": file_meta(
            census_year=2021,
            gdp_method="allocation_v1" if gdp is not None else "omitted_no_source",
            gdp_source="statcan_gdp_36100711",
            gdp_reference_year=gdp_year or "none",
            gdp_prices="current_dollars_basic_prices",
        ),
        "columns": columns,
        "lookups": lookups,
    }


def read_ge45_winners(path) -> dict[int, int]:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    num_col = next(c for c in rows[0] if c.startswith("Electoral District Number"))
    winner_col = next(c for c in rows[0] if c.startswith("Elected Candidate"))
    out = {}
    for row in rows:
        text = row[winner_col].strip()
        code = next((code for code, label, _ in PARTIES if text.endswith(label)), 0)
        if code == 0:
            raise ValueError(f"unrecognised party in {text!r}")
        out[int(row[num_col])] = code
    return out


def main() -> int:
    attrs = build()
    write_json_gz(ATTRS_PATH, attrs)
    log(f"wrote {ATTRS_PATH} ({ATTRS_PATH.stat().st_size:,} bytes, {len(attrs['columns'])} columns)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
