"""Phase 2 gate checks on the committed atlas (docs/plan.md, Phase 2 Sitting A §5).

Runs in CI against data/build/, with no raw data needed. The golden hashes pin the artefacts: a
change to events.yaml or the build that alters them must update tests/golden/atlas.sha, with a
one-line justification in the commit (running rules).
"""

import gzip
import json
from functools import cache
from pathlib import Path

import pytest
import shapely
from shapely.geometry import Point, shape

from common import BUILD, sha256_file

ATLAS = BUILD / "atlas.v1.json"
TOPOLOGY = BUILD / "atlas.v1.topojson.gz"
GOLDEN = Path(__file__).parent / "golden" / "atlas.sha"

pytestmark = pytest.mark.skipif(not ATLAS.exists(), reason="atlas not built")


@cache
def atlas() -> dict:
    return json.loads(ATLAS.read_text(encoding="utf-8"))


@cache
def topology() -> dict:
    with gzip.open(TOPOLOGY, "rt", encoding="utf-8") as fh:
        return json.load(fh)


@cache
def geometry(ref: str) -> shapely.Geometry:
    """Decode one TopoJSON polygon object (quantized, delta-encoded arcs)."""
    topo = topology()
    (sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]

    def arc(index: int) -> list[tuple[float, float]]:
        x = y = 0
        points = []
        for dx, dy in topo["arcs"][index if index >= 0 else ~index]:
            x, y = x + dx, y + dy
            points.append((x * sx + tx, y * sy + ty))
        return points if index >= 0 else points[::-1]

    def ring(indices: list[int]) -> list[tuple[float, float]]:
        coords: list[tuple[float, float]] = []
        for k, index in enumerate(indices):
            coords.extend(arc(index)[1 if k else 0 :])
        return coords

    obj = topo["objects"][ref]
    if obj["type"] == "Polygon":
        return shape({"type": "Polygon", "coordinates": [ring(r) for r in obj["arcs"]]})
    return shape({"type": "MultiPolygon", "coordinates": [[ring(r) for r in poly] for poly in obj["arcs"]]})


def resolve(date: str, truth: str = "dejure") -> dict[str, dict]:
    return {
        u["id"]: u
        for u in atlas()["units"]
        if u["truth"] == truth and u["validFrom"] <= date and (u["validTo"] is None or date < u["validTo"])
    }


def test_golden_hashes():
    recorded = dict(line.split("  ")[::-1] for line in GOLDEN.read_text().splitlines() if line)
    actual = {path.name: sha256_file(path) for path in (ATLAS, TOPOLOGY)}
    assert actual == recorded, "atlas artefacts changed: update tests/golden/atlas.sha and say why"


def test_every_geometry_ref_is_a_polygon_object():
    objects = topology()["objects"]
    refs = {u["geometryRef"] for u in [*atlas()["units"], *atlas().get("references", [])]}
    assert refs == set(objects), "unused or missing TopoJSON objects"
    assert {o["type"] for o in objects.values()} <= {"Polygon", "MultiPolygon"}


def test_unit_rows_are_unique_and_contiguous_in_time():
    by_id: dict[str, list[dict]] = {}
    for unit in atlas()["units"]:
        by_id.setdefault(unit["id"], []).append(unit)
    for unit_id, rows in by_id.items():
        rows.sort(key=lambda u: u["validFrom"])
        starts = [r["validFrom"] for r in rows]
        assert len(starts) == len(set(starts)), unit_id
        for earlier, later in zip(rows, rows[1:], strict=False):
            assert earlier["validTo"] is not None and earlier["validTo"] <= later["validFrom"], unit_id


def test_every_event_change_names_a_unit_row_or_dissolution():
    for event in atlas()["events"]:
        for change in event["changes"]:
            rows = [u for u in atlas()["units"] if u["id"] == change["unit"]]
            assert rows, change
            if change["kind"] == "dissolve":
                assert any(u["validTo"] == event["date"] for u in rows), (event["date"], change)
            else:
                assert any(u["validFrom"] == event["date"] for u in rows), (event["date"], change)


