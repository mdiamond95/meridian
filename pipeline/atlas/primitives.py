"""Boundary primitives for the historical atlas (docs/plan.md, Phase 2 Sitting A).

Historical boundaries were defined in words: a parallel, a meridian, a river from one point to
another, the height of land. Each primitive here turns one such phrase into a shapely geometry in
WGS84 longitude/latitude, and `ring` stitches an ordered walk of them into a polygon.

Coordinates are (lon, lat) degrees throughout. Parallels and meridians are straight in lon/lat and
in the app's Web Mercator, so they need no densifying. Every function is deterministic: inputs are
sorted before any index or graph is built, and ties go to the first in that order.
"""

from __future__ import annotations

import heapq
import math
from collections.abc import Iterable, Sequence

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import split, substring

EARTH_RADIUS_KM = 6371.0088
# Largest gap `ring` closes with a straight segment. Bigger gaps are authoring mistakes.
RING_GAP_KM = 5.0
# Uncovered coastal land is assigned to drainage regions in tiles of this size (~10 km).
TILE_DEG = 0.1

LonLat = tuple[float, float]


def km_between(a: LonLat, b: LonLat) -> float:
    """Great-circle distance in km."""
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def parallel(lat: float, lon0: float, lon1: float) -> LineString:
    """The parallel `lat` from longitude lon0 to lon1 (direction preserved)."""
    return LineString([(lon0, lat), (lon1, lat)])


def meridian(lon: float, lat0: float, lat1: float) -> LineString:
    """The meridian `lon` from latitude lat0 to lat1 (direction preserved)."""
    return LineString([(lon, lat0), (lon, lat1)])


def line(points: Sequence[LonLat]) -> LineString:
    """Straight segments through the given points: a surveyed line, or a closing run across open
    water that the land clip removes."""
    if len(points) < 2:
        raise ValueError("a line needs at least two points")
    return LineString(points)


def _single_line(geom: shapely.Geometry, what: str) -> LineString:
    merged = shapely.line_merge(geom) if geom.geom_type == "MultiLineString" else geom
    if merged.geom_type == "LineString":
        return merged
    if merged.geom_type == "MultiLineString":
        parts = ", ".join(f"{p.length:.3f}°" for p in merged.geoms)
        raise ValueError(f"{what} is {len(merged.geoms)} disjoint lines ({parts}); give from/to points")
    raise ValueError(f"{what} is empty or not a line ({merged.geom_type})")


def between(path: LineString, start: LonLat, end: LonLat) -> LineString:
    """The part of `path` from the point nearest `start` to the point nearest `end`, oriented
    start → end."""
    a = path.project(Point(start))
    b = path.project(Point(end))
    piece = substring(path, min(a, b), max(a, b))
    if piece.geom_type != "LineString" or piece.length == 0:
        raise ValueError(f"no path between {start} and {end}")
    return piece if a <= b else piece.reverse()


def modern_border(
    a: shapely.Geometry,
    b: shapely.Geometry,
    start: LonLat | None = None,
    end: LonLat | None = None,
    tolerance_deg: float = 1e-6,
) -> LineString:
    """The boundary `a` shares with `b` (two modern units, e.g. Manitoba and Ontario), optionally cut
    to run from `start` to `end`.

    Shared edges come from one coverage, so they coincide to `tolerance_deg`; the buffer only absorbs
    floating-point noise. A border made of several pieces (a lake in between) needs start and end,
    and the gaps are bridged along a's boundary.
    """
    shared = shapely.intersection(a.boundary, b.buffer(tolerance_deg))
    shared = shapely.line_merge(shapely.union_all([g for g in _lines(shared)]))
    if shared.is_empty:
        raise ValueError("the two units share no border")
    if start is None or end is None:
        return _single_line(shared, "modern border")
    if shared.geom_type == "LineString":
        return between(shared, start, end)
    # Several pieces: walk a's boundary ring that is nearest, between the two points.
    rings = sorted(_rings(a), key=lambda r: (r.distance(Point(start)) + r.distance(Point(end)), r.length))
    return ring_between(rings[0], start, end, shorter_through=shared)


def _lines(geom: shapely.Geometry) -> Iterable[LineString]:
    if geom.is_empty:
        return
    if geom.geom_type == "LineString":
        yield geom
    elif geom.geom_type in ("MultiLineString", "GeometryCollection"):
        for part in geom.geoms:
            yield from _lines(part)


