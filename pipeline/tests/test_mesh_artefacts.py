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


# Representative point (shapely point_on_surface of the 2021 cartographic CSD polygon, as used for
# DAs) of each provincial and territorial capital's CSD. Recomputed from raw data by
# test_capital_points_match_the_raw_csds when data/raw is present.
CAPITAL_CSD_POINTS = {
    "1001519": ("St. John's", 47.471094, -52.736265),
    "1102075": ("Charlottetown", 46.271100, -63.140205),
    "1209034": ("Halifax", 44.868377, -63.272883),
    "1310032": ("Fredericton", 45.953536, -66.649585),
    "2423027": ("Québec", 46.848144, -71.274208),
    "3520005": ("Toronto", 43.728130, -79.430277),
    "4611040": ("Winnipeg", 49.853991, -97.175348),
    "4706027": ("Regina", 50.462070, -104.618050),
    "4811061": ("Edmonton", 53.498097, -113.541560),
    "5917034": ("Victoria", 48.431592, -123.350374),
    "6001009": ("Whitehorse", 60.724713, -135.088622),
    "6106023": ("Yellowknife", 62.473593, -114.409117),
    "6204003": ("Iqaluit", 63.756345, -68.517626),
}


def test_every_capital_csd_representative_point_is_in_the_mesh():
    mesh = load(MESH)
    ids = {c["id"] for c in mesh["cells"]}
    missing = [
        name
        for name, lat, lng in CAPITAL_CSD_POINTS.values()
        if h3.latlng_to_cell(lat, lng, mesh["h3Resolution"]) not in ids
    ]
    assert missing == []


def test_capital_points_match_the_raw_csds():
    from common import MANIFEST

    if not MANIFEST.exists():
        pytest.skip("raw data not downloaded")
    import geopandas as gpd
    import shapely

    from common import EQUAL_AREA_CRS, WGS84, raw_file
    from geo import read_vector

    csds = read_vector(raw_file("statcan_csd_2021"), crs=EQUAL_AREA_CRS).set_index("CSDUID")
    for uid, (name, lat, lng) in CAPITAL_CSD_POINTS.items():
        point = shapely.point_on_surface(shapely.make_valid(csds.loc[uid].geometry))
        wgs = gpd.GeoSeries([point], crs=EQUAL_AREA_CRS).to_crs(WGS84).iloc[0]
        assert (round(wgs.y, 6), round(wgs.x, 6)) == (lat, lng), name


# Statistics Canada table 36-10-0711-01, 2022, current dollars, millions: sum of the 20 NAICS
# sectors per province/territory (equal to "All industries" to rounding). Recomputed from the raw
# table by test_gdp_totals_match_the_raw_table when data/raw is present.
GDP_2022_PROVINCIAL_TOTALS = {
    "AB": 456439.4, "BC": 372203.6, "MB": 81892.1, "NB": 40416.8, "NL": 39102.4, "NS": 50953.0,
    "NT": 5121.0, "NU": 4310.3, "ON": 987790.7, "PE": 8602.0, "QC": 512822.8, "SK": 110789.6,
    "YT": 3739.5,
}  # fmt: skip


@pytest.mark.skipif(not ATTRS.exists(), reason="attrs not built")
def test_gdp_estimate_reconciles_to_the_table_by_province():
    attrs = load(ATTRS)
    assert attrs["meta"]["gdp_reference_year"] == 2022 or attrs["meta"]["gdp_reference_year"] == "2022"
    column = attrs["columns"]["gdp_estimate"]
    assert (column["kind"], column["unit"], column["method"]) == ("money", "cad_millions", "allocation_v1")
    gdp = decode_column(column).astype("float64")
    totals: dict[str, float] = {}
    for value, cell in zip(gdp, load(MESH)["cells"], strict=True):
        totals[cell["province"]] = totals.get(cell["province"], 0.0) + value
    for province, expected in GDP_2022_PROVINCIAL_TOTALS.items():
        # float32 cells accumulate rounding; 0.01% of a provincial total is well under $100M.
        assert totals[province] == pytest.approx(expected, rel=1e-4), province


def test_gdp_totals_match_the_raw_table():
    from common import MANIFEST, raw_file

    if not MANIFEST.exists() or "statcan_gdp_36100711" not in json.loads(MANIFEST.read_text()):
        pytest.skip("GDP table not downloaded")
    import attributes

    values, year = attributes.read_gdp_table(raw_file("statcan_gdp_36100711"))
    assert year == "2022"
    totals: dict[str, float] = {}
    for (province, _sector), value in values.items():
        totals[province] = totals.get(province, 0.0) + value
    assert {p: round(t, 1) for p, t in totals.items()} == GDP_2022_PROVINCIAL_TOTALS
