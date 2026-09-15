"""The atlas event walker and validator on a synthetic three-province country (no raw data)."""

import pytest
import shapely
from shapely.geometry import Point, box

from atlas import build


class FakeSources:
    """Modern units are boxes: WE west of 100°W, MI 100–90°W, EA east of 90°W, all 49–60°N."""

    modern = {"WE": box(-110, 49, -100, 60), "MI": box(-100, 49, -90, 60), "EA": box(-90, 49, -80, 60)}
    canada = shapely.union_all(list(modern.values()))
    mainland = canada
    parts = ([canada], shapely.STRtree([canada.representative_point()]), 0)
    drainage = [("16", "Hudson Bay", box(-100, 55, -80, 60))]
    river_reaches: dict = {}


def doc(*events):
    return {"events": list(events)}


def create(unit, geometry, **fields):
    return {
        "create": unit,
        "name": unit.title(),
        "status": "territory",
        "sovereign": "Canada",
        "boundary": "test",
        "geometry": geometry,
        **fields,
    }


def test_changes_become_rows_with_validity_ranges_and_shared_geometry():
    events, rows = build.resolve_events(
        doc(
            {
                "date": "1870-01-01",
                "title": "Start",
                "note": "One.  Two.",
                "changes": [
                    create("big", {"canada": True}),
                ],
            },
            {
                "date": "1880-01-01",
                "title": "Split",
                "note": "n",
                "changes": [
                    create("west", {"modern": ["WE"]}, status="province"),
                    {
                        "alter": "big",
                        "geometry": {"minus": [{"unit": "big"}, {"unit": "west"}]},
                        "boundary": "rest",
                    },
                ],
            },
            {
                "date": "1890-01-01",
                "title": "Rename",
                "note": "n",
                "changes": [
                    {"rename": "big", "name": "Remainder"},
                ],
            },
            {
                "date": "1900-01-01",
                "title": "Merge",
                "note": "n",
                "changes": [
                    {"dissolve": "west"},
                    {"alter": "big", "geometry": {"canada": True}, "boundary": "all"},
                ],
            },
        ),
        FakeSources(),
    )
    assert events[0]["note"] == "One. Two."
    assert [c["kind"] for c in events[1]["changes"]] == ["create", "alter"]
    spans = [(r.id, r.valid_from, r.valid_to, r.fields["name"]) for r in rows]
    assert spans == [
        ("big", "1870-01-01", "1880-01-01", "Big"),
        ("west", "1880-01-01", "1900-01-01", "West"),
        ("big", "1880-01-01", "1890-01-01", "Big"),
        ("big", "1890-01-01", "1900-01-01", "Remainder"),
        ("big", "1900-01-01", None, "Remainder"),
    ]
    rest = rows[2].geometry
    assert rest.contains(Point(-95, 55)) and not rest.contains(Point(-105, 55))
    shapes = build.assign_refs(rows)
    # The rename shares its predecessor's polygon; the merge restores the 1870 one.
    assert [r.ref for r in rows] == ["big_1870", "west_1880", "big_1880", "big_1880", "big_1870"]
    assert len(shapes) == 3
    assert build.validate(events, rows, FakeSources.canada) == []


def test_validation_reports_overlaps_and_gaps():
    events, rows = build.resolve_events(
        doc(
            {
                "date": "1870-01-01",
                "title": "Bad",
                "note": "n",
                "changes": [
                    create("a", {"modern": ["WE", "MI"]}),
                    create("b", {"modern": ["MI"]}),
                ],
            }
        ),
        FakeSources(),
    )
    problems = build.validate(events, rows, FakeSources.canada)
    assert any("a and b overlap" in p for p in problems)
    assert any("cover" in p for p in problems)  # EA is missing


