"""Inputs the splitter UI needs that no other artefact carries (plan Phase 3, Sitting B).

Built by the `layers` step (polygons.py registers these builders after `rivers`, whose output
`snap` reads):

- places.v1.json.gz     gazetteer: every populated CSD with its name, population, representative
                        point and mesh cell (keep-together and keep-apart pins), and every CMA with
                        its mesh cells (carve-CMA-first).
- cells.v1.topojson.gz  the mesh's hexagons as one topology, one geometry per cell in mesh order,
                        so the app can dissolve regions by dropping shared arcs.
- snap.v1.json.gz       mesh edges whose centre-to-centre segment crosses a river of the rivers layer
                        (the one snap layer that is a line, not a partition the app can compare).
"""

from __future__ import annotations

import gzip
import json
import subprocess
from pathlib import Path

import geopandas as gpd
import h3
import numpy as np
import shapely

from census import load_profile
from columns import decode_column, encode_column
from common import (
    BUILD,
    EQUAL_AREA_CRS,
    MESH_VERSION,
    WGS84,
    gzip_bytes,
    raw_file,
    write_bytes,
    write_json_gz,
)
from geo import points_within, read_vector

PLACES = BUILD / f"places.{MESH_VERSION}.json.gz"
CELLS = BUILD / f"cells.{MESH_VERSION}.topojson.gz"
SNAP = BUILD / f"snap.{MESH_VERSION}.json.gz"
C_POP = 1  # Census Profile: population, 2021


def load_gz(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def mesh_doc() -> dict:
    return load_gz(BUILD / f"mesh.{MESH_VERSION}.json.gz")


def nearest_cells(lats: np.ndarray, lngs: np.ndarray, cells: list[dict]) -> list[int]:
    """The mesh cell holding each point, else the nearest cell centre (chord distance)."""
    index = {c["id"]: i for i, c in enumerate(cells)}
    clat = np.radians([c["centroid"][1] for c in cells])
    clng = np.radians([c["centroid"][0] for c in cells])
    centres = np.column_stack([np.cos(clat) * np.cos(clng), np.cos(clat) * np.sin(clng), np.sin(clat)])
    out = []
    for lat, lng in zip(lats, lngs, strict=True):
        cell = index.get(h3.latlng_to_cell(float(lat), float(lng), 5))
        if cell is None:
            p = np.radians([lat, lng])
            point = np.array([np.cos(p[0]) * np.cos(p[1]), np.cos(p[0]) * np.sin(p[1]), np.sin(p[0])])
            cell = int(np.argmin(np.linalg.norm(centres - point, axis=1)))
        out.append(int(cell))
    return out


def layer_places(tmp: Path) -> list[Path]:
    del tmp
    mesh = mesh_doc()
    cells = mesh["cells"]
    population = load_profile("statcan_profile_csd_2021", [C_POP])[C_POP]

    csd = read_vector(
        raw_file("statcan_csd_2021"), crs=EQUAL_AREA_CRS, columns=["CSDUID", "CSDNAME", "PRUID"]
    )
    csd = csd.sort_values("CSDUID", kind="stable").reset_index(drop=True)
    csd["population"] = csd["CSDUID"].map(population).fillna(0).astype(int)
    csd = csd[csd["population"] > 0].reset_index(drop=True)
    points = gpd.GeoSeries(
        shapely.point_on_surface(shapely.make_valid(csd.geometry.to_numpy())), crs=EQUAL_AREA_CRS
    )
    wgs = points.to_crs(WGS84)
    csd_cells = nearest_cells(wgs.y.to_numpy(), wgs.x.to_numpy(), cells)
    places = [
        {
            "csd": row.CSDUID,
            "name": row.CSDNAME,
            "province": row.PRUID,
            "population": int(row.population),
            "lng": round(float(wgs.x.iloc[i]), 5),
            "lat": round(float(wgs.y.iloc[i]), 5),
            "cell": csd_cells[i],
        }
        for i, row in enumerate(csd.itertuples())
    ]

    attrs = load_gz(BUILD / f"attrs.{MESH_VERSION}.json.gz")
    cell_population = decode_column(attrs["columns"]["population"])
    cma = read_vector(
        raw_file("statcan_cma_2021"), crs=EQUAL_AREA_CRS, columns=["CMAUID", "CMANAME", "CMATYPE"]
    )
    cma = cma[cma["CMATYPE"] == "B"].sort_values("CMAUID", kind="stable")
    # A CMA that crosses a provincial border comes as one row per part ("Ottawa - Gatineau (Ontario
    # part / partie de l'Ontario)"): one CMA, one row, named without the part.
    cma["CMANAME"] = cma["CMANAME"].str.replace(
        r"\s*\((?:partie|Ontario part|Quebec part)[^)]*\)$", "", regex=True
    )
    cma["geometry"] = shapely.make_valid(cma.geometry.to_numpy())
    cma = cma.dissolve("CMAUID", as_index=False, aggfunc={"CMANAME": "first"}).reset_index(drop=True)
    cma["key"] = np.arange(len(cma))
    # A cell belongs to a CMA through its CSD (the mesh's largest-overlap CSD), and a CSD to the CMA
    # holding its representative point. Testing cell centres instead loses waterfront cells whose
    # centre is in a lake: Toronto's downtown hexagons sit half in Lake Ontario.
    all_csd = read_vector(raw_file("statcan_csd_2021"), crs=EQUAL_AREA_CRS, columns=["CSDUID"])
    all_csd = all_csd.sort_values("CSDUID", kind="stable").reset_index(drop=True)
    csd_points = gpd.GeoSeries(
        shapely.point_on_surface(shapely.make_valid(all_csd.geometry.to_numpy())), crs=EQUAL_AREA_CRS
    )
    csd_cma = points_within(csd_points, cma[["key", "geometry"]], "key")
    cma_of_csd = {all_csd["CSDUID"].iloc[int(i)]: int(key) for i, key in csd_cma.items()}
    members: dict[int, list[int]] = {}
    for cell, c in enumerate(cells):
        key = cma_of_csd.get(c["csd"])
        if key is not None:
            members.setdefault(key, []).append(cell)
    cmas = [
        {
            "cma": row.CMAUID,
            "name": row.CMANAME,
            "population": int(sum(int(cell_population[c]) for c in members[row.key])),
            "cells": sorted(members[row.key]),
        }
        for row in cma.itertuples()
        if row.key in members
    ]
    write_json_gz(
        PLACES,
        {
            "format": "meridian.places",
            "version": MESH_VERSION,
            "meshVersion": mesh["version"],
            "places": places,
            "cmas": cmas,
        },
    )
    return [PLACES]


def layer_cells(tmp: Path) -> list[Path]:
    """Every mesh hexagon, unsimplified: adjacent H3 cells share exact vertices, so mapshaper's
    topology shares their arcs, and quantisation keeps them shared."""
    from polygons import mapshaper_cmd

    cells = mesh_doc()["cells"]
    features = [
        {
            "type": "Feature",
            "properties": {"i": i},
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [lng, lat]
                        for lat, lng in [*h3.cell_to_boundary(c["id"]), h3.cell_to_boundary(c["id"])[0]]
                    ]
                ],
            },
        }
        for i, c in enumerate(cells)
    ]
    source = tmp / "cells.geojson"
    source.write_text(json.dumps({"type": "FeatureCollection", "features": features}), encoding="utf-8")
    plain = tmp / "cells.topojson"
    cmd = [*mapshaper_cmd(), "-i", str(source), "-o", str(plain), "format=topojson", "quantization=100000"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"mapshaper failed for cells:\n{result.stderr[-2000:]}")
    topo = json.loads(plain.read_text(encoding="utf-8"))
    (layer,) = topo["objects"].values()
    geometries = sorted(layer["geometries"], key=lambda g: g["properties"]["i"])
    if [g["properties"]["i"] for g in geometries] != list(range(len(cells))):
        raise RuntimeError("mapshaper dropped or reordered cells")
    for g in geometries:
        del g["properties"]
    topo["objects"] = {"cells": {"type": "GeometryCollection", "geometries": geometries}}
    write_bytes(CELLS, gzip_bytes(json.dumps(topo, separators=(",", ":")).encode("utf-8") + b"\n"))
    return [CELLS]


