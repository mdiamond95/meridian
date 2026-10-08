"""The hex table (hexes.py, 1.0.4): the brief's gate on the committed files, and the neighbour rule."""

from __future__ import annotations

import gzip
import json
from collections import Counter
from functools import cache

import h3
import pytest

import hexes
import unittables
from columns import decode_column
from common import BUILD, MESH_VERSION

TABLE = hexes.HEXES_PATH
LAYER = hexes.HEX_LAYER
built = pytest.mark.skipif(not TABLE.exists(), reason="hexes not built")


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


@cache
def table() -> dict:
    return load(TABLE)


@cache
def rows() -> list[dict]:
    return table()["rows"]


def on(row: dict, date: str) -> dict:
    (span,) = [s for s in row["jurisdictions"] if s["from"] <= date and (s["to"] is None or date < s["to"])]
    return span


@built
def test_one_row_per_parent_of_a_mesh_cell_in_h3_order():
    t = table()
    assert (t["format"], t["version"], t["unit"]) == ("meridian.unitTable", 1, "h3_r4")
    mesh = load(BUILD / f"mesh.{MESH_VERSION}.json.gz")
    parents = Counter(h3.cell_to_parent(c["id"], 4) for c in mesh["cells"])
    ids = [r["id"] for r in rows()]
    assert ids == sorted(parents) and len(ids) == 6011
    assert [int(h, 16) for h in ids] == sorted(int(h, 16) for h in ids), "string order is index order"
    assert all(r["cells"] == parents[r["id"]] for r in rows())


@built
def test_population_reconciles_and_the_brief_counts_hold():
    attrs = load(BUILD / f"attrs.{MESH_VERSION}.json.gz")
    assert sum(r["population"] for r in rows()) == int(decode_column(attrs["columns"]["population"]).sum())
    assert sum(r["population"] for r in rows()) == 36_991_981
    assert sum(r["population"] > 0 for r in rows()) == 1583
    big = [r for r in rows() if r["population"] >= 5000]
    assert len(big) == 439
    # By land, not by majority of cells: 842b909 (22,011 people, Lake Timiskaming) has most of its
    # land in Ontario and most of its cells in Quebec, so Quebec has 85 and Ontario 96 where a cell
    # count gives 86 and 95.
    assert Counter(r["province"] for r in big) == {
        "NL": 16, "PE": 5, "NS": 29, "NB": 29, "QC": 85, "ON": 96, "MB": 27, "SK": 24, "AB": 65,
        "BC": 60, "YT": 1, "NT": 1, "NU": 1,
    }  # fmt: skip


@built
def test_open_water_rows_are_the_great_lakes():
    water = [r for r in rows() if r["areaKm2"] == 0]
    assert len(water) == 21
    assert all(r["population"] == 0 and r["province"] == "ON" for r in water)
    assert all(len(r["jurisdictions"]) == 1 and r["jurisdictions"][0].get("fallback") for r in water)


@built
def test_every_row_has_a_jurisdiction_on_every_date_and_fallbacks_are_listed():
    atlas = json.loads(unittables.ATLAS_PATH.read_text(encoding="utf-8"))
    starts = [start for start, _ in unittables.intervals(atlas)]
    for row in rows():
        for date in starts:
            on(row, date)
    fallback = {r["id"] for r in rows() if any(s.get("fallback") for s in r["jurisdictions"])}
    water = {r["id"] for r in rows() if r["areaKm2"] == 0}
    # Charlton Island (James Bay; the atlas leaves it undrawn 1927–1999) and the southern tip of Cape
    # Sable Island (missed by the atlas's simplified coast).
    assert fallback - water == {"840eeabffffffff", "842b0a7ffffffff"}


@built
def test_neighbours_are_symmetric_edges_of_the_grid():
    by = {r["id"]: r for r in rows()}
    kinds = Counter()
    for r in rows():
        ring = set(h3.grid_ring(r["id"], 1))
        for nb in r["neighbours"]:
            assert nb["id"] in ring
            (back,) = [x for x in by[nb["id"]]["neighbours"] if x["id"] == r["id"]]
            assert back["kind"] == nb["kind"]
            if r["id"] < nb["id"]:
                kinds[nb["kind"]] += 1
        assert {n["id"] for n in r["neighbours"]} == ring & set(by)
    assert kinds == {"land": 16599, "water": 424}
    assert all(any(n["kind"] == "land" for n in r["neighbours"]) for r in rows() if r["population"] >= 5000)


@built
def test_places_carry_their_csd_type_and_each_is_in_one_row():
    t = table()
    placed = [p for r in rows() for p in r["places"]]
    assert sorted(p["csd"] for p in placed) == sorted(
        p["csd"] for p in load(BUILD / "places.v1.json.gz")["places"]
    )
    assert all(p["csdType"] in t["lookups"]["csdType"] for p in placed)
    calgary = [p for p in placed if p["name"] == "Calgary"]
    assert [p["csdType"] for p in calgary] == ["CY"]


@built
def test_scores_shares_and_caveat():
    t = table()
    assert t["gdpCaveat"] == hexes.GDP_CAVEAT
    assert all("cohesion" not in r["score"] for r in rows())
    empty = [r for r in rows() if r["population"] == 0]
    assert all(r["industryDominant"] == 0 and r["score"]["exposure"] == 0 for r in empty)
    gdp = decode_column(load(BUILD / f"attrs.{MESH_VERSION}.json.gz")["columns"]["gdp_estimate"]).sum()
    assert abs(sum(r["score"]["gdp"] for r in rows()) - gdp) <= 0.5 * len(rows())


@built
def test_the_layer_is_one_land_clipped_geometry_per_row():
    topo = load(LAYER)
    geometries = topo["objects"]["hexes"]["geometries"]
    assert [g["properties"]["id"] for g in geometries] == [r["id"] for r in rows()]
    water = {r["id"] for r in rows() if r["areaKm2"] == 0}
    assert {g["properties"]["id"] for g in geometries if g["type"] is None} == water
    assert table()["meta"]["layer"] == "data/build/layers/hexes.r4.v1.topojson.gz"
    # Neighbours share arcs: most links are drawn as one arc owned by both hexagons.
    owners: dict[int, set[str]] = {}
    for g in geometries:
        for ring in (
            g.get("arcs", []) if g["type"] == "Polygon" else [r for p in g.get("arcs", []) for r in p]
        ):
            for a in ring:
                owners.setdefault(a if a >= 0 else ~a, set()).add(g["properties"]["id"])
    shared = {tuple(sorted(o)) for o in owners.values() if len(o) == 2}
    land_links = {
        (r["id"], n["id"])
        for r in rows()
        for n in r["neighbours"]
        if n["kind"] == "land" and r["id"] < n["id"]
    }
    assert len(shared & land_links) / len(land_links) > 0.99


@built
def test_land_is_clipped_to_the_shore():
    by = {r["id"]: r for r in rows()}
    full = h3.average_hexagon_area(4, unit="km^2")
    # A hexagon on Hudson Bay's coast has far less land than its area; one inland has nearly all.
    assert by[h3.latlng_to_cell(58.77, -94.17, 4)]["areaKm2"] < 0.8 * full  # Churchill
    assert by[h3.latlng_to_cell(51.0, -114.0, 4)]["areaKm2"] > 0.9 * full  # Calgary
