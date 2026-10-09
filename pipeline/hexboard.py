"""Build the 1.0.5 hex board: data/build/hexes.r4.v1.2.json.gz and data/build/hexes.r5.v1.json.gz, with
their land-clipped layers under data/build/layers/.

    make hexboard     (after hexes: reads mesh, attrs, places, the atlas, the CSDs, the Atlas of Canada
                       waterbodies and the Wikidata dates)

Two unit tables (format "meridian.unitTable"; docs/interop.md, "Unit tables"), for House of Cards's hex
board:

- hexes.r4.v1.2 ("h3_r4"): hexes.r4.v1 regenerated (versioning rule 7: the released file stays) with
  the large lakes as water and the 1.0.5 neighbour rule (landlinks.py). Every field is made as in
  hexes.py, over the new land: a hexagon left with no land is not a row. New on every row: landPoint
  (a point on the principal land), settledYear, settledPlace and settledSource; and on every row of
  CITY_PEOPLE or more, cityYear, cityPlace and citySource (settled.py).
- hexes.r5.v1 ("h3_r5"): the city hexes. Every mesh cell (H3 resolution 5) with land whose
  resolution-4 parent holds CITY_PEOPLE or more people, all of a parent's cells together, so a
  consumer can draw a split parent from its cells. The values are the cell's own attrs; land,
  province, neighbours and jurisdictions as for the resolution-4 table. Neighbours are every adjacent
  mesh cell, in the table or not, as {id, parent, kind}; one with no land is a water link.

Methods not in hexes.py:
- settledYear: the earliest settled year (settled.py) of the row's places, from the place whose
  date is earliest (on the same date, the more populous place); null when none of them is dated.
- cityYear: the city year (settled.py) of the row's principal place, its most populous place; null
  when the row has no place or the place has no city date.
- places, resolution 5: a place of a split parent goes to the parent's city hex holding its point,
  or, where H3's resolution-5 cells do not cover that part of their parent (an H3 parent and its
  seven children do not have the same outline), to the parent's city hex nearest to it. So a split
  parent's places are exactly its city hexes' places.
"""

from __future__ import annotations

import sys
from collections import Counter, defaultdict

import geopandas as gpd
import h3
import numpy as np
import shapely

import landlinks
import settled
from attributes import load_csds
from census import release_memory
from columns import decode_column
from common import BUILD, EQUAL_AREA_CRS, MESH_VERSION, WGS84, raw_file, write_json_gz
from geo import cell_polygons
from hexes import (
    GDP_CAVEAT,
    SOURCES,
    Aggregates,
    census_meta,
    csd_types,
    layer,
    log,
    lookups,
    place_entry,
    province_by_land,
    sorted_places,
)
from unittables import PROVINCES, jurisdictions, load_gz

R4_PATH = BUILD / f"hexes.r4.{MESH_VERSION}.2.json.gz"
R4_LAYER = BUILD / "layers" / f"hexes.r4.{MESH_VERSION}.2.topojson.gz"
R5_PATH = BUILD / f"hexes.r5.{MESH_VERSION}.json.gz"
R5_LAYER = BUILD / "layers" / f"hexes.r5.{MESH_VERSION}.topojson.gz"
URL = "data/build/"  # meta.layer and meta.parentTable: repository paths, fixed, not BUILD
CITY_PEOPLE = 100_000
TABLE_VERSION = 1
LAND_SOURCES = [*SOURCES, "nrcan_atlas_waterbodies_1m", "nrcan_atlas_islands_1m"]


def neighbour_rule() -> dict:
    return {
        "neighbourRule": "principalLand",
        "landEdgeMetres": landlinks.LAND_EDGE_M,
        "landGapMetres": landlinks.GAP_M,
    }


def link_rows(pairs: dict[tuple[str, str], tuple[str, float]], rows: set[str]) -> dict[str, list[tuple]]:
    """Each row's links (neighbour, kind), from links listed once per pair."""
    out: dict[str, list[tuple]] = defaultdict(list)
    for (a, b), (kind, _) in pairs.items():
        if a in rows:
            out[a].append((b, kind))
        if b in rows:
            out[b].append((a, kind))
    return out


