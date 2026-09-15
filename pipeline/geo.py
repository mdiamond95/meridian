"""Geometry helpers shared by mesh.py, attributes.py and polygons.py.

All areas are computed in Statistics Canada Lambert (EPSG:3347, equal-area). Every operation
is deterministic: inputs are sorted by a key before building spatial indexes, and ties are broken
by key order.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import pyogrio
import shapely
from shapely.geometry import Polygon

from common import EQUAL_AREA_CRS, WGS84

TILE_M = 50_000.0
TILE_VERTEX_THRESHOLD = 500


def read_vector(path, layer: str | None = None, crs: str | None = None, **kwargs) -> gpd.GeoDataFrame:
    """Read any vector file (zip paths go through /vsizip/). `crs` overrides a missing/wrong CRS."""
    target = str(path)
    if target.endswith(".zip") and not target.startswith("/vsizip/"):
        target = f"/vsizip/{target}"
    gdf = pyogrio.read_dataframe(target, layer=layer, **kwargs)
    if crs is not None:
        gdf = gdf.set_crs(crs, allow_override=True)
    return gdf


def list_layers(path) -> list[str]:
    target = str(path)
    if target.endswith(".zip") and not target.startswith("/vsizip/"):
        target = f"/vsizip/{target}"
    return [name for name, _ in pyogrio.list_layers(target)]


def cell_polygons(cells: Sequence[str]) -> gpd.GeoSeries:
    """H3 cell boundaries projected to EPSG:3347."""
    polys = [Polygon([(lng, lat) for lat, lng in h3.cell_to_boundary(c)]) for c in cells]
    return gpd.GeoSeries(polys, crs=WGS84).to_crs(EQUAL_AREA_CRS)


def cell_centres(cells: Sequence[str]) -> gpd.GeoSeries:
    pts = [shapely.Point(lng, lat) for lat, lng in (h3.cell_to_latlng(c) for c in cells)]
    return gpd.GeoSeries(pts, crs=WGS84).to_crs(EQUAL_AREA_CRS)


def tiled(gdf: gpd.GeoDataFrame, key: str) -> tuple[np.ndarray, np.ndarray]:
    """Explode to parts and cut big parts into TILE_M squares. Returns (geometries, keys)."""
    parts = gdf[[key, "geometry"]].explode(index_parts=False, ignore_index=True)
    parts = parts[~parts.geometry.is_empty & parts.geometry.notna()]
    geoms: list = []
    keys: list = []
    for k, geom in zip(parts[key].to_numpy(), parts.geometry.to_numpy(), strict=True):
        if shapely.get_num_coordinates(geom) <= TILE_VERTEX_THRESHOLD:
            geoms.append(geom)
            keys.append(k)
            continue
        minx, miny, maxx, maxy = geom.bounds
        for x in np.arange(np.floor(minx / TILE_M) * TILE_M, maxx, TILE_M):
            for y in np.arange(np.floor(miny / TILE_M) * TILE_M, maxy, TILE_M):
                piece = shapely.clip_by_rect(geom, x, y, x + TILE_M, y + TILE_M)
                if not piece.is_empty and shapely.area(piece) > 0:
                    geoms.append(piece)
                    keys.append(k)
    return np.array(geoms, dtype=object), np.array(keys, dtype=object)


def overlap_areas(cells: gpd.GeoSeries, gdf: gpd.GeoDataFrame, key: str) -> pd.DataFrame:
    """Area (m²) of each (cell index, key) intersection. Cells are positional indexes into `cells`."""
    gdf = gdf.sort_values(key, kind="stable")
    geoms, keys = tiled(gdf, key)
    tree = shapely.STRtree(geoms)
    cell_idx, geom_idx = tree.query(cells.to_numpy(), predicate="intersects")
    if len(cell_idx) == 0:
        return pd.DataFrame({"cell": [], "key": [], "area": []})
    areas = shapely.area(shapely.intersection(cells.to_numpy()[cell_idx], geoms[geom_idx]))
    df = pd.DataFrame({"cell": cell_idx, "key": keys[geom_idx], "area": areas})
    df = df[df.area > 0]
    return df.groupby(["cell", "key"], as_index=False, sort=True)["area"].sum()


def largest(overlaps: pd.DataFrame) -> pd.DataFrame:
    """Per cell, the key with the largest overlap; ties go to the smallest key."""
    ordered = overlaps.sort_values(["cell", "area", "key"], ascending=[True, False, True], kind="stable")
    return ordered.drop_duplicates("cell", keep="first").set_index("cell")


def points_within(points: gpd.GeoSeries, gdf: gpd.GeoDataFrame, key: str) -> pd.Series:
    """For each point (by position), the smallest key of a polygon containing it; missing if none."""
    gdf = gdf.sort_values(key, kind="stable")
    geoms, keys = tiled(gdf, key)
    tree = shapely.STRtree(geoms)
    pt_idx, geom_idx = tree.query(points.to_numpy(), predicate="intersects")
    df = pd.DataFrame({"pt": pt_idx, "key": keys[geom_idx]}).sort_values(["pt", "key"], kind="stable")
    return df.drop_duplicates("pt").set_index("pt")["key"]


def nearest_key(geoms: Iterable, gdf: gpd.GeoDataFrame, key: str) -> list:
    """Key of the nearest polygon for each geometry; ties go to the smallest key."""
    gdf = gdf.sort_values(key, kind="stable")
    parts, keys = tiled(gdf, key)
    tree = shapely.STRtree(parts)
    geoms = np.asarray(list(geoms), dtype=object)
    in_idx, tree_idx = tree.query_nearest(geoms, return_distance=False, all_matches=True)
    df = pd.DataFrame({"i": in_idx, "key": keys[tree_idx]}).sort_values(["i", "key"], kind="stable")
    first = df.drop_duplicates("i").set_index("i")["key"]
    return [first[i] for i in range(len(geoms))]


def zip_dataset(path, pattern: str = r"\.(shp|gpkg)$|\.gdb/?$") -> str:
    """GDAL path to the first dataset inside a zip whose member name matches `pattern`."""
    import re
    import zipfile

    with zipfile.ZipFile(path) as zf:
        names = sorted(zf.namelist())
    regex = re.compile(pattern, re.IGNORECASE)
    for name in names:
        # A .gdb is a directory; its members look like x.gdb/a0000001.gdbtable.
        gdb = re.match(r"(.*?\.gdb)/", name, re.IGNORECASE)
        candidate = gdb.group(1) if gdb else name
        if regex.search(candidate if not gdb else candidate + "/"):
            return f"/vsizip/{path}/{candidate}"
    raise FileNotFoundError(f"no dataset matching {pattern} in {path}")
