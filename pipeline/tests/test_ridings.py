"""The riding table (ridings.py, 1.0.3): the brief's gate on the committed file, and the helpers."""

from __future__ import annotations

import gzip
import json
from collections import Counter
from functools import cache

import pytest

import ridings
from columns import decode_column
from common import BUILD, MESH_VERSION

TABLE = ridings.RIDINGS_PATH
ATTRS = BUILD / f"attrs.{MESH_VERSION}.json.gz"
PLACES = BUILD / f"places.{MESH_VERSION}.json.gz"
built = pytest.mark.skipif(not TABLE.exists(), reason="ridings not built")


def load(path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


@cache
def table() -> dict:
    return load(TABLE)


def on(row: dict, date: str) -> dict:
    (span,) = [s for s in row["jurisdictions"] if s["from"] <= date and (s["to"] is None or date < s["to"])]
    return span


@built
def test_one_row_per_riding_in_fed_order():
    t = table()
    assert (t["format"], t["version"], t["unit"]) == ("meridian.unitTable", 1, "fed_2023")
    ids = [r["id"] for r in t["rows"]]
    assert len(ids) == 343 and ids == sorted(set(ids))
    assert Counter(r["province"] for r in t["rows"]) == {
        "ON": 122, "QC": 78, "BC": 43, "AB": 37, "MB": 14, "SK": 14, "NS": 11, "NB": 10,
        "NL": 7, "PE": 4, "YT": 1, "NT": 1, "NU": 1,
    }  # fmt: skip


@built
def test_population_reconciles_to_attrs():
    attrs_total = int(decode_column(load(ATTRS)["columns"]["population"]).sum())
    assert attrs_total == 36_991_981
    assert sum(r["population"] for r in table()["rows"]) == attrs_total
    assert all(r["score"]["population"] == r["population"] for r in table()["rows"])


@built
def test_neighbours_are_the_894_shared_arcs():
    rows = table()["rows"]
    edges = {(r["id"], n) for r in rows for n in r["neighbours"] if r["id"] < n}
    assert len(edges) == 894
    assert all(r["neighbours"] for r in rows), "every riding borders another"


@built
def test_every_place_is_in_exactly_one_riding():
    placed = [p["csd"] for r in table()["rows"] for p in r["places"]]
    assert sorted(placed) == sorted(p["csd"] for p in load(PLACES)["places"])


@built
def test_1867_jurisdictions():
    counts = Counter(on(r, "1867-07-01")["name"] for r in table()["rows"])
    assert counts == {
        "Ontario": 118, "Quebec": 77, "Nova Scotia": 11, "New Brunswick": 10, "British Columbia": 43,
        "Newfoundland": 6, "Prince Edward Island": 4, "Rupert's Land": 66, "North-Western Territory": 7,
        "British Arctic Islands": 1,
    }  # fmt: skip
    assert sum(on(r, "1867-07-01")["sovereign"] == "Canada" for r in table()["rows"]) == 216


@built
def test_every_riding_has_a_jurisdiction_for_every_date():
    atlas = json.loads(ridings.ATLAS_PATH.read_text(encoding="utf-8"))
    starts = [start for start, _ in ridings.intervals(atlas)]
    for row in table()["rows"]:
        for date in starts:
            on(row, date)
        assert row["jurisdictions"][0]["from"] == "1867-07-01" and row["jurisdictions"][-1]["to"] is None
        assert row["jurisdictions"][-1]["sovereign"] == "Canada"


@built
def test_today_every_riding_is_in_its_own_province():
    names = {
        "NL": "Newfoundland and Labrador", "PE": "Prince Edward Island", "NS": "Nova Scotia",
        "NB": "New Brunswick", "QC": "Quebec", "ON": "Ontario", "MB": "Manitoba", "SK": "Saskatchewan",
        "AB": "Alberta", "BC": "British Columbia", "YT": "Yukon", "NT": "Northwest Territories",
        "NU": "Nunavut",
    }  # fmt: skip
    today = [(r["id"], on(r, "2026-01-01")["name"], names[r["province"]]) for r in table()["rows"]]
    assert [row for row in today if row[1] != row[2]] == []


@built
def test_scores_and_gdp():
    t = table()
    assert t["gdpCaveat"] == ridings.GDP_CAVEAT
    assert all(0 <= r["score"]["exposure"] <= 1 and 0 <= r["score"]["resource_index"] <= 1 for r in t["rows"])
    assert all("cohesion" not in r["score"] for r in t["rows"])
    # The oil and farm ridings of the Prairies lead on resources.
    top = sorted(t["rows"], key=lambda r: -r["score"]["resource_index"])[:3]
    assert {r["province"] for r in top} <= {"AB", "SK"}
    assert "Fort McMurray—Cold Lake" in [r["name"] for r in top]


@built
def test_gdp_reconciles_by_province_to_attrs():
    """attrs reconciles each province to the StatCan table exactly; the ridings, rounded to whole
    millions, must reconcile to the same totals within half a million each."""
    attrs = load(ATTRS)
    cells = load(BUILD / f"mesh.{MESH_VERSION}.json.gz")["cells"]
    gdp = decode_column(attrs["columns"]["gdp_estimate"])
    by_province = Counter()
    for cell, value in zip(cells, gdp, strict=True):
        by_province[cell["province"]] += float(value)
    rows = table()["rows"]
    for province, total in by_province.items():
        ours = [r["score"]["gdp"] for r in rows if r["province"] == province]
        assert abs(sum(ours) - total) <= 0.5 * len(ours) + 1e-6 * total, province


# --- helpers --------------------------------------------------------------------------------


def span(start, end, unit, share=1.0, **extra):
    return {"from": start, "to": end, "unit": unit, "name": unit.title(), "status": "province",
            "sovereign": "Canada", "share": share, **extra}  # fmt: skip


def test_merge_spans_joins_agreeing_neighbours_and_keeps_the_smallest_share():
    merged = ridings.merge_spans(
        [
            span("1867-07-01", "1870-07-15", "ruperts_land", 0.9),
            span("1870-07-15", "1889-08-12", "ontario", 0.6),
            span("1889-08-12", "1912-05-15", "ontario", 1.0),
            span("1912-05-15", None, "ontario", 0.99),
        ]
    )
    assert [(s["unit"], s["from"], s["to"], s["share"]) for s in merged] == [
        ("ruperts_land", "1867-07-01", "1870-07-15", 0.9),
        ("ontario", "1870-07-15", None, 0.6),
    ]


def test_merge_spans_does_not_join_a_fallback_to_a_measured_span():
    merged = ridings.merge_spans(
        [span("1867-07-01", "1870-07-15", "quebec"), span("1870-07-15", None, "quebec", 0.0, fallback=True)]
    )
    assert len(merged) == 2


def test_arc_neighbours_reads_shared_arcs_in_either_direction():
    topo = {
        "objects": {
            "r": {
                "geometries": [
                    {"type": "Polygon", "arcs": [[0, 1]], "properties": {"fed": 2}},
                    {"type": "Polygon", "arcs": [[~1, 2]], "properties": {"fed": 1}},
                    {"type": "MultiPolygon", "arcs": [[[3]], [[~2, 4]]], "properties": {"fed": 3}},
                    {"type": "Polygon", "arcs": [[5]], "properties": {"fed": 4}},
                ]
            }
        }
    }
    assert ridings.arc_neighbours(topo, "r", "fed") == {1: [2, 3], 2: [1], 3: [1], 4: []}


def test_intervals_start_at_confederation_and_run_on():
    atlas = {
        "events": [{"date": d} for d in ("1763-02-10", "1867-07-01", "1870-07-15", "1999-04-01")],
        "units": [
            {"truth": "dejure", "validFrom": "1867-07-01", "validTo": "1870-07-15"},
            {"truth": "defacto", "validFrom": "1867-07-01", "validTo": "1868-01-01"},
        ],
    }
    assert ridings.intervals(atlas) == [
        ("1867-07-01", "1870-07-15"),
        ("1870-07-15", "1999-04-01"),
        ("1999-04-01", None),
    ]
    atlas["units"].append({"truth": "dejure", "validFrom": "1880-01-01", "validTo": None})
    with pytest.raises(ValueError, match="not events"):
        ridings.intervals(atlas)