def _rings(geom: shapely.Geometry) -> list[LineString]:
    polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    rings: list[LineString] = []
    for poly in polys:
        if poly.geom_type == "Polygon":
            rings.append(LineString(poly.exterior.coords))
            rings.extend(LineString(r.coords) for r in poly.interiors)
    return rings


def ring_between(
    closed: LineString, start: LonLat, end: LonLat, shorter_through: shapely.Geometry | None = None
) -> LineString:
    """One of the two arcs of a closed ring between two points, oriented start → end.

    Without `shorter_through` the shorter arc is returned; with it, the arc that runs more of its
    length within that geometry (e.g. a shared border) wins.
    """
    total = closed.length
    a = closed.project(Point(start))
    b = closed.project(Point(end))
    forward = _ring_arc(closed, a, b, total)
    backward = _ring_arc(closed, b, a, total).reverse()
    if shorter_through is None:
        return forward if forward.length <= backward.length else backward
    score = [
        shapely.intersection(arc, shorter_through.buffer(1e-5)).length / max(arc.length, 1e-12)
        for arc in (forward, backward)
    ]
    return forward if score[0] >= score[1] else backward


def _ring_arc(closed: LineString, a: float, b: float, total: float) -> LineString:
    """Arc from distance a to b travelling in the ring's own direction, wrapping past the start."""
    if a <= b:
        return substring(closed, a, b)
    coords = list(substring(closed, a, total).coords) + list(substring(closed, 0, b).coords)[1:]
    return LineString(coords)


def coast(land: shapely.Geometry, start: LonLat, end: LonLat, side: str) -> LineString:
    """The shoreline of `land` from `start` to `end`, walked with the land on `side` ("left" or
    "right"). Both points snap to the nearest shoreline ring, which must be the same for both."""
    if side not in ("left", "right"):
        raise ValueError("side must be 'left' or 'right'")
    polys = [land] if land.geom_type == "Polygon" else list(land.geoms)
    oriented = [shapely.orient_polygons(p) for p in polys]  # exterior CCW: land on the left
    rings = [LineString(p.exterior.coords) for p in oriented]
    nearest = min(range(len(rings)), key=lambda i: (rings[i].distance(Point(start)), i))
    if rings[nearest].distance(Point(end)) > rings[nearest].distance(Point(start)) + 0.5:
        raise ValueError(f"{start} and {end} are not on the same shoreline")
    closed = rings[nearest]
    a, b = closed.project(Point(start)), closed.project(Point(end))
    if side == "left":
        return _ring_arc(closed, a, b, closed.length)
    return _ring_arc(closed, b, a, closed.length).reverse()


def river(network: Iterable[LineString], start: LonLat, end: LonLat, bridge_km: float = 0.0) -> LineString:
    """The shortest path along a river network from the vertex nearest `start` to the vertex
    nearest `end`.

    Canada1Water names the river's reaches but not the flow lines through the lakes on it (Lac
    Seul on the English River), so the named reaches fall apart into pieces. `bridge_km` joins each
    loose end to the nearest vertex of another piece within that distance, in a straight line.
    """
    graph: dict[LonLat, list[tuple[float, LonLat]]] = {}
    for geom in network:
        for part in _lines(geom):
            coords = [(round(x, 7), round(y, 7)) for x, y in part.coords]
            for u, v in zip(coords, coords[1:], strict=False):
                if u == v:
                    continue
                w = km_between(u, v)
                graph.setdefault(u, []).append((w, v))
                graph.setdefault(v, []).append((w, u))
    if not graph:
        raise ValueError("empty river network")
    nodes = sorted(graph)
    if bridge_km > 0:
        _bridge(graph, nodes, bridge_km)
    source = min(nodes, key=lambda n: km_between(n, start))
    target = min(nodes, key=lambda n: km_between(n, end))
    for label, node, point in (("start", source, start), ("end", target, end)):
        if km_between(node, point) > RING_GAP_KM * 4:
            raise ValueError(f"river {label} {point} is {km_between(node, point):.1f} km from the network")
    dist = {source: 0.0}
    prev: dict[LonLat, LonLat] = {}
    queue = [(0.0, source)]
    while queue:
        d, node = heapq.heappop(queue)
        if node == target:
            break
        if d > dist[node]:
            continue
        for w, nxt in sorted(graph[node]):
            nd = d + w
            if nd < dist.get(nxt, math.inf):
                dist[nxt] = nd
                prev[nxt] = node
                heapq.heappush(queue, (nd, nxt))
    if target not in dist:
        raise ValueError(f"no connected river path from {start} to {end}")
    path = [target]
    while path[-1] != source:
        path.append(prev[path[-1]])
    path.reverse()
    if len(path) < 2:
        raise ValueError("river start and end snap to the same vertex")
    return LineString(path)


