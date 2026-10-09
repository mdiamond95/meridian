"""Land with the large lakes taken out, each hexagon's principal land, and the land/water kind of a link
between two hexagons: the rule of the 1.0.5 hex tables (hexboard.py; docs/interop.md, "The neighbour
rule (1.0.5)").

- Land is the 2021 cartographic census subdivisions (as ridings.v1 and hexes.r4.v1 measure it) less
  the large lakes. A large lake is a named, permanent waterbody in the Atlas of Canada 1:1M of
  LAKE_MIN_KM2 or more that is not a river. The CSDs leave some of them out already (the Great Lakes,
  Lake of the Woods), at a finer shoreline than the Atlas's; the rest (Lake Winnipeg, Great Slave
  Lake) they count as land. A lake is taken out of the CSDs when they hold COVERED_SHARE of it or
  more, and then less the Atlas's islands that lie mostly inside it: its lake polygons have no holes,
  the islands being a layer of their own.
- A hexagon's land is closed by GAP_M: water narrower than GAP_M (a morphological closing, dilation
  then erosion by GAP_M / 2) joins the land on either side. The closing reads the land within GAP_M
  of the hexagon, so it is the same on both sides of a common edge.
- A hexagon's principal land is its part of the landmass holding the most of its actual land, a
  landmass being land closed by GAP_M, read in the hexagon and the six around it (so an isthmus cut
  by the hexagon's edge does not split one). The hexagon stands for that landmass: land of another
  in the hexagon (the other shore of a strait) is drawn and counted, but does not carry links.
- A link between two hexagons sharing an H3 edge is "land" when their principal lands meet along at
  least LAND_EDGE_M of that edge, otherwise "water".
"""

from __future__ import annotations

import re
from collections import OrderedDict
from dataclasses import dataclass

import geopandas as gpd
import h3
import numpy as np
import pandas as pd
import shapely

from common import EQUAL_AREA_CRS, WGS84, raw_file
from geo import cell_polygons, read_vector, zip_dataset
from unittables import intersect_pieces, tiled_parts

LAKE_MIN_KM2 = 1000.0
COVERED_SHARE = 0.5
RIVER = re.compile(r"\b(?:River|Rivière|Fleuve)\b")
GAP_M = 600.0
LAND_EDGE_M = 1.0
EDGE_BAND_M = 0.5  # how far from the common edge a principal land's touch is read
POINT_INSETS_M = (200.0, 1000.0, 3000.0)  # landPoint is this far inside the cell, where its land allows