def principals_of(ids: list[str], land: landlinks.Land, label: str, land_m2: dict[str, float]) -> dict:
    """Principal land of each id. Its land, read around each cell, must be the land the CSD overlay
    measured (land_m2, where known): a mismatch is a geometry failure, and the build stops."""
    found = landlinks.Principals(land)
    out = {}
    for k, h in enumerate(ids):
        principal = found.of(h)
        if principal is not None:
            out[h] = principal
        read = principal.land_m2 if principal else 0.0
        if h in land_m2 and abs(read - land_m2[h]) > max(1e4, 1e-3 * land_m2[h]):
            raise ValueError(
                f"{h}: {read / 1e6:.3f} km² of land read around it, {land_m2[h] / 1e6:.3f} measured"
            )
        if (k + 1) % 1000 == 0:
            log(f"{label}: principal land of {k + 1:,} of {len(ids):,}")
    return out


def land_of(ids: list[str], csds, lakes) -> tuple[np.ndarray, object, np.ndarray, object]:
    """Polygons, land pieces (lakes out), land m² by id, and the lake area each id lost."""
    polys = cell_polygons(ids)
    units = gpd.GeoDataFrame({"hex": ids}, geometry=polys.to_numpy(), crs=EQUAL_AREA_CRS)
    pieces, removed = landlinks.land_pieces(units, "hex", csds, lakes)
    land_m2 = pieces.groupby("a", sort=True)["area"].sum().reindex(ids).fillna(0.0).to_numpy()
    return polys.to_numpy(), pieces, land_m2, removed


def dated(place_dates: dict, places: list[dict]) -> tuple:
    """(settled fact, its place) earliest among the places; (None, None) when none is dated."""
    best = None
    for p in places:
        found = place_dates.get(p["csd"])
        if found is None or found.settled is None:
            continue
        key = (found.settled.key(), -p["population"], p["csd"])
        if best is None or key < best[0]:
            best = (key, found.settled, p)
    return (best[1], best[2]) if best else (None, None)


def place_ref(p: dict | None) -> dict | None:
    return {"csd": p["csd"], "name": p["name"]} if p else None