def _bridge(graph: dict[LonLat, list[tuple[float, LonLat]]], nodes: list[LonLat], max_km: float) -> None:
    """Join loose ends (degree-1 vertices) to the nearest vertex of a different connected piece."""
    component: dict[LonLat, int] = {}
    for label, seed in enumerate(nodes):
        if seed in component:
            continue
        stack = [seed]
        component[seed] = label
        while stack:
            for _, nxt in graph[stack.pop()]:
                if nxt not in component:
                    component[nxt] = label
                    stack.append(nxt)
    tree = shapely.STRtree([Point(n) for n in nodes])
    # A degree of latitude is ~111 km; longitude degrees are shorter, so this over-selects safely.
    radius_deg = max_km / 111.0 / math.cos(math.radians(80))
    bridges = []
    for end in nodes:
        if len(graph[end]) != 1:
            continue
        near = tree.query(Point(end).buffer(radius_deg))
        candidates = sorted(
            (km_between(end, nodes[i]), nodes[i]) for i in near if component[nodes[i]] != component[end]
        )
        if candidates and candidates[0][0] <= max_km:
            bridges.append((end, *candidates[0]))
    for end, w, other in bridges:
        graph[end].append((w, other))
        graph[other].append((w, end))


def partition(
    regions: Sequence[tuple[str, shapely.Geometry]], land: shapely.Geometry
) -> dict[str, shapely.Geometry]:
    """Split `land` among `regions` ((key, polygon) pairs that tile the country, e.g. StatCan
    drainage regions): each region takes the land it covers.

    Regions and land come from different coastlines, so land no region covers (coastal slivers,
    small islands) is cut into TILE_DEG tiles, and each tile piece joins the region with the
    nearest boundary vertex.
    """
    keys = [key for key, _ in regions]
    pieces: dict[str, list[shapely.Geometry]] = {
        key: [shapely.intersection(geom, land)] for key, geom in regions
    }
    leftover = polygonal(shapely.difference(land, shapely.union_all([g for _, g in regions])))
    if leftover is not None:
        owner, vertices = [], []
        for i, (_, geom) in enumerate(regions):
            coords = shapely.get_coordinates(shapely.segmentize(geom.boundary, TILE_DEG))
            vertices.append(shapely.points(coords))
            owner.extend([i] * len(coords))
        tree = shapely.STRtree(np.concatenate(vertices))
        tiles = tile(leftover, TILE_DEG)
        nearest = tree.query_nearest(shapely.point_on_surface(tiles), all_matches=False)[1]
        for piece, vertex in zip(tiles, nearest, strict=True):
            pieces[keys[owner[vertex]]].append(piece)
    return {key: polygonal(shapely.union_all(parts)) or shapely.Polygon() for key, parts in pieces.items()}


def drainage(
    regions: Sequence[tuple[str, shapely.Geometry]], selected: Iterable[str], land: shapely.Geometry
) -> shapely.Geometry:
    """The part of `land` draining through the `selected` regions (see `partition`)."""
    return select(partition(regions, land), selected)


def select(parts: dict[str, shapely.Geometry], selected: Iterable[str]) -> shapely.Geometry:
    wanted = set(selected)
    if not wanted <= set(parts):
        raise ValueError(f"unknown drainage regions {sorted(wanted - set(parts))}")
    return polygonal(shapely.union_all([parts[k] for k in sorted(wanted)])) or shapely.Polygon()


def hbc_watershed(regions: Sequence[tuple[str, str, shapely.Geometry]], land: shapely.Geometry):
    """Rupert's Land as the charter defined it: the lands draining to Hudson Bay and Hudson Strait.
    `regions` are (region code, ocean drainage area name, polygon)."""
    hudson = hudson_bay_codes(regions)
    return drainage([(code, geom) for code, _, geom in regions], hudson, land)


def hudson_bay_codes(regions: Sequence[tuple[str, str, shapely.Geometry]]) -> list[str]:
    codes = [code for code, ocean, _ in regions if ocean == "Hudson Bay"]
    if not codes:
        raise ValueError("no Hudson Bay drainage regions")
    return codes