def load_lakes(csds: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """The large lakes, one row per Atlas feature, largest first, in EPSG:3347: name, nameFr, km2 (the
    whole feature), csdKm2 (how much of it the CSDs hold), water (taken out of the CSDs) and geometry,
    which for a lake taken out is the water: the lake less the Atlas's islands."""
    gdf = read_vector(zip_dataset(raw_file("nrcan_atlas_waterbodies_1m"))).to_crs(EQUAL_AREA_CRS)
    gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
    gdf["km2"] = shapely.area(gdf.geometry.to_numpy()) / 1e6
    named = gdf["NAME"].notna() & (gdf["NAME"].str.strip() != "")
    keep = (gdf["TYPE"] == 1) & named & (gdf["km2"] >= LAKE_MIN_KM2)
    keep &= ~gdf["NAME"].fillna("").str.contains(RIVER)
    lakes = gdf[keep].rename(columns={"NAME": "name", "NOM": "nameFr"})
    lakes = lakes.sort_values(["km2", "name"], ascending=[False, True], kind="stable").reset_index(drop=True)
    lakes["lake"] = np.arange(len(lakes))

    csd_parts, _ = tiled_parts(csds, "csd")
    lake_parts, lake_keys = tiled_parts(lakes, "lake")
    il, ic = shapely.STRtree(csd_parts).query(lake_parts, predicate="intersects")
    held = shapely.area(shapely.intersection(lake_parts[il], csd_parts[ic]))
    lakes["csdKm2"] = np.bincount(lake_keys[il].astype(int), weights=held, minlength=len(lakes)) / 1e6
    lakes["water"] = lakes["csdKm2"] >= COVERED_SHARE * lakes["km2"]

    islands = read_vector(zip_dataset(raw_file("nrcan_atlas_islands_1m"))).to_crs(EQUAL_AREA_CRS)
    islands = shapely.make_valid(islands.geometry.to_numpy())
    tree = shapely.STRtree(islands)
    water = lakes["geometry"].to_numpy().copy()
    for k in np.flatnonzero(lakes["water"].to_numpy()):
        # The islands in the lake: those mostly inside it. The Atlas's islands include Baffin Island,
        # which holds Nettilling and Amadjuak Lakes and has no holes for them either.
        hit = np.sort(tree.query(water[k], predicate="intersects"))
        inside = hit[
            shapely.area(shapely.intersection(islands[hit], water[k])) >= 0.5 * shapely.area(islands[hit])
        ]
        if len(inside):
            water[k] = shapely.difference(water[k], shapely.union_all(islands[inside]))
    lakes["geometry"] = water
    return lakes[["lake", "name", "nameFr", "km2", "csdKm2", "water", "geometry"]]


@dataclass
class Land:
    """The CSDs and lakes cut into tiles, indexed, for reading the land around any polygon."""

    csd_parts: np.ndarray
    csd_tree: shapely.STRtree
    lake_parts: np.ndarray
    lake_keys: np.ndarray
    lake_tree: shapely.STRtree

    @classmethod
    def build(cls, csds: gpd.GeoDataFrame, lakes: gpd.GeoDataFrame) -> Land:
        csd_parts, _ = tiled_parts(csds, "csd")
        lake_parts, lake_keys = tiled_parts(lakes, "lake")
        return cls(csd_parts, shapely.STRtree(csd_parts), lake_parts, lake_keys, shapely.STRtree(lake_parts))

    def within(self, region: shapely.Geometry) -> shapely.Geometry:
        """Land inside `region`: the CSDs clipped to it, less the lakes."""
        idx = np.sort(self.csd_tree.query(region, predicate="intersects"))
        if not len(idx):
            return shapely.Polygon()
        land = shapely.union_all(shapely.intersection(self.csd_parts[idx], region))
        lakes = np.sort(self.lake_tree.query(region, predicate="intersects"))
        if len(lakes):
            land = shapely.difference(land, shapely.union_all(self.lake_parts[lakes]))
        return land


def land_pieces(
    units: gpd.GeoDataFrame, key: str, csds: gpd.GeoDataFrame, lakes: gpd.GeoDataFrame
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Every (unit, CSD) piece of land, as unittables.intersect_pieces, with the lakes taken out: columns
    a (unit), b (csd), area (m²), geometry. Also each lake's area taken out of the CSDs, per unit."""
    pieces = intersect_pieces(units, key, csds, "csd")
    lake_parts, lake_keys = tiled_parts(lakes, "lake")
    ip, il = shapely.STRtree(lake_parts).query(pieces["geometry"].to_numpy(), predicate="intersects")
    order = np.lexsort((il, ip))
    ip, il = ip[order], il[order]
    geoms = pieces["geometry"].to_numpy().copy()
    removed = []
    for i in np.unique(ip):
        hit = il[ip == i]
        before = geoms[i]
        cut = shapely.intersection(before, shapely.union_all(lake_parts[hit]))
        geoms[i] = shapely.difference(before, shapely.union_all(lake_parts[hit]))
        # Which lake each removed area belongs to (a piece can touch more than one).
        for lake in sorted(set(lake_keys[hit])):
            water = shapely.union_all(lake_parts[hit][lake_keys[hit] == lake])
            part = shapely.area(shapely.intersection(cut, water))
            if part > 0:
                removed.append({"a": pieces["a"].iat[i], "lake": int(lake), "area": part})
    pieces = pieces.assign(geometry=geoms, area=shapely.area(geoms))
    pieces = pieces[pieces["area"] > 0].reset_index(drop=True)
    return pieces, pd.DataFrame(removed, columns=["a", "lake", "area"])


@dataclass
class Principal:
    land_m2: float  # the cell's land, as read here (hexboard.py checks it against the CSD overlay)
    geometry: shapely.Geometry  # the hexagon's part of the landmass it stands for, closed by GAP_M
    share: float  # of the hexagon's actual land, the part in that landmass
    pieces: int  # landmasses with land in the hexagon
    point: tuple[float, float]  # [lng, lat] of a point on the hexagon's actual land in that landmass


def _closed(land: Land, polygon: shapely.Geometry) -> tuple[shapely.Geometry, shapely.Geometry]:
    """The land in `polygon` and the land closed by GAP_M there. The closing reads the land within
    GAP_M of the polygon, so it is what a closing of all of Canada would give inside it."""
    region = shapely.buffer(polygon, GAP_M + 50.0)
    around = land.within(region)
    if shapely.area(around) >= shapely.area(region) * (1 - 1e-9):
        # Land all round: the cell is all land and closing changes nothing. Not intersected: GEOS
        # can return a sliver for a polygon cut out of one that all but equals its buffer.
        return polygon, polygon
    own = shapely.intersection(around, polygon)
    closed = shapely.buffer(shapely.buffer(around, GAP_M / 2), -GAP_M / 2)
    return own, shapely.intersection(closed, polygon)


def _parts(geom: shapely.Geometry) -> list[shapely.Geometry]:
    return [g for g in shapely.get_parts(geom) if g.geom_type == "Polygon" and shapely.area(g) > 0]


def _land_point(cell: str, land: shapely.Geometry) -> tuple[float, float]:
    """[lng, lat], to 5 decimals, of a point on `land` that H3's own test puts in `cell`. The cell's
    polygon here has straight edges in EPSG:3347 and H3's do not, hundreds of metres apart at worst, so
    the point is taken from the land inset by POINT_INSETS_M in turn, the first that H3 agrees with;
    failing all, the land itself (a sliver along the edge)."""
    polygon = cell_polygons([cell]).iloc[0]
    candidates = []
    for inset in POINT_INSETS_M:
        inner = shapely.intersection(land, shapely.buffer(polygon, -inset))
        if shapely.area(inner) > 0:
            candidates.append(shapely.point_on_surface(inner))
    candidates.append(shapely.point_on_surface(land))
    points = gpd.GeoSeries(candidates, crs=EQUAL_AREA_CRS).to_crs(WGS84)
    lnglat = [(round(p.x, 5), round(p.y, 5)) for p in points]
    resolution = h3.get_resolution(cell)
    return next((p for p in lnglat if h3.latlng_to_cell(p[1], p[0], resolution) == cell), lnglat[-1])


class Principals:
    """Principal lands of H3 cells (any resolution, any cells), each cell's closed land computed once
    at the cell's size and kept for its neighbours (the last CACHE cells: cells are asked for in H3
    order, which keeps neighbours close)."""

    CACHE = 256

    def __init__(self, land: Land):
        self.land = land
        self.cache: OrderedDict[str, tuple[shapely.Geometry, list[shapely.Geometry]]] = OrderedDict()

    def closed(self, cell: str) -> tuple[shapely.Geometry, list[shapely.Geometry]]:
        """The cell's land and the pieces of its closed land."""
        if cell in self.cache:
            self.cache.move_to_end(cell)
            return self.cache[cell]
        own, closed = _closed(self.land, cell_polygons([cell]).iloc[0])
        found = (own, _parts(closed))
        self.cache[cell] = found
        if len(self.cache) > self.CACHE:
            self.cache.popitem(last=False)
        return found

    def of(self, cell: str) -> Principal | None:
        """The principal land of one cell, None when it has no land: of the landmasses (land closed by
        GAP_M) in the cell and the six around it, the one holding the most of the cell's land, as far
        as it lies in the cell. Pieces of the cell joined only outside it (an isthmus cut by its edge)
        are one landmass; two shores of a strait are not, as they are not joined nearby. Pieces of
        neighbouring cells are joined where they meet along a common edge, which is where closed land
        crosses it: the closing is the same on both sides."""
        own, parts = self.closed(cell)
        own_area = shapely.area(own)
        if own_area <= 0:
            return None
        if len(parts) > 1:
            parts = self._landmasses(cell, parts)
        held = [shapely.area(shapely.intersection(own, g)) for g in parts]
        # The most actual land; then the larger closed piece; then the lower-left representative point.
        rank = sorted(
            range(len(parts)),
            key=lambda k: (-held[k], -shapely.area(parts[k]), shapely.get_coordinates(parts[k])[0].tolist()),
        )
        best = parts[rank[0]]
        point = _land_point(cell, shapely.intersection(own, best))
        return Principal(own_area, best, held[rank[0]] / own_area, len(parts), point)

    def _landmasses(self, cell: str, parts: list[shapely.Geometry]) -> list[shapely.Geometry]:
        """The cell's pieces, joined into one geometry per landmass of the cell and its six neighbours."""
        disk = sorted(h3.grid_disk(cell, 1))
        pieces = {c: (parts if c == cell else self.closed(c)[1]) for c in disk}
        root = {(c, k): (c, k) for c in disk for k in range(len(pieces[c]))}

        def find(x):
            while root[x] != x:
                root[x] = root[root[x]]
                x = root[x]
            return x

        pairs = [(a, b) for a in disk for b in disk if a < b and h3.are_neighbor_cells(a, b)]
        for (a, b), edge in zip(pairs, edge_lines(pairs), strict=True):
            touch_a = [_touch(edge, g) for g in pieces[a]]
            touch_b = [_touch(edge, g) for g in pieces[b]]
            for i, ia in enumerate(touch_a):
                for j, ib in enumerate(touch_b):
                    if _overlap(ia, ib, float(shapely.length(edge))) >= LAND_EDGE_M:
                        root[find((a, i))] = find((b, j))
        groups: dict = {}
        for k, g in enumerate(parts):
            groups.setdefault(find((cell, k)), []).append(g)
        return [shapely.union_all(g) if len(g) > 1 else g[0] for g in groups.values()]


def edge_lines(pairs: list[tuple[str, str]]) -> np.ndarray:
    """H3's own boundary between each pair of adjacent cells, projected as the cells are."""
    lines = [
        shapely.LineString(
            [(lng, lat) for lat, lng in h3.directed_edge_to_boundary(h3.cells_to_directed_edge(a, b))]
        )
        for a, b in pairs
    ]
    return gpd.GeoSeries(lines, crs=WGS84).to_crs(EQUAL_AREA_CRS).to_numpy()


def _touch(edge: shapely.LineString, land: shapely.Geometry) -> list[tuple[float, float]]:
    """The intervals of `edge` (distances along it) where `land` reaches the edge."""
    near = shapely.intersection(shapely.buffer(edge, EDGE_BAND_M, cap_style="flat"), land)
    out = []
    for part in shapely.get_parts(near):
        if shapely.area(part) <= 0:
            continue
        along = shapely.line_locate_point(edge, shapely.points(shapely.get_coordinates(part)))
        out.append((float(along.min()), float(along.max())))
    return out


def _overlap(ia: list[tuple[float, float]], ib: list[tuple[float, float]], cap: float) -> float:
    total = 0.0
    for lo_a, hi_a in ia:
        for lo_b, hi_b in ib:
            total += max(0.0, min(hi_a, hi_b) - max(lo_a, lo_b))
    # Intervals on one side can overlap one another; the edge is the cap.
    return min(total, cap)


def shared_metres(edge: shapely.LineString, a: shapely.Geometry, b: shapely.Geometry) -> float:
    """Length of the common edge along which both principal lands reach it."""
    return _overlap(_touch(edge, a), _touch(edge, b), float(shapely.length(edge)))


def link_kinds(
    pairs: list[tuple[str, str]], principals: dict[str, Principal]
) -> dict[tuple[str, str], tuple[str, float]]:
    """("land" | "water", metres of the edge where the principal lands meet) for each pair."""
    edges = edge_lines(pairs)
    out = {}
    for (a, b), edge in zip(pairs, edges, strict=True):
        pa, pb = principals.get(a), principals.get(b)
        metres = shared_metres(edge, pa.geometry, pb.geometry) if pa and pb else 0.0
        out[(a, b)] = ("land" if metres >= LAND_EDGE_M else "water", metres)
    return out