def test_1900_has_yukon_and_the_nwt_districts_but_no_province_of_alberta():
    units = resolve("1900-07-01")
    assert "yukon" in units
    assert {"district_of_alberta", "district_of_athabasca", "district_of_mackenzie"} <= set(units)
    assert "alberta" not in units and "saskatchewan" not in units


def test_1906_alberta_and_saskatchewan_reach_60_north():
    units = resolve("1906-01-01")
    for unit_id in ("alberta", "saskatchewan"):
        assert units[unit_id]["status"] == "province"
        _, south, _, north = geometry(units[unit_id]["geometryRef"]).bounds
        assert north == pytest.approx(60, abs=0.01), unit_id
        assert south == pytest.approx(49, abs=0.01), unit_id


def test_1930_manitoba_reaches_60_north():
    manitoba = geometry(resolve("1930-01-01")["manitoba"]["geometryRef"])
    assert manitoba.bounds[3] == pytest.approx(60, abs=0.01)
    assert manitoba.contains(Point(-97.86, 55.74))  # Thompson, north of the 1881 limit


def test_1950_includes_newfoundland_as_a_province():
    assert resolve("1950-01-01")["newfoundland"]["status"] == "province"
    assert resolve("1948-01-01")["newfoundland"]["status"] == "colony"


def test_nunavut_arrives_on_1999_04_01():
    assert "nunavut" not in resolve("1998-12-31")
    assert "nunavut" not in resolve("1999-03-31")
    assert resolve("1999-04-01")["nunavut"]["capital"] == "Iqaluit"


def test_capitals_lie_inside_their_units_today():
    capitals = {
        "alberta": (-113.49, 53.54),
        "british_columbia": (-123.37, 48.43),
        "manitoba": (-97.14, 49.9),
        "new_brunswick": (-66.64, 45.96),
        "newfoundland": (-52.71, 47.56),
        "nova_scotia": (-63.58, 44.65),
        "ontario": (-79.38, 43.65),
        "prince_edward_island": (-63.13, 46.24),
        "quebec": (-71.21, 46.81),
        "saskatchewan": (-104.61, 50.45),
        "northwest_territories": (-114.37, 62.45),
        "yukon": (-135.06, 60.72),
        "nunavut": (-68.52, 63.75),
    }
    today = resolve("2026-01-01")
    assert set(today) == set(capitals)
    for unit_id, point in capitals.items():
        assert geometry(today[unit_id]["geometryRef"]).buffer(0.05).contains(Point(point)), unit_id


# The five places the atlas departs from NRCan's drawing (docs/decisions.md, PR #5 review).
DIVERGENCES = {
    ("arctic_islands", "1867-07-01"),
    ("manitoba", "1870-07-15"),
    ("northwest_territories", "1895-10-02"),
    ("district_of_ungava", "1912-05-15"),
    ("district_of_franklin", "1927-03-01"),
}


def test_every_divergence_cites_its_instrument_and_ships_nrcans_drawing():
    units = {(u["id"], u["validFrom"]): u for u in atlas()["units"]}
    departing = {key for key, u in units.items() if "rationale" in u}
    assert departing == DIVERGENCES
    references = atlas()["references"]
    for key in DIVERGENCES:
        unit = units[key]
        assert unit["instrument"] and unit["rationale"] and 0 < unit["confidence"] <= 1, key
        refs = [r for r in references if (r["unit"], r["validFrom"]) == key]
        assert refs, f"no NRCan overlay for {key}"
        for ref in refs:
            assert "Open Government Licence" in ref["attribution"]
            assert ref["source"].startswith("nrcan_te_")
            assert unit["validTo"] is None or (
                ref["validTo"] is not None and ref["validTo"] <= unit["validTo"]
            )
    assert {r["unit"] for r in references} == {key[0] for key in DIVERGENCES}


def test_uncertain_dates_carry_a_confidence_and_their_alternative():
    events = {e["date"]: e for e in atlas()["events"]}
    assert set(events) >= {"1874-07-09", "1881-07-01", "1927-03-01"}
    for date, alternative in (
        ("1874-07-09", "26 June"),
        ("1881-07-01", "23 December"),
        ("1927-03-01", "22 March"),
    ):
        assert 0 < events[date]["dateConfidence"] < 1
        assert alternative in events[date]["note"]