def build() -> tuple[dict, dict]:
    mesh = load_gz(BUILD / f"mesh.{MESH_VERSION}.json.gz")
    attrs = load_gz(BUILD / f"attrs.{MESH_VERSION}.json.gz")
    cells = mesh["cells"]
    cell_ids = [c["id"] for c in cells]
    parents = [h3.cell_to_parent(c, 4) for c in cell_ids]
    all4 = sorted(set(parents))
    pos4 = {h: i for i, h in enumerate(all4)}
    col = {name: decode_column(c).astype(np.float64) for name, c in attrs["columns"].items()}
    agg4 = Aggregates(cells, col, np.array([pos4[p] for p in parents]), len(all4))

    log("land: CSDs less the large lakes")
    csds = load_csds()
    csds["province"] = csds["PRUID"].map(PROVINCES)
    all_lakes = landlinks.load_lakes(csds)
    lakes = all_lakes[all_lakes["water"]].reset_index(drop=True)
    csd_type = csd_types(csds)
    polys4_all, pieces4, land4_all, removed4 = land_of(all4, csds, lakes)
    ids4 = [h for h, m2 in zip(all4, land4_all, strict=True) if m2 > 0]
    gone = [h for h in all4 if h not in set(ids4)]
    lost = sum(int(agg4.population[pos4[h]]) for h in gone)
    log(f"{len(all4):,} resolution-4 parents of mesh cells; {len(gone)} have no land and are not rows")
    if lost:
        raise ValueError(f"hexagons with no land hold {lost} people: {gone}")
    keep4 = np.array([pos4[h] for h in ids4])
    land4 = land4_all[keep4]
    polys4 = polys4_all[keep4]
    province4 = province_by_land(pieces4, csds)
    urban4 = agg4.urban(land4_all / 1e6)
    taken = removed4.groupby("lake")["area"].sum() / 1e6
    lake_list = [
        {
            "name": r.name,
            "nameFr": r.nameFr if isinstance(r.nameFr, str) and r.nameFr else None,
            "km2": round(r.km2, 1),
            "csdKm2": round(r.csdKm2, 1),
            "landKm2": round(float(taken.get(r.lake, 0.0)), 1),
        }
        for r in all_lakes.itertuples()
    ]
    log(f"{len(all_lakes)} large lakes, {len(lakes)} taken out of the CSDs: {taken.sum():,.0f} km²")

    log("principal land and links, resolution 4")
    land = landlinks.Land.build(csds, lakes)
    principal4 = principals_of(ids4, land, "resolution 4", dict(zip(all4, land4_all, strict=True)))
    rows4 = set(ids4)
    pairs4 = sorted({(a, b) for a in ids4 for b in h3.grid_ring(a, 1) if b in rows4 and a < b})
    kinds4 = landlinks.link_kinds(pairs4, principal4)
    links4 = link_rows(kinds4, rows4)
    log(f"{len(kinds4):,} links: {Counter(k for k, _ in kinds4.values())}")

    log("city hexes: resolution-5 mesh cells of the split parents")
    split = {h for h in ids4 if agg4.population[pos4[h]] >= CITY_PEOPLE}
    city_all = [c for c, p in zip(cell_ids, parents, strict=True) if p in split]
    mesh_ids = set(cell_ids)
    ring = sorted({n for c in city_all for n in h3.grid_ring(c, 1) if n in mesh_ids} | set(city_all))
    polys5_all, pieces5, land5_all, _ = land_of(city_all, csds, lakes)
    measured = dict(zip(city_all, land5_all, strict=True))
    principal_ring = principals_of(ring, land, "city hexes and their neighbours", measured)
    del land
    release_memory()
    ids5 = [c for c, m2 in zip(city_all, land5_all, strict=True) if m2 > 0]
    cell_pos = {c: i for i, c in enumerate(cell_ids)}
    idx5 = np.array([cell_pos[c] for c in ids5])
    gone5 = [c for c in city_all if c not in set(ids5)]
    lost5 = int(col["population"][[cell_pos[c] for c in gone5]].sum()) if gone5 else 0
    if lost5:
        raise ValueError(f"city cells with no land hold {lost5} people: {gone5}")
    log(f"{len(split)} split parents, {len(city_all)} cells, {len(gone5)} with no land: {len(ids5)} rows")
    keep5 = np.array([city_all.index(c) for c in ids5])
    polys5, land5 = polys5_all[keep5], land5_all[keep5]
    agg5 = Aggregates(
        [cells[i] for i in idx5], {k: v[idx5] for k, v in col.items()}, np.arange(len(ids5)), len(ids5)
    )
    urban5 = agg5.urban(land5 / 1e6)
    province5 = province_by_land(pieces5, csds)
    rows5 = set(ids5)
    pairs5 = sorted({tuple(sorted((a, b))) for a in ids5 for b in h3.grid_ring(a, 1) if b in mesh_ids})
    kinds5 = landlinks.link_kinds(pairs5, principal_ring)
    links5 = link_rows(kinds5, rows5)
    log(f"{len(kinds5):,} links of city hexes: {Counter(k for k, _ in kinds5.values())}")
    del csds
    release_memory()

    log("places")
    places = load_gz(BUILD / f"places.{MESH_VERSION}.json.gz")["places"]
    land_parts = gpd.GeoDataFrame(pieces4[["a"]], geometry=pieces4["geometry"].to_numpy(), crs=EQUAL_AREA_CRS)
    places_of4: dict[str, list[dict]] = defaultdict(list)
    moved = Counter()
    nearest = None
    for p in places:
        hexagon = h3.latlng_to_cell(p["lat"], p["lng"], 4)
        if hexagon not in rows4:
            hexagon = parents[p["cell"]]
            moved["mesh cell"] += 1
        if hexagon not in rows4:
            if nearest is None:
                tree = shapely.STRtree(land_parts.geometry.to_numpy())
                nearest = (tree, land_parts["a"].to_numpy())
            point = gpd.GeoSeries([shapely.Point(p["lng"], p["lat"])], crs=WGS84).to_crs(EQUAL_AREA_CRS)
            hits = nearest[0].query_nearest(point.iloc[0], all_matches=True)
            hexagon = min(nearest[1][hits])
            moved["nearest land"] += 1
        places_of4[hexagon].append(p)
    log(f"{len(places):,} places; moved: {dict(moved)}")
    places_of5: dict[str, list[dict]] = defaultdict(list)
    children: dict[str, list[str]] = defaultdict(list)
    for c in ids5:
        children[h3.cell_to_parent(c, 4)].append(c)
    for parent in sorted(split):
        for p in places_of4[parent]:
            cell = h3.latlng_to_cell(p["lat"], p["lng"], 5)
            if cell not in rows5 or h3.cell_to_parent(cell, 4) != parent:
                point = gpd.GeoSeries([shapely.Point(p["lng"], p["lat"])], crs=WGS84).to_crs(EQUAL_AREA_CRS)
                own = children[parent]
                distance = shapely.distance(np.array([polys5[ids5.index(c)] for c in own]), point.iloc[0])
                cell = min(zip(distance, own, strict=True))[1]
            places_of5[cell].append(p)

    log("dates")
    place_dates = settled.read(raw_file("wikidata_csd_dates"), {p["csd"] for p in places})

    log("jurisdictions, resolution 4")
    spans4 = jurisdictions(ids4, polys4, pieces4["a"].to_numpy(), pieces4["geometry"].to_numpy(), land4, log)
    log("jurisdictions, resolution 5")
    spans5 = jurisdictions(ids5, polys5, pieces5["a"].to_numpy(), pieces5["geometry"].to_numpy(), land5, log)

    log("layers")
    log(f"{layer(ids4, pieces4, R4_LAYER):,} resolution-4 hexagons drawn")
    log(f"{layer(ids5, pieces5, R5_LAYER):,} city hexes drawn")
    del pieces4, pieces5, land_parts
    release_memory()

    from polygons import attribution_rows

    census = census_meta(mesh, attrs)
    rows = []
    for i, h in enumerate(ids4):
        j = pos4[h]
        lat, lng = h3.cell_to_latlng(h)
        here = sorted_places(places_of4[h])
        fact, where = dated(place_dates, here)
        row = {
            "id": h,
            "centroid": [round(lng, 5), round(lat, 5)],
            "province": province4[h],
            "cells": int(agg4.counts[j]),
            **agg4.stats(j, land4_all / 1e6, urban4),
            "landPoint": list(principal4[h].point),
            "places": [place_entry(p, csd_type) for p in here],
            "neighbours": [{"id": n, "kind": k} for n, k in sorted(links4[h])],
            "jurisdictions": spans4[i],
            "settledYear": fact.year if fact else None,
            "settledPlace": place_ref(where),
            "settledSource": fact.source() if fact else None,
        }
        if agg4.population[j] >= CITY_PEOPLE:
            top = here[0] if here else None
            found = place_dates.get(top["csd"]) if top else None
            city = found.city if found else None
            row |= {"cityYear": city.year if city else None, "cityPlace": place_ref(top)}
            row["citySource"] = city.source() if city else None
        rows.append(row)
    r4 = {
        "format": "meridian.unitTable",
        "version": TABLE_VERSION,
        "unit": "h3_r4",
        "meta": {
            "unitName": "H3 resolution-4 hexagons with land, the large lakes being water",
            "h3Resolution": 4,
            **census,
            "layer": URL + "layers/" + R4_LAYER.name,
            **neighbour_rule(),
            "lakeMinKm2": landlinks.LAKE_MIN_KM2,
            "lakes": lake_list,
            "cityPopulation": CITY_PEOPLE,
            "datesWithheldFrom": settled.CUTOFF,
            "sources": attribution_rows([*LAND_SOURCES, "wikidata_csd_dates"]),
        },
        "gdpCaveat": GDP_CAVEAT,
        "lookups": lookups(attrs),
        "rows": rows,
    }

    rows = []
    for i, c in enumerate(ids5):
        lat, lng = h3.cell_to_latlng(c)
        rows.append(
            {
                "id": c,
                "parent": h3.cell_to_parent(c, 4),
                "centroid": [round(lng, 5), round(lat, 5)],
                "province": province5[c],
                **agg5.stats(i, land5 / 1e6, urban5),
                "landPoint": list(principal_ring[c].point),
                "places": [place_entry(p, csd_type) for p in sorted_places(places_of5[c])],
                "neighbours": [
                    {"id": n, "parent": h3.cell_to_parent(n, 4), "kind": k} for n, k in sorted(links5[c])
                ],
                "jurisdictions": spans5[i],
            }
        )
    r5 = {
        "format": "meridian.unitTable",
        "version": TABLE_VERSION,
        "unit": "h3_r5",
        "meta": {
            "unitName": "H3 resolution-5 mesh cells of the resolution-4 hexagons of 100,000 people or more",
            "h3Resolution": 5,
            **census,
            "layer": URL + "layers/" + R5_LAYER.name,
            "parentTable": URL + R4_PATH.name,
            "cityPopulation": CITY_PEOPLE,
            **neighbour_rule(),
            "lakeMinKm2": landlinks.LAKE_MIN_KM2,
            "sources": attribution_rows(LAND_SOURCES),
        },
        "gdpCaveat": GDP_CAVEAT,
        "lookups": lookups(attrs),
        "rows": rows,
    }
    return r4, r5


def main() -> int:
    r4, r5 = build()
    for path, table in ((R4_PATH, r4), (R5_PATH, r5)):
        write_json_gz(path, table)
        log(f"wrote {path} ({path.stat().st_size:,} bytes, {len(table['rows']):,} rows)")
    for path in (R4_LAYER, R5_LAYER):
        log(f"wrote {path} ({path.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
