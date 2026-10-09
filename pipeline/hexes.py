"""Build data/build/hexes.r4.v1.json.gz and data/build/layers/hexes.r4.v1.topojson.gz: one row per H3
resolution-4 hexagon that is the parent of at least one mesh cell, and its outline clipped to land.

    make hexes        (after attrs, layers and atlas: reads mesh, attrs, places and the atlas)

A unit table (format "meridian.unitTable", unit "h3_r4"; docs/interop.md, "Unit tables"). Here the
unit is coarser than the mesh (a resolution-4 hexagon is the parent of about seven resolution-5
cells), so the census values are aggregated from the mesh cells, exactly as a pack region aggregates
its cells (app/src/dossier/stats.ts): a hexagon scores what a region made of its cells would.

Methods:
- cells, population, gdp: counts and sums over the hexagon's mesh cells (attrs population and
  gdp_estimate, allocation_v1).
- shares, resource_index, exposure, industryDominant: the cells' attrs shares, weighted by each
  cell's population, as packs weight them; a hexagon with nobody in it has every share 0 and
  industryDominant 0 ("no data"). No cohesion, for the reason ridings.v1 has none.
- land: the hexagon (H3 boundary, EPSG:3347) intersected with the 2021 cartographic CSDs, as
  ridings.v1 measures land. `areaKm2` is its area; `province` the province holding most of it. A
  hexagon of open water (in the mesh because mesh.py counts the Atlas of Canada's inland water as
  land: the Great Lakes) has none: areaKm2 0, the province of most of its cells, a null geometry in
  the layer, and every jurisdiction span a fallback.
- urbanClass: the class (CMA 3, CA 2) holding most of the hexagon's people by cell, else rural 1 if
  density over land >= attributes.RURAL_DENSITY, else remote 0 (attrs' rule, cells for DAs).
- ecozone: the attrs ecozone_id covering the most mesh-cell area; ties to the smaller id.
- places: each places.v1 place goes to the resolution-4 hexagon holding its point (H3's own
  containment), or, if that hexagon is not in the table, to the parent of the place's mesh cell.
  csdType is the CSD's CSDTYPE in the boundary file, labelled in lookups.csdType.
- neighbours: the hexagons in the table that share an H3 edge with it. kind is "land" when at least
  LAND_EDGE_M metres of that common edge lie on land (2021 cartographic CSDs), else "water".
- jurisdictions: as ridings.v1 (unittables.jurisdictions), over the hexagon's land.
- the layer: each hexagon's land as one geometry (property id), one mapshaper topology simplified at
  LAYER_INTERVAL_M metres, so neighbours share arcs and the coasts and the Great Lakes are water.
"""

from __future__ import annotations

import json
import resource
import sys
import tempfile
import time
from collections import Counter, defaultdict
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import shapely

from attributes import NAICS_LABELS, NAICS_SECTORS, RURAL_DENSITY, URBAN_CLASSES, load_csds
from census import release_memory
from columns import decode_column
from common import BUILD, EQUAL_AREA_CRS, MESH_VERSION, WGS84, dumps, gzip_bytes, write_bytes, write_json_gz
from geo import cell_polygons
from unittables import ATLAS_PATH, PROVINCES, START, intersect_pieces, jurisdictions, load_gz, tiled_parts

UNIT = "h3_r4"
RESOLUTION = 4
TABLE_VERSION = 1
HEXES_PATH = BUILD / f"hexes.r4.{MESH_VERSION}.json.gz"
HEX_LAYER = BUILD / "layers" / f"hexes.r4.{MESH_VERSION}.topojson.gz"
LAYER_URL_PATH = f"data/build/layers/hexes.r4.{MESH_VERSION}.topojson.gz"  # meta.layer: fixed, not BUILD
LAYER_INTERVAL_M = 500  # as the ridings layer
LAND_EDGE_M = 1.0  # a common edge with less land than this is a water link (see neighbour_kinds)

