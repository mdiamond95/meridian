"""The 1.0.5 hex board (hexboard.py): hexes.r4.v1.2 with the large lakes as water and the principal-land
neighbour rule, the city hexes (hexes.r5.v1), and the settlement dates. The brief's named cases are
read from the committed files: a place's row is the row holding its point."""

from __future__ import annotations

import gzip
import json
from collections import Counter, defaultdict
from functools import cache

import h3
import pytest

import hexboard
import landlinks
import settled
from columns import decode_column
from common import BUILD, MESH_VERSION

R4, R5 = hexboard.R4_PATH, hexboard.R5_PATH
built = pytest.mark.skipif(not (R4.exists() and R5.exists()), reason="hex board not built")


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


@cache
def r4() -> dict:
    return load(R4)


@cache
def r5() -> dict:
    return load(R5)


@cache
def v1() -> dict:
    return load(BUILD / f"hexes.r4.{MESH_VERSION}.json.gz")


def row_of(table: dict, place: str, province: str | None = None) -> str:
    """The id of the row holding the named place (a places.v1 CSD name; the most populous of that name,
    as Moncton the city and not the parish)."""
    found = [
        (p["population"], r["id"])
        for r in table["rows"]
        for p in r["places"]
        if p["name"] == place and (province is None or p["csd"].startswith(province))
    ]
    return max(found)[1]


def groups(table: dict, keep=lambda row: True) -> dict[str, int]:
    """Each kept row's land-connected group, over land links between kept rows."""
    rows = {r["id"]: r for r in table["rows"] if keep(r)}
    group: dict[str, int] = {}
    for start in rows:
        if start in group:
            continue
        group[start] = len(group)
        stack = [start]
        while stack:
            here = stack.pop()
            for n in rows[here]["neighbours"]:
                if n["kind"] == "land" and n["id"] in rows and n["id"] not in group:
                    group[n["id"]] = group[start]
                    stack.append(n["id"])
    return group


# --- the resolution-4 table -------------------------------------------------------------------


@built
def test_rows_are_the_parents_with_land_and_every_person_is_in_one():
    t = r4()
    assert (t["format"], t["version"], t["unit"]) == ("meridian.unitTable", 1, "h3_r4")
    assert t["meta"]["layer"] == "data/build/layers/hexes.r4.v1.2.topojson.gz"
    mesh = load(BUILD / f"mesh.{MESH_VERSION}.json.gz")
    parents = Counter(h3.cell_to_parent(c["id"], 4) for c in mesh["cells"])
    ids = [r["id"] for r in t["rows"]]
    assert ids == sorted(ids) and set(ids) < set(parents)
    assert all(r["areaKm2"] > 0 and r["cells"] == parents[r["id"]] for r in t["rows"])
    attrs = load(BUILD / f"attrs.{MESH_VERSION}.json.gz")
    total = int(decode_column(attrs["columns"]["population"]).sum())
    assert sum(r["population"] for r in t["rows"]) == total == 36_991_981


@built
def test_the_large_lakes_are_water():
    lakes = {lake["name"]: lake for lake in r4()["meta"]["lakes"]}
    for name in (
        "Lake Winnipeg", "Lake Manitoba", "Lake Winnipegosis", "Great Slave Lake", "Great Bear Lake",
        "Lake Athabasca", "Reindeer Lake", "Lake Nipigon", "Lac Saint-Jean", "Nettilling Lake",
    ):  # fmt: skip
        # More than half the lake taken out of the land: what stays is its islands.
        assert lakes[name]["csdKm2"] >= lakes[name]["landKm2"] > 0.5 * lakes[name]["km2"], name
    # The CSDs already leave most of Lake of the Woods out, as they do the Great Lakes: their shore stays.
    for name in (
        "Lake of the Woods",
        "Lake Superior",
        "Lake Huron",
        "Lake Erie",
        "Lake Ontario",
        "Georgian Bay",
    ):
        assert lakes[name]["csdKm2"] < 0.5 * lakes[name]["km2"] and lakes[name]["landKm2"] == 0, name
    assert all(lake["km2"] >= landlinks.LAKE_MIN_KM2 for lake in lakes.values()) and len(lakes) == 57
    by = {r["id"]: r for r in r4()["rows"]}
    old = {r["id"]: r for r in v1()["rows"]}
    # In Lake Winnipeg's north basin and in Great Slave Lake: rows in v1, none now.
    for lat, lng in ((53.48, -98.36), (52.73, -98.27), (61.47, -114.27)):
        h = h3.latlng_to_cell(lat, lng, 4)
        assert h in old and old[h]["areaKm2"] > 1000 and h not in by
    # Gimli's hexagon on Lake Winnipeg's west shore keeps its land and loses the lake.
    gimli = row_of(r4(), "Gimli")
    assert 0 < by[gimli]["areaKm2"] < 0.8 * old[gimli]["areaKm2"]


