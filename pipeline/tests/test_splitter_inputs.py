"""Splitter inputs (splitter_inputs.py): the gazetteer, the hex topology and the river snap edges."""

from __future__ import annotations

import gzip
import json
from collections import Counter

import numpy as np
import pytest

from columns import decode_column
from common import BUILD, MESH_VERSION

MESH = BUILD / f"mesh.{MESH_VERSION}.json.gz"
PLACES = BUILD / f"places.{MESH_VERSION}.json.gz"
CELLS = BUILD / f"cells.{MESH_VERSION}.topojson.gz"
SNAP = BUILD / f"snap.{MESH_VERSION}.json.gz"


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


@pytest.fixture(scope="module")
def mesh():
    return load(MESH)


@pytest.mark.skipif(not PLACES.exists(), reason="places not built")
def test_places_are_sorted_populated_and_point_at_mesh_cells(mesh):
    doc = load(PLACES)
    n = len(mesh["cells"])
    places = doc["places"]
    assert [p["csd"] for p in places] == sorted(p["csd"] for p in places)
    assert all(p["population"] > 0 and 0 <= p["cell"] < n for p in places)
    by_name = {p["name"]: p for p in places if p["province"] == "48"}
    # Calgary's point sits in a cell whose CSD is Calgary.
    assert mesh["cells"][by_name["Calgary"]["cell"]]["csd"] == by_name["Calgary"]["csd"]
    cmas = {c["name"]: c for c in doc["cmas"]}
    assert {"Toronto", "Montréal", "Vancouver", "Calgary", "Edmonton"} <= set(cmas)
    assert cmas["Toronto"]["population"] > 5_000_000
    assert all(c["cells"] == sorted(c["cells"]) for c in doc["cmas"])


@pytest.mark.skipif(not CELLS.exists(), reason="cells not built")
def test_cell_topology_has_one_hexagon_per_cell_and_shares_arcs(mesh):
    topo = load(CELLS)
    geometries = topo["objects"]["cells"]["geometries"]
    assert len(geometries) == len(mesh["cells"])
    uses = Counter(ref if ref >= 0 else ~ref for g in geometries for ref in g["arcs"][0])
    # Every arc bounds one or two cells; interior edges are shared, which is what lets the app dissolve.
    assert set(uses.values()) <= {1, 2}
    assert sum(1 for c in uses.values() if c == 2) > len(mesh["cells"])


@pytest.mark.skipif(not SNAP.exists(), reason="snap not built")
def test_river_edges_are_mesh_edges(mesh):
    doc = load(SNAP)
    pairs = decode_column(doc["layers"]["rivers"]["pairs"]).reshape(-1, 2)
    assert len(pairs) > 1000
    assert np.all(pairs[:, 0] < pairs[:, 1])
    cells = mesh["cells"]
    assert all(int(v) in cells[int(u)]["neighbours"] for u, v in pairs)
