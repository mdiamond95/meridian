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
    ("arctic_islands", "1763-10-07"),
    ("manitoba", "1870-07-15"),
    ("northwest_territories", "1895-10-02"),
    ("district_of_ungava", "1912-05-15"),
    ("district_of_franklin", "1927-03-01"),
}


def test_every_divergence_cites_its_instrument_and_ships_nrcans_drawing():
    units = {(u["id"], u["validFrom"]): u for u in atlas()["units"]}
    # A claim also explains itself, but it departs from nothing: NRCan draws boundaries, not claims.
    departing = {
        key for key, u in units.items() if "rationale" in u and u["truth"] == "dejure" and "dispute" not in u
    }
    assert departing == DIVERGENCES
    references = atlas()["references"]
    for key in DIVERGENCES:
        unit = units[key]
        assert unit["instrument"] and unit["rationale"] and 0 < unit["confidence"] <= 1, key
        # A reference may start after its row: NRCan's first map is 1867, older units start earlier.
        refs = [
            r
            for r in references
            if r["unit"] == key[0]
            and r["validFrom"] >= unit["validFrom"]
            and (unit["validTo"] is None or r["validFrom"] < unit["validTo"])
        ]
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


def test_control_points_hold_in_the_artefact():
    """The checks in events.yaml, re-run on the committed geometry (display-simplified, so with the
    same ~1 km tolerance the build uses)."""
    from atlas import build

    checks = build.load_events(build.EVENTS).get("checks", [])
    for check in checks:
        date = str(check["date"])
        units = resolve(date)
        assert check["unit"] in units, (date, check["unit"])
        polygon = geometry(units[check["unit"]]["geometryRef"])
        assert polygon.buffer(build.CHECK_TOLERANCE_DEG * 3).covers(Point(check["point"])), check


def test_1700_new_france_ruperts_land_and_acadia():
    units = resolve("1700-01-01")
    assert units["new_france"]["sovereign"] == "France"
    assert units["ruperts_land"]["status"] == "hbc_charter"
    assert units["newfoundland"]["status"] == "disputed"
    assert {"acadia", "north_western_territory"} <= set(units)
    assert "quebec" not in units and "nova_scotia" not in units


def test_1800_upper_and_lower_canada_and_1850_the_province_of_canada():
    units = resolve("1800-01-01")
    assert {"upper_canada", "lower_canada", "new_brunswick", "cape_breton", "prince_edward_island"} <= set(
        units
    )
    assert "province_of_canada" not in units
    later = resolve("1850-01-01")
    assert "province_of_canada" in later and "upper_canada" not in later and "cape_breton" not in later


def test_confederation_dissolves_the_province_of_canada():
    before, after = resolve("1867-06-30"), resolve("1867-07-01")
    assert "province_of_canada" in before and "ontario" not in before
    assert {"ontario", "quebec"} <= set(after) and "province_of_canada" not in after


def test_de_facto_layer_covers_1670_to_1870_and_never_counts_as_de_jure():
    assert resolve("1700-01-01", "defacto") and resolve("1860-01-01", "defacto")
    assert resolve("1871-01-01", "defacto") == {}
    for unit in atlas()["units"]:
        if unit["truth"] == "defacto":
            assert unit["confidence"] < 1


# Dispute id → the claimants the shipped atlas must name, and a date each is open.
DISPUTES = {
    "oregon": ({"United States", "Britain"}, "1830-01-01"),
    "san_juan": ({"Britain and the United States"}, "1860-01-01"),
    "labrador": ({"Canada (for Quebec)", "Newfoundland"}, "1900-01-01"),
    "ontario_manitoba": ({"Canada (Manitoba)", "Canada (Ontario)"}, "1885-01-01"),
    "sverdrup": ({"Norway (Sverdrup claim)"}, "1920-01-01"),
    "hans_island": ({"Canada", "Kingdom of Denmark (Greenland)"}, "2000-01-01"),
    "machias_seal": ({"Canada and the United States"}, "2000-01-01"),
}


def test_every_dispute_names_its_claimants_and_cites_its_instrument():
    claims = [u for u in atlas()["units"] if u["truth"] == "disputed"]
    assert {c["dispute"] for c in claims} == set(DISPUTES)
    for dispute, (claimants, date) in DISPUTES.items():
        open_now = [c for c in resolve(date, "disputed").values() if c["dispute"] == dispute]
        assert open_now, f"{dispute} should be open on {date}"
        assert {c["sovereign"] for c in open_now} == claimants, dispute
    for claim in claims:
        # A claim without its instrument is just a shape someone drew.
        assert claim["instrument"].strip(), claim["id"]
        assert claim["rationale"].strip(), claim["id"]
        assert 0 < claim["confidence"] <= 1, claim["id"]


def test_the_open_dispute_is_still_open_and_the_closed_ones_closed():
    claims = {u["id"]: u for u in atlas()["units"] if u["truth"] == "disputed"}
    assert claims["machias_grey_zone"]["validTo"] is None  # Machias Seal has never been settled
    assert all(c["validTo"] for i, c in claims.items() if i != "machias_grey_zone")


def test_the_2022_agreement_takes_the_east_of_hans_island_out_of_nunavut():
    """The last event in the atlas, and Canada's first new land boundary since 1949.

    It is a real de jure change that the *display* copy cannot show: the Greenlandic part is about
    0.57 km², well under the 2 km² part minimum that keeps thousands of Arctic islets out of the
    topology, so both Nunavut rows share one drawn polygon. What the artefact must carry is the
    row, its date and its instrument.
    """
    rows = [u for u in atlas()["units"] if u["id"] == "nunavut"]
    assert [u["validFrom"] for u in rows] == ["1999-04-01", "2022-06-14"]
    divided = rows[-1]
    assert divided["validTo"] is None
    assert "14 June 2022" in divided["instrument"]
    assert divided["confidence"] == 0.6
    event = next(e for e in atlas()["events"] if e["date"] == "2022-06-14")
    assert [c["unit"] for c in event["changes"]] == ["hans_claim_canada", "hans_claim_denmark", "nunavut"]


def test_claims_are_not_clipped_to_canada():
    """The Oregon and San Juan claims cover ground that is American today; the point of drawing a
    claim is that it was not yet settled."""
    oregon = geometry(resolve("1830-01-01", "disputed")["oregon_claim_us"]["geometryRef"])
    assert oregon.bounds[1] < 48.0  # well south of the 49th parallel
    san_juan = geometry(resolve("1860-01-01", "disputed")["san_juan_claim"]["geometryRef"])
    assert san_juan.bounds[3] < 49.0