@built
def test_neighbours_are_symmetric_edges_of_the_grid_between_principal_lands():
    by = {r["id"]: r for r in r4()["rows"]}
    kinds = Counter()
    for r in r4()["rows"]:
        ring = set(h3.grid_ring(r["id"], 1))
        assert {n["id"] for n in r["neighbours"]} == ring & set(by)
        for n in r["neighbours"]:
            (back,) = [x for x in by[n["id"]]["neighbours"] if x["id"] == r["id"]]
            assert back["kind"] == n["kind"]
            kinds[n["kind"]] += r["id"] < n["id"]
        lng, lat = r["landPoint"]
        assert h3.latlng_to_cell(lat, lng, 4) == r["id"], "the land point is in the hexagon"
    meta = r4()["meta"]
    assert (meta["neighbourRule"], meta["landGapMetres"]) == ("principalLand", landlinks.GAP_M)
    assert kinds == EXPECTED_LINKS


EXPECTED_LINKS = {"land": 15_984, "water": 944}


@built
@pytest.mark.parametrize(
    "island, mainland",
    [
        (("St. John's", "10"), ("Happy Valley-Goose Bay", "10")),  # the Strait of Belle Isle
        (("Corner Brook", "10"), ("Labrador City", "10")),
        (("Charlottetown", "11"), ("Moncton", "13")),  # the Northumberland Strait
        (("Summerside", "11"), ("Truro", "12")),
        (("Victoria", "59"), ("Vancouver", "59")),  # the Strait of Georgia and the Discovery Islands
        (("Campbell River", "59"), ("Powell River", "59")),
        (("L'Île-d'Anticosti", "24"), ("Sept-Îles", "24")),
        (("Masset", "59"), ("Prince Rupert", "59")),  # Haida Gwaii
        (("Les Îles-de-la-Madeleine", "24"), ("Gaspé", "24")),
    ],
)
def test_islands_across_straits_are_reached_only_by_water(island, mainland):
    g = groups(r4())
    assert g[row_of(r4(), *island)] != g[row_of(r4(), *mainland)]


@built
def test_georgian_bay_and_the_lower_st_lawrence_are_water():
    # North of 44.95° the Bruce Peninsula reaches the east shore only across the bay or the Main
    # Channel to Manitoulin: by land it goes round by Owen Sound, which is cut off here.
    north = groups(r4(), lambda r: r["landPoint"][1] >= 44.95)
    assert north[row_of(r4(), "Northern Bruce Peninsula")] != north[row_of(r4(), "Parry Sound")]
    # East of Québec City, the north shore reaches the south shore only across the St Lawrence.
    east = groups(r4(), lambda r: r["province"] == "QC" and r["landPoint"][0] > -71.3)
    for north_shore in ("La Malbaie", "Baie-Comeau"):
        for south_shore in ("Rivière-du-Loup", "Rimouski", "Montmagny"):
            assert east[row_of(r4(), north_shore, "24")] != east[row_of(r4(), south_shore, "24")]


