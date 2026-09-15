"""Build data/build/mesh.v1.json.gz: H3 resolution-5 cells over Canada (land + inland water).

    make mesh

1. Inclusion rule: a cell is in the mesh if it is >= 30% Canadian land OR it contains the
   representative point of any DA with population > 0. "Canadian land" is the NRCan Atlas of
   Canada 1:1M boundary polygons: land plus inland water, including the Canadian Great Lakes.
   DA representative points are point_on_surface of the 2021 cartographic DAs.
2. Province: largest area overlap with the Atlas polygons; a cell kept only for a DA point with
   no Atlas overlap (e.g. Sable Island) takes the province of that DA.
3. CD and CSD: largest overlap with the StatCan 2021 cartographic CSDs, restricted to the
   cell's province (CD) and CD (CSD) so the three codes always nest. Cells with no CSD overlap
   (open water in the Great Lakes or large bays) take the nearest CSD in their province.
4. Neighbours: H3 k-ring 1 filtered to cells in the mesh, as ascending cell indices.
"""

from __future__ import annotations

import sys
import time

import geopandas as gpd
import h3
import shapely

from census import da_points
from columns import file_meta
from common import BUILD, EQUAL_AREA_CRS, H3_RESOLUTION, MESH_VERSION, WGS84, raw_file, write_json_gz
from geo import (
    cell_polygons,
    largest,
    list_layers,
    nearest_key,
    overlap_areas,
    read_vector,
)

KEEP_SHARE = 0.30
CANDIDATE_BUFFER_M = 15_000  # > H3 res-5 circumradius (~10 km) + simplification tolerance
SIMPLIFY_M = 2_000

# Atlas of Canada 1:1M POL_DIV codes run in English alphabetical order of province names.
ATLAS_POL_DIV = {
    1: "AB",
    2: "BC",
    3: "MB",
    4: "NB",
    5: "NL",
    6: "NT",
    7: "NS",
    8: "NU",
    9: "ON",
    10: "PE",
    11: "QC",
    12: "SK",
    13: "YT",
}
PRUID_TO_CODE = {
    "10": "NL",
    "11": "PE",
    "12": "NS",
    "13": "NB",
    "24": "QC",
    "35": "ON",
    "46": "MB",
    "47": "SK",
    "48": "AB",
    "59": "BC",
    "60": "YT",
    "61": "NT",
    "62": "NU",
}
MESH_PATH = BUILD / f"mesh.{MESH_VERSION}.json.gz"


def log(message: str) -> None:
    print(f"[mesh {time.strftime('%H:%M:%S')}] {message}", flush=True)


def load_provinces() -> gpd.GeoDataFrame:
    path = raw_file("nrcan_atlas_boundaries_1m")
    gdb = f"/vsizip/{path}/AC_1M_BoundaryPolygons.gdb"
    layer = next(name for name in list_layers(gdb) if name.startswith("AC_1M_BoundaryPolygons"))
    gdf = read_vector(gdb, layer=layer)
    # Canada; ten slivers (74 km² total) carry no POL_DIV and are dropped.
    gdf = gdf[(gdf["COUNTRY"] == 1) & gdf["POL_DIV"].notna()].copy()
    gdf["province"] = gdf["POL_DIV"].astype(int).map(ATLAS_POL_DIV)
    if gdf["province"].isna().any():
        raise ValueError(
            f"unmapped POL_DIV values: {sorted(gdf.loc[gdf.province.isna(), 'POL_DIV'].unique())}"
        )
    gdf = gdf.to_crs(EQUAL_AREA_CRS)
    gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
    return gdf.dissolve("province", as_index=False, sort=True)[["province", "geometry"]]


def load_csds() -> gpd.GeoDataFrame:
    gdf = read_vector(raw_file("statcan_csd_2021"), crs=EQUAL_AREA_CRS)
    gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
    gdf["province"] = gdf["PRUID"].map(PRUID_TO_CODE)
    gdf["cd"] = gdf["CSDUID"].str[:4]
    return gdf.sort_values("CSDUID", kind="stable")[["CSDUID", "cd", "province", "geometry"]].rename(
        columns={"CSDUID": "csd"}
    )


def candidate_cells(provinces: gpd.GeoDataFrame) -> list[str]:
    outline = provinces.geometry.simplify(SIMPLIFY_M).buffer(CANDIDATE_BUFFER_M)
    outline = gpd.GeoSeries(outline, crs=EQUAL_AREA_CRS).to_crs(WGS84)
    cells: set[str] = set()
    for geom in outline:
        for part in getattr(geom, "geoms", [geom]):
            shape = h3.geo_to_h3shape(shapely.geometry.mapping(part))
            cells.update(h3.h3shape_to_cells(shape, H3_RESOLUTION))
    return sorted(cells)