def tile(geom: shapely.Geometry, size_deg: float) -> list[shapely.Geometry]:
    """The non-empty pieces of `geom` cut by a lon/lat grid of `size_deg` squares, in grid order.
    A square crossing several parts of `geom` gives one piece per part."""
    parts = np.array(list(getattr(geom, "geoms", [geom])), dtype=object)
    minx, miny, maxx, maxy = geom.bounds
    cols = np.arange(math.floor(minx / size_deg), math.ceil(maxx / size_deg))
    rows = np.arange(math.floor(miny / size_deg), math.ceil(maxy / size_deg))
    cc, rr = np.meshgrid(cols, rows, indexing="ij")
    boxes = shapely.box(
        cc.ravel() * size_deg, rr.ravel() * size_deg, (cc.ravel() + 1) * size_deg, (rr.ravel() + 1) * size_deg
    )
    box_idx, part_idx = shapely.STRtree(parts).query(boxes, predicate="intersects")
    pieces = shapely.intersection(boxes[box_idx], parts[part_idx])
    order = np.lexsort((part_idx, box_idx))  # grid order, then part order
    return [piece for piece in (polygonal(pieces[i]) for i in order) if piece is not None]


def cut(geom: shapely.Geometry, blade: LineString, keep: LonLat) -> shapely.Geometry:
    """The piece of `geom` on the `keep` side of `blade`: a line across a neck of land (an
    isthmus) whose ends lie outside `geom`. Raises if the line does not split the part it crosses."""
    point = Point(keep)
    part = next((g for g in getattr(geom, "geoms", [geom]) if g.covers(point)), None)
    if part is None:
        raise ValueError(f"{keep} is not in the geometry to cut")
    pieces = list(split(part, blade).geoms)
    if len(pieces) < 2:
        raise ValueError("the cut line does not cross the land from edge to edge")
    return next(piece for piece in pieces if piece.covers(point))


def island(land: shapely.Geometry, at: LonLat) -> shapely.Geometry:
    """The polygon part of `land` containing the point `at` (an island, named by a point on it)."""
    point = Point(at)
    for part in getattr(land, "geoms", [land]):
        if part.covers(point):
            return part
    raise ValueError(f"{at} is not on land")


def ring(parts: Sequence[LineString], max_gap_km: float = RING_GAP_KM) -> Polygon:
    """Stitch an ordered walk of boundary pieces into a polygon.

    Each piece may be given in either direction; it is flipped when its far end is nearer the walk
    so far. Consecutive pieces must meet within `max_gap_km` (closed with a straight segment), and
    so must the last and the first.
    """
    if len(parts) < 2:
        raise ValueError("a ring needs at least two pieces")
    lines = [_single_line(p, f"ring piece {i}") for i, p in enumerate(parts)]
    first, second = lines[0], lines[1]
    ends = [first.coords[0], first.coords[-1]]
    second_ends = [second.coords[0], second.coords[-1]]
    # Orient the first piece so its end meets the second piece.
    if min(km_between(ends[0], e) for e in second_ends) < min(km_between(ends[1], e) for e in second_ends):
        first = first.reverse()
    coords = list(first.coords)
    for i, piece in enumerate(lines[1:], start=1):
        here = coords[-1]
        forward, backward = km_between(here, piece.coords[0]), km_between(here, piece.coords[-1])
        if backward < forward:
            piece, gap = piece.reverse(), backward
        else:
            gap = forward
        if gap > max_gap_km:
            raise ValueError(f"ring piece {i} starts {gap:.1f} km from the end of piece {i - 1}")
        coords.extend(piece.coords[1:] if gap == 0 else piece.coords)
    closing = km_between(coords[-1], coords[0])
    if closing > max_gap_km:
        raise ValueError(f"ring does not close: {closing:.1f} km from last piece to first")
    if coords[-1] != coords[0]:
        coords.append(coords[0])
    poly = polygonal(shapely.make_valid(Polygon(coords)))
    if poly is None:
        raise ValueError("ring encloses no area")
    return poly


def polygonal(geom: shapely.Geometry | None) -> shapely.Geometry | None:
    """Polygon parts only (set operations can leave line or point slivers)."""
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    parts = [g for g in getattr(geom, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else None


__all__ = [
    "between",
    "coast",
    "cut",
    "drainage",
    "partition",
    "select",
    "hbc_watershed",
    "island",
    "km_between",
    "line",
    "meridian",
    "modern_border",
    "parallel",
    "polygonal",
    "ring",
    "ring_between",
    "river",
]