@built
def test_narrow_crossings_are_land():
    g = groups(r4())
    assert g[row_of(r4(), "Cape Breton")] == g[row_of(r4(), "Halifax")]  # the Canso Causeway
    # Manitoulin reaches the mainland by Little Current, not by the Bruce Peninsula.
    north = groups(r4(), lambda r: r["landPoint"][1] >= 45.4)
    assert north[row_of(r4(), "Gore Bay")] == north[row_of(r4(), "Espanola")]
    # Montréal and Laval to both shores, in the city hexes, where they are apart.
    city = groups(r5())
    for island in ("Montréal", "Laval"):
        for shore in ("Longueuil", "Brossard", "Terrebonne", "Mirabel"):
            assert city[row_of(r5(), island, "24")] == city[row_of(r5(), shore, "24")]


# --- the city hexes ---------------------------------------------------------------------------


@built
def test_city_hexes_are_every_cell_with_land_of_the_parents_of_100000():
    t = r5()
    assert (t["format"], t["unit"], t["meta"]["parentTable"]) == (
        "meridian.unitTable",
        "h3_r5",
        "data/build/hexes.r4.v1.2.json.gz",
    )
    split = {r["id"]: r for r in r4()["rows"] if r["population"] >= hexboard.CITY_PEOPLE}
    assert len(split) == 62
    children = defaultdict(list)
    for r in t["rows"]:
        assert r["parent"] == h3.cell_to_parent(r["id"], 4) and r["parent"] in split
        children[r["parent"]].append(r)
    mesh = {c["id"] for c in load(BUILD / f"mesh.{MESH_VERSION}.json.gz")["cells"]}
    for parent, row in split.items():
        cells = children[parent]
        assert sum(c["population"] for c in cells) == row["population"]
        assert sorted(p["csd"] for c in cells for p in c["places"]) == sorted(p["csd"] for p in row["places"])
        assert {c["id"] for c in cells} <= mesh
    for city in ("Toronto", "Montréal", "Vancouver"):
        parent = row_of(r4(), city)
        assert len(children[parent]) == split[parent]["cells"], f"{city}: a cell with no land"


@built
def test_city_hex_neighbours_are_every_adjacent_mesh_cell():
    mesh = {c["id"] for c in load(BUILD / f"mesh.{MESH_VERSION}.json.gz")["cells"]}
    by = {r["id"]: r for r in r5()["rows"]}
    for r in r5()["rows"]:
        assert [n["id"] for n in r["neighbours"]] == sorted(set(h3.grid_ring(r["id"], 1)) & mesh)
        for n in r["neighbours"]:
            assert n["parent"] == h3.cell_to_parent(n["id"], 4)
            if n["id"] in by:
                (back,) = [x for x in by[n["id"]]["neighbours"] if x["id"] == r["id"]]
                assert back["kind"] == n["kind"]


# --- settlement dates -------------------------------------------------------------------------


@built
def test_dates_are_wikidatas_and_mergers_are_not_foundings():
    rows = r4()["rows"]
    by = {r["id"]: r for r in rows}
    for r in rows:
        assert (r["settledYear"] is None) == (r["settledSource"] is None) == (r["settledPlace"] is None)
        if r["settledYear"] is not None:
            assert r["settledYear"] < settled.CUTOFF
            assert r["settledPlace"]["csd"] in {p["csd"] for p in r["places"]}
        assert ("cityYear" in r) == (r["population"] >= hexboard.CITY_PEOPLE)
    halifax = by[row_of(r4(), "Halifax")]
    assert (halifax["settledYear"], halifax["settledSource"]["item"]) == (1749, "Q2141")
    # Chatham-Kent's inception (1998) is its amalgamation's; the row takes another place's date or none.
    ck = by[row_of(r4(), "Chatham-Kent")]
    assert ck["settledPlace"] is None or ck["settledPlace"]["name"] != "Chatham-Kent"
    # Saguenay (2002) is dated by a predecessor on record.
    source = by[row_of(r4(), "Saguenay")]["settledSource"]
    assert source and source.get("predecessorOf") == "Q139229"
