"""Phase 1 gate checks on the built artefacts (docs/plan.md, Phase 1 §5).

Skipped when data/build/ has no mesh yet (e.g. a fresh clone before `make build`).
"""

import gzip
import json
from functools import cache

import h3
import pytest

from columns import decode_column
from common import BUILD, MESH_VERSION

MESH = BUILD / f"mesh.{MESH_VERSION}.json.gz"
ATTRS = BUILD / f"attrs.{MESH_VERSION}.json.gz"
CANADA_POPULATION_2021 = 36_991_981  # Statistics Canada, Census Profile 2021, characteristic 1
ALBERTA_TOTAL_AREA_KM2 = 661_848  # land 642,317 + freshwater 19,531 (Statistics Canada)
NOMINAL_CELL_KM2 = 253

pytestmark = pytest.mark.skipif(not MESH.exists(), reason="mesh not built")


@cache
def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def test_cell_count_is_within_range():
    assert 38_000 <= len(load(MESH)["cells"]) <= 45_000


@pytest.mark.skipif(not ATTRS.exists(), reason="attrs not built")
def test_population_sums_to_canada_2021_total():
    population = decode_column(load(ATTRS)["columns"]["population"])
    total = int(population.astype("int64").sum())
    assert abs(total - CANADA_POPULATION_2021) <= 0.001 * CANADA_POPULATION_2021, total


def test_neighbour_graph_is_the_filtered_k_ring():
    cells = load(MESH)["cells"]
    index = {c["id"]: i for i, c in enumerate(cells)}
    for i, cell in enumerate(cells):
        expected = sorted(index[n] for n in h3.grid_disk(cell["id"], 1) if n != cell["id"] and n in index)
        assert cell["neighbours"] == expected, cell["id"]
        for j in cell["neighbours"]:
            assert i in cells[j]["neighbours"], "neighbour graph must be symmetric"


def test_cells_without_neighbours_are_isolated_islands():
    cells = load(MESH)["cells"]
    index = {c["id"] for c in cells}
    isolated = [c for c in cells if not c["neighbours"]]
    # Only islands separated from every other mesh cell may be isolated, and they must be rare.
    assert len(isolated) <= 0.005 * len(cells), len(isolated)
    for cell in isolated:
        assert not any(n in index for n in h3.grid_disk(cell["id"], 1) if n != cell["id"])


def test_alberta_cell_count_matches_its_area():
    alberta = sum(1 for c in load(MESH)["cells"] if c["province"] == "AB")
    expected = ALBERTA_TOTAL_AREA_KM2 / NOMINAL_CELL_KM2
    assert abs(alberta - expected) <= 0.05 * expected, (alberta, round(expected))


def test_codes_nest():
    for cell in load(MESH)["cells"]:
        assert cell["csd"].startswith(cell["cd"])


def test_artefacts_fit_the_size_budget():
    """Phase 1 gate: everything in data/build/ under 8 MB."""
    total = sum(p.stat().st_size for p in BUILD.rglob("*") if p.is_file())
    assert total < 8_000_000, f"{total:,} bytes"