# Mirrors HEX_GDP_CAVEAT in app/src/schema/unitTable.ts, whose schema requires this exact text.
GDP_CAVEAT = (
    "GDP is an estimate: provincial GDP by industry shared over mesh cells by census labour force "
    "(allocation_v1), not a measurement of what a hexagon produces."
)
SOURCES = [
    "statcan_csd_2021",
    "statcan_da_2021",
    "statcan_cma_2021",
    "statcan_profile_da_2021",
    "statcan_profile_csd_2021",
    "statcan_gdp_36100711",
    "aafc_ecozones",
]
SHARES = {  # row key → attrs column
    "english": "english_share",
    "french": "french_share",
    "indigenous_language": "indigenous_language_share",
    "other_language": "other_language_share",
    "indigenous_identity": "indigenous_identity_share",
    "immigrant": "immigrant_share",
}
EXTRACTIVE = ["11", "21"]
# Statistics Canada's census subdivision types: Table 4.4 of 92-500-G (2020), the reference guide to the
# 2021 boundary files, and, for GR, TAL and TWL, which that table lacks, Table 4.2 of 92-500-G (2025).
# The build fails on a code in the boundary file that is not here.
CSD_TYPES = {
    "C": "City / Cité", "CC": "Chartered community", "CÉ": "Cité", "CG": "Community government",
    "CM": "County (municipality)", "CN": "Crown colony / Colonie de la couronne", "COM": "Community",
    "CT": "Canton (municipalité de)", "CU": "Cantons unis (municipalité de)", "CV": "City / Ville",
    "CY": "City", "DM": "District municipality", "FD": "Fire district", "GR": "Gouvernement régional",
    "HAM": "Hamlet", "ID": "Improvement district", "IGD": "Indian government district",
    "IM": "Island municipality", "IRI": "Indian reserve / Réserve indienne",
    "LGD": "Local government district", "LOT": "Township and royalty",
    "M": "Municipality / Municipalité", "MD": "Municipal district", "MÉ": "Municipalité",
    "MRM": "Regional municipality / Municipalité régionale", "MU": "Municipality",
    "NH": "Northern hamlet", "NL": "Nisga'a land", "NO": "Unorganized / Non organisé",
    "NV": "Northern village", "NVL": "Nisga'a village", "P": "Parish / Paroisse (municipalité de)",
    "PE": "Paroisse (municipalité de)", "RCR": "Rural community / Communauté rurale",
    "RDA": "Regional district electoral area", "RG": "Region", "RGM": "Regional municipality",
    "RM": "Rural municipality", "RMU": "Resort municipality", "RV": "Resort village",
    "SA": "Special area",
    "SC": "Subdivision of county municipality / Subdivision municipalité de comté",
    "SÉ": "Settlement / Établissement", "S-É": "Indian settlement / Établissement indien",
    "SET": "Settlement", "SG": "Self-government / Autonomie gouvernementale",
    "SM": "Specialized municipality", "SNO": "Subdivision of unorganized / Subdivision non organisée",
    "SV": "Summer village", "T": "Town", "TAL": "Tla'amin Lands", "TC": "Terres réservées aux Cris",
    "TI": "Terre inuite", "TK": "Terres réservées aux Naskapis", "TL": "Teslin land", "TP": "Township",
    "TV": "Town / Ville", "TWL": "Tsawwassen Lands", "V": "Ville", "VC": "Village cri",
    "VK": "Village naskapi", "VL": "Village", "VN": "Village nordique",
}  # fmt: skip


def log(message: str) -> None:
    peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    print(f"[hexes {time.strftime('%H:%M:%S')} peak {peak_mb:,.0f} MB] {message}", flush=True)


def weighted(values: np.ndarray, weights: np.ndarray, groups: np.ndarray, n: int) -> np.ndarray:
    """Per group, the weights-weighted mean of values; 0 where the weights sum to 0 (stats.ts)."""
    total = np.bincount(groups, weights=weights, minlength=n)
    sums = np.bincount(groups, weights=weights * values, minlength=n)
    return np.divide(sums, total, out=np.zeros(n), where=total > 0)


