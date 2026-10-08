"""Shared by the unit-table steps (ridings.py, hexes.py): overlays cut into tiles, the TopoJSON
decoder, arc adjacency, and the de jure jurisdiction spans read from the atlas
(docs/interop.md, "Unit tables")."""

from __future__ import annotations

import gzip
import json
from collections import defaultdict

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from shapely.geometry import shape

from common import BUILD, EQUAL_AREA_CRS, WGS84
from geo import TILE_M, TILE_VERTEX_THRESHOLD

ATLAS_PATH = BUILD / "atlas.v1.json"
ATLAS_TOPOLOGY = BUILD / "atlas.v1.topojson.gz"
START = "1867-07-01"
CHUNK = 20_000  # intersections overlaid at a time (intersect_pieces)
PROVINCES = {
    "10": "NL", "11": "PE", "12": "NS", "13": "NB", "24": "QC", "35": "ON", "46": "MB",
    "47": "SK", "48": "AB", "59": "BC", "60": "YT", "61": "NT", "62": "NU",
}  # fmt: skip


def load_gz(path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


# --- geometry -------------------------------------------------------------------------------


def tiled_parts(gdf: gpd.GeoDataFrame, key: str) -> tuple[np.ndarray, np.ndarray]:
    """geo.tiled, except that a square where GEOS's clip_by_rect throws (it can on a valid polygon:
    the atlas's Keewatin, 1889–1905) is cut with a full intersection instead."""
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
                try:
                    piece = shapely.clip_by_rect(geom, x, y, x + TILE_M, y + TILE_M)
                except shapely.errors.GEOSException:
                    piece = shapely.intersection(geom, shapely.box(x, y, x + TILE_M, y + TILE_M))
                if not piece.is_empty and shapely.area(piece) > 0:
                    geoms.append(piece)
                    keys.append(k)
    return np.array(geoms, dtype=object), np.array(keys, dtype=object)


def nearest_keys(geoms: np.ndarray, gdf: gpd.GeoDataFrame, key: str) -> list:
    """geo.nearest_key over tiled_parts: the key of the nearest polygon to each geometry, ties to
    the smallest key."""
    parts, keys = tiled_parts(gdf.sort_values(key, kind="stable"), key)
    in_idx, tree_idx = shapely.STRtree(parts).query_nearest(geoms, return_distance=False, all_matches=True)
    df = pd.DataFrame({"i": in_idx, "key": keys[tree_idx]}).sort_values(["i", "key"], kind="stable")
    first = df.drop_duplicates("i").set_index("i")["key"]
    return [first[i] for i in range(len(geoms))]


def intersect_pieces(
    a: gpd.GeoDataFrame, a_key: str, b: gpd.GeoDataFrame, b_key: str, geometry: bool = True
) -> pd.DataFrame:
    """Every non-empty intersection of a's and b's polygons, both cut into tiled_parts squares first so
    no single overlay is large: columns a, b, area (m²) and, if `geometry`, the intersection, in a
    deterministic order. Overlaid in chunks, so only the kept geometries are resident."""
    ga, ka = tiled_parts(a.sort_values(a_key, kind="stable"), a_key)
    gb, kb = tiled_parts(b.sort_values(b_key, kind="stable"), b_key)
    ia, ib = shapely.STRtree(gb).query(ga, predicate="intersects")
    order = np.lexsort((ib, ia))
    ia, ib = ia[order], ib[order]
    frames = []
    for lo in range(0, len(ia), CHUNK):
        ca, cb = ia[lo : lo + CHUNK], ib[lo : lo + CHUNK]
        geoms = shapely.intersection(ga[ca], gb[cb])
        areas = shapely.area(geoms)
        keep = areas > 0
        frame = {"a": ka[ca][keep], "b": kb[cb][keep], "area": areas[keep]}
        frames.append(pd.DataFrame(frame | ({"geometry": geoms[keep]} if geometry else {})))
        del geoms
    return pd.concat(frames, ignore_index=True)


def topology_geometry(topo: dict, obj: dict) -> shapely.Geometry:
    """One quantized, delta-encoded TopoJSON (Multi)Polygon as a shapely geometry."""
    (sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]

    def arc(index: int) -> list[tuple[float, float]]:
        xy = np.cumsum(np.asarray(topo["arcs"][index if index >= 0 else ~index], dtype=np.float64), axis=0)
        points = list(zip(xy[:, 0] * sx + tx, xy[:, 1] * sy + ty, strict=True))
        return points if index >= 0 else points[::-1]

    def ring(indices: list[int]) -> list[tuple[float, float]]:
        coords: list[tuple[float, float]] = []
        for k, index in enumerate(indices):
            coords.extend(arc(index)[1 if k else 0 :])
        return coords

    def polygon(rings: list[list[int]]) -> list[list[tuple[float, float]]]:
        # Quantization can collapse a sliver to a closed ring of 3 points (Keewatin 1889–1905): it
        # encloses no area, so drop it; a polygon whose shell collapsed is dropped whole.
        coords = [ring(r) for r in rings]
        return [c for c in coords if len(c) >= 4] if len(coords[0]) >= 4 else []

    polygons = [obj["arcs"]] if obj["type"] == "Polygon" else obj["arcs"]
    parts = [p for p in (polygon(rings) for rings in polygons) if p]
    return shape({"type": "MultiPolygon", "coordinates": parts})


def arc_neighbours(topo: dict, object_name: str, key: str) -> dict[int, list[int]]:
    """For each geometry's `key` property, the keys of the geometries sharing at least one arc."""
    owners: dict[int, set[int]] = defaultdict(set)

    def walk(arcs, owner: int) -> None:
        if isinstance(arcs, int):
            owners[arcs if arcs >= 0 else ~arcs].add(owner)
        else:
            for item in arcs:
                walk(item, owner)

    geometries = topo["objects"][object_name]["geometries"]
    for g in geometries:
        walk(g.get("arcs", []), int(g["properties"][key]))
    out: dict[int, set[int]] = {int(g["properties"][key]): set() for g in geometries}
    for group in owners.values():
        for owner in group:
            out[owner] |= group - {owner}
    return {k: sorted(v) for k, v in sorted(out.items())}


# --- the atlas ------------------------------------------------------------------------------


def intervals(atlas: dict) -> list[tuple[str, str | None]]:
    """[from, to) between consecutive atlas event dates from START; the last runs on (to = None)."""
    dates = sorted({e["date"] for e in atlas["events"] if e["date"] >= START} | {START})
    changes = {
        d
        for u in atlas["units"]
        if u["truth"] == "dejure"
        for d in (u["validFrom"], u["validTo"])
        if d is not None and d > START
    }
    if not changes <= set(dates):
        raise ValueError(f"de jure units change on dates that are not events: {sorted(changes - set(dates))}")
    return list(zip(dates, [*dates[1:], None], strict=True))


def units_on(atlas: dict, date: str) -> list[dict]:
    return sorted(
        (
            u
            for u in atlas["units"]
            if u["truth"] == "dejure"
            and u["validFrom"] <= date
            and (u["validTo"] is None or date < u["validTo"])
        ),
        key=lambda u: u["id"],
    )


def merge_spans(spans: list[dict]) -> list[dict]:
    """Join consecutive spans whose unit, name, status, sovereign and fallback agree; the share kept
    is the smallest over the joined span."""
    out: list[dict] = []
    same = ("unit", "name", "status", "sovereign", "fallback")
    for span in spans:
        prev = out[-1] if out else None
        if prev and prev["to"] == span["from"] and all(prev.get(k) == span.get(k) for k in same):
            prev["to"] = span["to"]
            prev["share"] = min(prev["share"], span["share"])
        else:
            out.append(dict(span))
    return out


def jurisdictions(
    ids: list, geometries: np.ndarray, land_keys: np.ndarray, land_geoms: np.ndarray, land_m2: np.ndarray, log
) -> list[list[dict]]:
    """Per unit (by position in `ids`), its merged jurisdiction spans: for each interval, the de jure
    unit whose drawing covers the largest share of the unit's land (`land_geoms`, keyed by
    `land_keys`; `land_m2` by position), never a point test. Where none overlaps, the unit nearest
    to `geometries`, with share 0 and fallback: true."""
    atlas = json.loads(ATLAS_PATH.read_text(encoding="utf-8"))
    topo = load_gz(ATLAS_TOPOLOGY)
    spans_of = intervals(atlas)
    refs = sorted({u["geometryRef"] for start, _ in spans_of for u in units_on(atlas, start)})
    shapes = gpd.GeoSeries([topology_geometry(topo, topo["objects"][r]) for r in refs], crs=WGS84).to_crs(
        EQUAL_AREA_CRS
    )
    drawings = gpd.GeoDataFrame(
        {"ref": refs}, geometry=shapely.make_valid(shapes.to_numpy()), crs=EQUAL_AREA_CRS
    )
    log(f"atlas: {len(spans_of)} intervals from {START}, {len(refs)} de jure drawings")

    pieces = gpd.GeoDataFrame({"key": land_keys}, geometry=land_geoms, crs=EQUAL_AREA_CRS)
    over = intersect_pieces(pieces, "key", drawings, "ref", geometry=False)
    area = over.groupby(["a", "b"], sort=True)["area"].sum()
    by_id: dict = defaultdict(dict)
    for (key, ref), a in area.items():
        by_id[key][ref] = float(a)

    rows: list[list[dict]] = [[] for _ in ids]
    for start, end in spans_of:
        units = units_on(atlas, start)
        nearest: dict = {}
        for i, key in enumerate(ids):
            # The largest overlap; equal areas go to the smaller unit id.
            overlaps = [(by_id[key].get(u["geometryRef"], 0.0), u) for u in units]
            best_area, best = min(overlaps, key=lambda t: (-t[0], t[1]["id"]))
            span = {"from": start, "to": end}
            if best_area > 0:
                share = min(1.0, best_area / land_m2[i])
                span |= {"unit": best["id"], "name": best["name"], "status": best["status"]}
                span |= {"sovereign": best["sovereign"], "share": round(share, 3)}
            else:
                if not nearest:
                    drawn = drawings.set_index("ref").geometry
                    gdf = gpd.GeoDataFrame(
                        {"id": [u["id"] for u in units]},
                        geometry=[drawn[u["geometryRef"]] for u in units],
                        crs=EQUAL_AREA_CRS,
                    )
                    nearest = dict(zip(ids, nearest_keys(geometries, gdf, "id"), strict=True))
                unit = next(u for u in units if u["id"] == nearest[key])
                span |= {"unit": unit["id"], "name": unit["name"], "status": unit["status"]}
                span |= {"sovereign": unit["sovereign"], "share": 0.0, "fallback": True}
            rows[i].append(span)
    return [merge_spans(r) for r in rows]