@pytest.mark.parametrize(
    "change, message",
    [
        ({"alter": "ghost", "geometry": {"canada": True}, "boundary": "x"}, "does not exist"),
        (
            {
                "create": "big",
                "name": "B",
                "status": "territory",
                "sovereign": "C",
                "boundary": "x",
                "geometry": {"canada": True},
            },
            "already exists",
        ),
        ({"rename": "big", "name": "B", "geometry": {"canada": True}}, "rename"),
        ({"dissolve": "big", "name": "B"}, "dissolve takes no other keys"),
        ({"alter": "big", "colour": "red"}, "unknown keys"),
        ({"alter": "big", "geometry": {"box": [0, 0, 1, 1]}, "boundary": "x"}, "empty after clipping"),
    ],
)
def test_bad_changes_name_the_event_and_unit(change, message):
    events = doc(
        {"date": "1870-01-01", "title": "Start", "note": "n", "changes": [create("big", {"canada": True})]},
        {"date": "1880-01-01", "title": "Bad", "note": "n", "changes": [change]},
    )
    with pytest.raises(ValueError, match=message) as info:
        build.resolve_events(events, FakeSources())
    assert "1880-01-01" in str(info.value)


def test_events_must_be_in_date_order():
    events = doc(
        {"date": "1880-01-01", "title": "Later", "note": "n", "changes": []},
        {"date": "1870-01-01", "title": "Earlier", "note": "n", "changes": []},
    )
    with pytest.raises(ValueError, match="out of order"):
        build.resolve_events(events, FakeSources())


def test_rivers_needed_collects_names_by_region():
    found = build.rivers_needed(
        {
            "events": [
                {
                    "changes": [
                        {
                            "geometry": {
                                "ring": [
                                    {
                                        "river": {
                                            "names": ["Albany River"],
                                            "region": "hudson",
                                            "from": [0, 0],
                                            "to": [1, 1],
                                        }
                                    },
                                    {
                                        "river": {
                                            "names": ["English River", "Albany River"],
                                            "region": "nelson",
                                            "from": [0, 0],
                                            "to": [1, 1],
                                        }
                                    },
                                ]
                            }
                        }
                    ]
                }
            ]
        }
    )
    assert found == {"hudson": ["Albany River"], "nelson": ["Albany River", "English River"]}


def test_events_yaml_keeps_province_codes_as_strings(tmp_path):
    path = tmp_path / "events.yaml"
    path.write_text("codes: [ON, NO, yes, 'QC']\nflag: true\ndate: 1867-07-01\n", encoding="utf-8")
    doc = build.load_events(path)
    assert doc["codes"] == ["ON", "NO", "yes", "QC"] and doc["flag"] is True
    assert str(doc["date"]) == "1867-07-01"


def test_was_sees_units_as_they_stood_when_the_event_began():
    events, rows = build.resolve_events(
        doc(
            {
                "date": "1870-01-01",
                "title": "Start",
                "note": "n",
                "changes": [create("a", {"modern": ["WE", "MI"]}), create("b", {"modern": ["EA"]})],
            },
            {
                "date": "1880-01-01",
                "title": "Swap",
                "note": "n",
                "changes": [
                    {"alter": "a", "geometry": {"modern": ["WE"]}, "boundary": "x"},
                    # `unit: a` is already the smaller a; `was: a` still has MI to hand over.
                    {
                        "alter": "b",
                        "geometry": {"union": [{"was": "b"}, {"minus": [{"was": "a"}, {"unit": "a"}]}]},
                        "boundary": "x",
                    },
                ],
            },
        ),
        FakeSources(),
    )
    assert rows[-1].geometry.equals(box(-100, 49, -80, 60))
    assert build.validate(events, rows, FakeSources.canada) == []


def test_zone_takes_whole_islands_by_where_they_sit():
    island = box(-85, 61, -84, 62)  # straddles the zone edge at 84.5°W; its centre is inside
    canada = shapely.union_all([FakeSources.canada, island])

    class Sources(FakeSources):
        pass

    Sources.canada = canada
    Sources.mainland = FakeSources.canada
    parts = [FakeSources.canada, island]
    Sources.parts = (parts, shapely.STRtree([g.representative_point() for g in parts]), 0)
    evaluator = build.Evaluator(Sources())
    taken = evaluator.eval({"zone": {"box": [-90, 55, -84.4, 70]}})
    assert taken.contains(Point(-84.2, 61.5))  # the whole island, beyond the zone edge
    assert taken.contains(Point(-88, 56)) and not taken.contains(Point(-83, 56))