def neighbour_kinds(ids: list[str], csds: gpd.GeoDataFrame) -> dict[tuple[str, str], tuple[str, float]]:
    """For every pair of hexagons in the table sharing an H3 edge (a < b): ("land" | "water", metres
    of that edge on land). The edge is H3's own boundary between the two, projected as the hexagons
    are (geo.cell_polygons), and measured against the CSD polygons, not the hexagons' clipped land."""
    table = set(ids)
    pairs = sorted({(a, b) for a in ids for b in h3.grid_ring(a, 1) if b in table and a < b})
    lines = [
        shapely.LineString(
            [(lng, lat) for lat, lng in h3.directed_edge_to_boundary(h3.cells_to_directed_edge(a, b))]
        )
        for a, b in pairs
    ]
    edges = gpd.GeoSeries(lines, crs=WGS84).to_crs(EQUAL_AREA_CRS).to_numpy()
    parts, _ = tiled_parts(csds, "csd")
    ie, ip = shapely.STRtree(parts).query(edges, predicate="intersects")
    order = np.lexsort((ip, ie))
    ie, ip = ie[order], ip[order]
    on_land = np.bincount(
        ie, weights=shapely.length(shapely.intersection(edges[ie], parts[ip])), minlength=len(pairs)
    )
    return {
        pair: ("land" if metres >= LAND_EDGE_M else "water", float(metres))
        for pair, metres in zip(pairs, on_land, strict=True)
    }


def layer(ids: list[str], land: pd.DataFrame, out: Path = HEX_LAYER) -> int:
    """Each hexagon's land, dissolved from its CSD pieces, as one mapshaper topology at `out`."""
    from polygons import export, polygonal, simplify

    pieces = land.groupby("a", sort=True)["geometry"].apply(
        lambda g: polygonal(shapely.union_all(g.to_numpy()))
    )
    gdf = gpd.GeoDataFrame({"id": pieces.index.to_list()}, geometry=pieces.to_numpy(), crs=EQUAL_AREA_CRS)
    with tempfile.TemporaryDirectory(prefix="meridian-hexes-") as tmp:
        path = Path(tmp) / "hexes.geojson"
        export(gdf, path, ["id"], "id")
        del gdf, pieces
        simplify({"hexes": path}, out, LAYER_INTERVAL_M)
    # One geometry per id, in id order: a hexagon with no land is a null geometry, as a river the
    # coast clips away is in the rivers layer.
    topo = load_gz(out)
    drawn = {g["properties"]["id"]: g for g in topo["objects"]["hexes"]["geometries"] if g.get("arcs")}
    topo["objects"]["hexes"]["geometries"] = [
        drawn.get(h, {"type": None, "properties": {"id": h}}) for h in ids
    ]
    write_bytes(out, gzip_bytes(dumps(topo) + b"\n"))
    return len(drawn)


class Aggregates:
    """The mesh cells' attrs summed or population-weighted per group, as a pack region aggregates them
    (app/src/dossier/stats.ts)."""

    def __init__(self, cells: list[dict], col: dict[str, np.ndarray], group: np.ndarray, n: int):
        people = col["population"]
        self.people = people
        self.population = np.bincount(group, weights=people, minlength=n).round().astype(np.int64)
        self.gdp = np.bincount(group, weights=col["gdp_estimate"], minlength=n)
        self.counts = np.bincount(group, minlength=n)
        self.shares = {key: weighted(col[name], people, group, n) for key, name in SHARES.items()}
        self.industry = np.column_stack(
            [weighted(col[f"industry_share_{s}"], people, group, n) for s in NAICS_SECTORS]
        )
        self.extractive = [NAICS_SECTORS.index(s) for s in EXTRACTIVE]

        # Ecozone: the most mesh-cell area, ties to the smaller id.
        areas = np.array([c["area"] for c in cells])
        eco = pd.DataFrame({"h": group, "k": col["ecozone_id"].astype(int), "a": areas})
        eco = eco.groupby(["h", "k"], as_index=False)["a"].sum()
        eco = eco.sort_values(["h", "a", "k"], ascending=[True, False, True], kind="stable")
        eco = eco.drop_duplicates("h")
        self.ecozone = eco.set_index("h")["k"].reindex(range(n)).fillna(0).astype(int).to_numpy()
        self.col, self.group, self.n = col, group, n

    def urban(self, land_km2: np.ndarray) -> np.ndarray:
        """The cell class (CMA 3, CA 2) holding most of the group's people, else rural 1 or remote 0 by
        density over land."""
        col, group, n = self.col, self.group, self.n
        k = np.where(col["urban_class"] >= 2, col["urban_class"], 0).astype(int)
        urb = pd.DataFrame({"h": group, "k": k, "w": self.people})
        urb = urb.groupby(["h", "k"], as_index=False)["w"].sum()
        urb = urb.sort_values(["h", "w", "k"], ascending=[True, False, False], kind="stable")
        urb = urb.drop_duplicates("h")
        top = urb.set_index("h")
        urban = np.zeros(n, dtype=np.int64)
        population = self.population
        for i in range(n):
            cls = int(top["k"][i]) if top["w"][i] > 0 else 0
            dense = land_km2[i] > 0 and population[i] / land_km2[i] >= RURAL_DENSITY
            urban[i] = cls if cls else (1 if dense else 0)
        return urban

    def stats(self, i: int, land_km2: np.ndarray, urban: np.ndarray) -> dict:
        """population, areaKm2, score, shares, urbanClass, industryDominant and ecozone of group i."""
        industry = self.industry[i]
        top_sector = int(np.argmax(industry))
        return {
            "population": int(self.population[i]),
            "areaKm2": round(float(land_km2[i]), 2),
            "score": {
                "population": int(self.population[i]),
                "gdp": int(round(self.gdp[i])),
                "resource_index": round(float(industry[self.extractive].sum()), 3),
                "exposure": round(float(industry[top_sector]), 3),
            },
            "shares": {key: round(float(v[i]), 4) for key, v in self.shares.items()},
            "urbanClass": int(urban[i]),
            "industryDominant": int(NAICS_SECTORS[top_sector][:2]) if industry.sum() > 0 else 0,
            "ecozone": int(self.ecozone[i]),
        }