def build() -> dict:
    log("loading Atlas of Canada provinces")
    provinces = load_provinces()
    log("loading StatCan CSDs")
    csds = load_csds()

    log("populated DA representative points")
    das = da_points()
    populated = das[das["population"] > 0].sort_values(["cell", "pruid"], kind="stable")
    da_province = populated.drop_duplicates("cell").set_index("cell")["pruid"].map(PRUID_TO_CODE)
    log(f"{len(populated):,} populated DAs in {len(da_province):,} cells")

    candidates = sorted(set(candidate_cells(provinces)) | set(da_province.index))
    log(f"{len(candidates):,} candidate cells")
    polys = cell_polygons(candidates)
    hex_area = polys.area.to_numpy()

    prov_overlap = overlap_areas(polys, provinces, "province")
    canadian = prov_overlap.groupby("cell")["area"].sum().reindex(range(len(candidates)), fill_value=0.0)
    by_share = canadian.to_numpy() / hex_area >= KEEP_SHARE
    by_population = [cell in da_province.index for cell in candidates]
    kept_positions = [i for i in range(len(candidates)) if by_share[i] or by_population[i]]
    log(
        f"{len(kept_positions):,} cells kept ({int(by_share.sum()):,} by land share, "
        f"{sum(1 for i in kept_positions if not by_share[i]):,} only by populated DA point)"
    )

    province_of = largest(prov_overlap)["key"]
    cells = [candidates[i] for i in kept_positions]
    kept_polys = polys.iloc[kept_positions].reset_index(drop=True)
    provinces_kept = [
        province_of[i] if i in province_of.index else da_province[candidates[i]] for i in kept_positions
    ]

    log("CSD overlaps")
    csd_overlap = overlap_areas(kept_polys, csds, "csd")
    csd_overlap["cd"] = csd_overlap["key"].str[:4]
    csd_overlap["province"] = csd_overlap["key"].str[:2].map(PRUID_TO_CODE)
    csd_overlap = csd_overlap[
        csd_overlap["province"].to_numpy() == [provinces_kept[c] for c in csd_overlap["cell"]]
    ]

    cd_overlap = (
        csd_overlap.groupby(["cell", "cd"], as_index=False, sort=True)["area"]
        .sum()
        .rename(columns={"cd": "key"})
    )
    cd_of = largest(cd_overlap)["key"]
    csd_in_cd = csd_overlap[csd_overlap["cd"].to_numpy() == [cd_of.get(c) for c in csd_overlap["cell"]]]
    csd_of = largest(csd_in_cd[["cell", "key", "area"]])["key"]

    missing = [i for i in range(len(cells)) if i not in csd_of.index]
    log(f"{len(missing):,} cells without CSD overlap; using nearest CSD in province")
    for province in sorted({provinces_kept[i] for i in missing}):
        idx = [i for i in missing if provinces_kept[i] == province]
        nearest = nearest_key(kept_polys.iloc[idx], csds[csds.province == province], "csd")
        for i, csd in zip(idx, nearest, strict=True):
            csd_of.loc[i] = csd
            cd_of.loc[i] = csd[:4]

    order = sorted(range(len(cells)), key=lambda i: cells[i])
    cells_sorted = [cells[i] for i in order]
    position = {cell: n for n, cell in enumerate(cells_sorted)}

    log("neighbours")
    out_cells = []
    for i in order:
        cell = cells[i]
        lat, lng = h3.cell_to_latlng(cell)
        neighbours = sorted(position[n] for n in h3.grid_disk(cell, 1) if n != cell and n in position)
        out_cells.append(
            {
                "id": cell,
                "centroid": [round(lng, 6), round(lat, 6)],
                "area": round(h3.cell_area(cell, unit="km^2"), 3),
                "province": provinces_kept[i],
                "cd": cd_of[i],
                "csd": csd_of[i],
                "neighbours": neighbours,
            }
        )

    return {
        "format": "meridian.mesh",
        "version": MESH_VERSION,
        "h3Resolution": H3_RESOLUTION,
        "meta": file_meta(
            coverage="nrcan_atlas_boundaries_1m",
            keep_rule="canadian_share_ge_0.30_or_populated_da_point",
            csd_source="statcan_csd_2021",
            h3_version=h3.__version__,
        ),
        "cells": out_cells,
        "columns": {},
    }


def main() -> int:
    mesh = build()
    write_json_gz(MESH_PATH, mesh)
    log(f"wrote {MESH_PATH} ({MESH_PATH.stat().st_size:,} bytes, {len(mesh['cells']):,} cells)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