def topojson_lines(topo: dict) -> list[shapely.LineString]:
    """Decode every arc of a quantised TopoJSON to a WGS84 line."""
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    lines = []
    for arc in topo["arcs"]:
        xy = np.cumsum(np.asarray(arc, dtype=np.float64), axis=0)
        lines.append(shapely.linestrings(xy[:, 0] * sx + tx, xy[:, 1] * sy + ty))
    return lines


def layer_snap(tmp: Path) -> list[Path]:
    del tmp
    mesh = mesh_doc()
    cells = mesh["cells"]
    rivers = load_gz(BUILD / "layers" / f"rivers.{MESH_VERSION}.topojson.gz")
    tree = shapely.STRtree(topojson_lines(rivers))
    pairs = [(u, v) for u, c in enumerate(cells) for v in c["neighbours"] if u < v]
    segments = shapely.linestrings([[cells[u]["centroid"], cells[v]["centroid"]] for u, v in pairs])
    hit, _ = tree.query(segments, predicate="intersects")
    crossing = sorted({pairs[i] for i in np.unique(hit)})
    flat = np.array([x for pair in crossing for x in pair], dtype=np.int64)
    write_json_gz(
        SNAP,
        {
            "format": "meridian.snap",
            "version": MESH_VERSION,
            "meshVersion": mesh["version"],
            "layers": {
                "rivers": {
                    "description": "Mesh edges whose centre-to-centre segment crosses a river of Strahler "
                    "order 7 or more (layers/rivers)",
                    "pairs": encode_column(flat, "id", method="centre_segment_intersects_rivers_layer_v1"),
                }
            },
        },
    )
    return [SNAP]