def province_by_land(land: pd.DataFrame, csds: gpd.GeoDataFrame) -> dict:
    """Per unit (land's "a"), the province holding most of its land; ties to the smaller code."""
    by_province = land.assign(p=land["b"].map(csds.set_index("csd")["province"]))
    by_province = by_province.groupby(["a", "p"], as_index=False)["area"].sum()
    by_province = by_province.sort_values(["a", "area", "p"], ascending=[True, False, True], kind="stable")
    return by_province.drop_duplicates("a").set_index("a")["p"].to_dict()


def csd_types(csds: gpd.GeoDataFrame) -> dict[str, str]:
    csd_type = csds.set_index("csd")["CSDTYPE"].to_dict()
    unknown = sorted(set(csd_type.values()) - set(CSD_TYPES))
    if unknown:
        raise ValueError(f"CSD types with no label in CSD_TYPES: {unknown}")
    return csd_type


def place_entry(p: dict, csd_type: dict[str, str]) -> dict:
    return {"csd": p["csd"], "name": p["name"], "population": p["population"], "csdType": csd_type[p["csd"]]}


def sorted_places(places: list[dict]) -> list[dict]:
    return sorted(places, key=lambda p: (-p["population"], p["csd"]))


def lookups(attrs: dict) -> dict:
    return {
        "urbanClass": {str(k): v for k, v in URBAN_CLASSES.items()},
        "industryDominant": {"0": "no data"} | {s[:2]: NAICS_LABELS[s] for s in NAICS_SECTORS},
        "ecozone": attrs["lookups"]["ecozone_id"],
        "csdType": dict(sorted(CSD_TYPES.items())),
    }


def census_meta(mesh: dict, attrs: dict) -> dict:
    """meshVersion, censusYear, the GDP method, the atlas and jurisdictionsFrom, in the tables' order."""
    return {
        "meshVersion": mesh["version"],
        "censusYear": attrs["meta"]["census_year"],
        "gdpMethod": attrs["meta"]["gdp_method"],
        "gdpReferenceYear": attrs["meta"]["gdp_reference_year"],
        "gdpPrices": attrs["meta"]["gdp_prices"],
        "atlasVersion": json.loads(ATLAS_PATH.read_text(encoding="utf-8"))["version"],
        "jurisdictionsFrom": START,
    }


def build() -> dict:
    mesh = load_gz(BUILD / f"mesh.{MESH_VERSION}.json.gz")
    attrs = load_gz(BUILD / f"attrs.{MESH_VERSION}.json.gz")
    cells = mesh["cells"]
    parents = [h3.cell_to_parent(c["id"], RESOLUTION) for c in cells]
    ids = sorted(set(parents))  # fixed-length lower-case hex: string order is H3 index order
    pos = {h: i for i, h in enumerate(ids)}
    n = len(ids)
    group = np.array([pos[p] for p in parents])
    log(f"{len(cells):,} mesh cells in {n:,} resolution-{RESOLUTION} hexagons")

    col = {name: decode_column(c).astype(np.float64) for name, c in attrs["columns"].items()}
    agg = Aggregates(cells, col, group, n)

    log("land: hexagons × cartographic CSDs")
    polys = cell_polygons(ids)
    hexes = gpd.GeoDataFrame({"hex": ids}, geometry=polys.to_numpy(), crs=EQUAL_AREA_CRS)
    csds = load_csds()
    csds["province"] = csds["PRUID"].map(PROVINCES)
    land = intersect_pieces(hexes, "hex", csds, "csd")
    land_m2 = land.groupby("a", sort=True)["area"].sum().reindex(ids).fillna(0.0).to_numpy()
    province_of = province_by_land(land, csds)
    # Open water in the mesh (the Great Lakes: mesh.py counts the Atlas of Canada's inland water as
    # land) has no CSD land: such a hexagon takes the province of most of its cells.
    no_land = [h for h in ids if h not in province_of]
    cell_provinces: dict[str, Counter] = defaultdict(Counter)
    for c, parent in zip(cells, parents, strict=True):
        cell_provinces[parent][c["province"]] += 1
    for h in no_land:
        province_of[h] = min(cell_provinces[h].items(), key=lambda kv: (-kv[1], kv[0]))[0]
    log(f"{len(no_land)} hexagons with no land (open water): {no_land}")
    csd_type = csd_types(csds)
    land_km2 = land_m2 / 1e6
    urban = agg.urban(land_km2)

    log("neighbours")
    kinds = neighbour_kinds(ids, csds)
    neighbours: dict[str, list[dict]] = defaultdict(list)
    for (a, b), (kind, _) in kinds.items():
        neighbours[a].append({"id": b, "kind": kind})
        neighbours[b].append({"id": a, "kind": kind})
    log(f"{len(kinds):,} links: {Counter(kind for kind, _ in kinds.values())}")
    del csds
    release_memory()

    log("places")
    places = load_gz(BUILD / f"places.{MESH_VERSION}.json.gz")["places"]
    places_of: dict[str, list[dict]] = defaultdict(list)
    moved = 0
    for p in places:
        hexagon = h3.latlng_to_cell(p["lat"], p["lng"], RESOLUTION)
        if hexagon not in pos:
            hexagon = parents[p["cell"]]
            moved += 1
        places_of[hexagon].append(place_entry(p, csd_type))
    log(f"{len(places):,} places; {moved} in a hexagon outside the table, given their mesh cell's")

    log("jurisdictions")
    spans = jurisdictions(
        ids, polys.to_numpy(), land["a"].to_numpy(), land["geometry"].to_numpy(), land_m2, log
    )

    log("layer")
    drawn = layer(ids, land)
    log(f"{drawn:,} hexagons drawn, {n - drawn} null (no land)")
    del land
    release_memory()

    rows = []
    for i, h in enumerate(ids):
        lat, lng = h3.cell_to_latlng(h)
        rows.append(
            {
                "id": h,
                "centroid": [round(lng, 5), round(lat, 5)],
                "province": province_of[h],
                "cells": int(agg.counts[i]),
                **agg.stats(i, land_km2, urban),
                "places": sorted_places(places_of[h]),
                "neighbours": sorted(neighbours[h], key=lambda nb: nb["id"]),
                "jurisdictions": spans[i],
            }
        )

    from polygons import attribution_rows

    census = census_meta(mesh, attrs)
    return {
        "format": "meridian.unitTable",
        "version": TABLE_VERSION,
        "unit": UNIT,
        "meta": {
            "unitName": "H3 resolution-4 hexagons with at least one mesh cell",
            "h3Resolution": RESOLUTION,
            **census,
            "layer": LAYER_URL_PATH,
            "landEdgeMetres": LAND_EDGE_M,
            "sources": attribution_rows(SOURCES),
        },
        "gdpCaveat": GDP_CAVEAT,
        "lookups": lookups(attrs),
        "rows": rows,
    }


def main() -> int:
    table = build()
    write_json_gz(HEXES_PATH, table)
    log(f"wrote {HEXES_PATH} ({HEXES_PATH.stat().st_size:,} bytes, {len(table['rows']):,} rows)")
    log(f"wrote {HEX_LAYER} ({HEX_LAYER.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
