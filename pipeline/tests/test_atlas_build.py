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


def test_annotations_and_date_confidence_reach_the_document(monkeypatch):
    # NRCan's "map": a box that also covers the east, clipped to the unit it contrasts with.
    reference = {"Big Territory": box(-110, 49, -80, 60), "Tiny": box(-100, 49, -99.99, 49.01)}
    monkeypatch.setattr(build.compare, "nrcan_polygons_wgs84", lambda year: reference)
    events, rows = build.resolve_events(
        doc(
            {
                "date": "1870-01-01",
                "title": "Start",
                "note": "n",
                "date_confidence": 0.5,
                "changes": [
                    create(
                        "west",
                        {"modern": ["WE", "MI"]},
                        instrument="An Act, s. 1",
                        rationale="The text is clear.",
                        confidence=0.9,
                        nrcan_overlay={
                            "year": 1870,
                            "until": "1875-01-01",
                            "polygons": [{"name": "Big Territory", "clip": {"unit": "west"}, "note": "n"}],
                        },
                    ),
                    create("east", {"modern": ["EA"]}),
                ],
            },
            {
                "date": "1880-01-01",
                "title": "Later",
                "note": "n",
                "changes": [{"alter": "west", "capital": "X"}],
            },
        ),
        FakeSources(),
    )
    build.assign_refs(rows)
    atlas = build.atlas_document(events, rows)
    assert atlas["events"][0]["dateConfidence"] == 0.5 and "dateConfidence" not in atlas["events"][1]
    first, later = [u for u in atlas["units"] if u["id"] == "west"]
    assert (first["instrument"], first["rationale"], first["confidence"]) == (
        "An Act, s. 1",
        "The text is clear.",
        0.9,
    )
    assert not {"instrument", "rationale", "confidence"} & set(later), "annotations belong to one drawing"
    (ref,) = atlas["references"]
    assert (ref["unit"], ref["source"], ref["validFrom"], ref["validTo"]) == (
        "west",
        "nrcan_te_1870",
        "1870-01-01",
        "1875-01-01",
    )
    assert ref["id"] == ref["geometryRef"] == "nrcan_west_1870_big_territory"
    clipped = next(r for r in rows if r.id == "west").references[0]["geometry"]
    assert clipped.bounds == (-110, 49, -90, 60)

    with pytest.raises(ValueError, match="leaves nothing"):
        build.resolve_events(
            doc({"date": "1870-01-01", "title": "t", "note": "n", "changes": [
                create("w", {"modern": ["WE"]}, nrcan_overlay={"year": 1870, "polygons": [
                    {"name": "Tiny", "clip": {"unit": "w"}}]}),
            ]}),
            FakeSources(),
        )  # fmt: skip


def test_unknown_event_keys_are_rejected():
    with pytest.raises(ValueError, match="unknown keys"):
        build.resolve_events(
            doc({"date": "1870-01-01", "title": "t", "note": "n", "dat": 1, "changes": []}), FakeSources()
        )


def test_control_points_name_the_unit_holding_a_place():
    events, rows = build.resolve_events(
        doc({"date": "1870-01-01", "title": "t", "note": "n", "changes": [
            create("west", {"modern": ["WE"]}), create("rest", {"modern": ["MI", "EA"]})]}),
        FakeSources(),
    )  # fmt: skip
    results = build.control_points(
        {
            "checks": [
                {"date": "1875-01-01", "point": [-105, 55], "unit": "west", "source": "s"},
                {"date": "1875-01-01", "point": [-95, 55], "unit": "west", "source": "s"},
            ]
        },
        rows,
    )
    assert results[0][1] is None
    assert "not west" in results[1][1] and "rest" in results[1][1]
    with pytest.raises(ValueError, match="date, point, unit and source"):
        build.control_points({"checks": [{"date": "1875-01-01", "point": [0, 0]}]}, rows)


def test_rows_older_than_nrcans_maps_are_compared_on_its_first_date():
    from atlas import compare

    assert compare.comparison_date("1784-06-18", None) == "1867-07-01"
    assert compare.comparison_date("1784-06-18", "1867-07-01") == "1784-06-18"  # ended before the maps
    assert compare.comparison_date("1870-07-15", None) == "1870-07-15"


def test_buffers_and_coast_strips_are_measured_in_kilometres():
    from atlas.sources import Sources

    circle = Sources().buffer([(-100.0, 50.0)], [], 100)
    minx, miny, maxx, maxy = circle.bounds
    assert maxy - miny == pytest.approx(200 / 111.2, rel=0.02)  # ~1.8° of latitude
    corridor = Sources().buffer([], [(-100.0, 50.0), (-99.0, 50.0)], 10)
    assert corridor.contains(Point(-99.5, 50.05)) and not corridor.contains(Point(-99.5, 50.2))

    src = Sources()
    src.__dict__["mainland"] = box(-70, 45, -60, 55)  # the sea lies north of 55°N
    strip = src.near_coast(box(-68, 50, -62, 56), 50)
    assert strip.contains(Point(-65, 54.8)) and not strip.contains(Point(-65, 53.5))


def test_presence_snapshots_take_open_posts_and_belts_by_year_and_power(tmp_path):
    data = tmp_path / "defacto.yaml"
    data.write_text(
        """
tiers: {post: 100}
posts:
  - {id: a, name: A, at: [-100, 55], tier: post, periods: [[1700, 1710, french], [1720, null, british]]}
belts:
  - {id: b, name: B, km: 10, periods: [[1700, null, british]], line: [[-90, 50], [-85, 50]]}
""",
        encoding="utf-8",
    )
    build.load_defacto.cache_clear()

    def fake_buffer(points, line, km):
        geoms = [shapely.Point(p) for p in points] + ([shapely.LineString(line)] if line else [])
        return shapely.buffer(shapely.union_all(geoms), km / 100)

    class Sources(FakeSources):
        buffer = staticmethod(fake_buffer)

    evaluator = build.Evaluator(Sources(), defacto_path=data)
    assert evaluator.eval({"posts": {"as_of": 1705, "power": "french"}}).contains(Point(-100, 55.5))
    assert evaluator.eval({"posts": {"as_of": 1725, "power": "british"}}).contains(Point(-100, 55.5))
    with pytest.raises(ValueError, match="no posts open for british in 1715"):
        evaluator.eval({"posts": {"as_of": 1715, "power": "british"}})
    assert evaluator.eval({"belts": {"as_of": 1800, "power": "british"}}).contains(Point(-87, 50.05))
    with pytest.raises(ValueError, match="as_of"):
        evaluator.eval({"belts": {"year": 1800, "power": "british"}})


def test_claims_may_reach_beyond_canada_but_units_may_not():
    """A claim over ground now American is drawn whole; clipping it to Canada would draw the
    dispute as already settled our way."""

    class Sources(FakeSources):
        modern = {**FakeSources.modern, "US": box(-110, 40, -80, 49)}

    evaluator = build.Evaluator(Sources())
    claim = {"box": [-95, 45, -90, 55]}  # half in Canada, half in the "US"
    assert evaluator(claim, "canada").bounds == (-95, 49, -90, 55)
    assert evaluator(claim, "north_america").bounds == (-95, 45, -90, 55)
    # `none` keeps even the part in the sea, for a maritime zone.
    assert evaluator({"box": [-95, 30, -90, 35]}, "none").bounds == (-95, 30, -90, 35)
    with pytest.raises(ValueError, match="empty after clipping to canada"):
        evaluator({"box": [-95, 30, -90, 35]}, "canada")
    with pytest.raises(ValueError, match="unknown clip"):
        evaluator(claim, "everything")


def test_disputed_rows_carry_their_dispute_and_do_not_have_to_agree():
    """Two claim rows of one dispute overlap on purpose: that overlap is the dispute."""
    events, rows = build.resolve_events(
        doc(
            {
                "date": "1818-10-20",
                "title": "Joint occupation",
                "note": "Both claim it.",
                "changes": [
                    create(
                        "west",
                        {"modern": ["WE", "MI", "EA"]},
                        truth="dejure",
                    ),
                    create(
                        "british_claim",
                        {"box": [-110, 49, -95, 60]},
                        truth="disputed",
                        dispute="oregon",
                        sovereign="Britain",
                        status="disputed",
                        confidence=0.9,
                    ),
                    create(
                        "american_claim",
                        {"box": [-105, 49, -90, 60]},
                        truth="disputed",
                        dispute="oregon",
                        sovereign="United States",
                        status="disputed",
                        confidence=0.9,
                    ),
                ],
            }
        ),
        FakeSources(),
    )
    assert build.validate(events, rows, FakeSources.canada) == []
    document = build.atlas_document(events, rows)
    claims = [u for u in document["units"] if u["truth"] == "disputed"]
    assert [u["dispute"] for u in claims] == ["oregon", "oregon"]
    assert {u["sovereign"] for u in claims} == {"Britain", "United States"}


def test_requires_pass_through_and_must_hold_in_the_base():
    start = {
        "date": "1870-01-01",
        "title": "Start",
        "note": "n",
        "changes": [create("big", {"canada": True})],
    }
    held = {
        "date": "1880-01-01",
        "title": "Promoted",
        "note": "n",
        "requires": [
            {"unit": "big", "status": "territory", "because": "Only  a territory\n can be promoted."}
        ],
        "changes": [{"alter": "big", "status": "province"}],
    }
    events, _ = build.resolve_events(doc(start, held), FakeSources())
    assert events[1]["requires"] == [
        {"unit": "big", "status": "territory", "because": "Only a territory can be promoted."}
    ]
    assert "requires" not in events[0]

    broken = {**held, "requires": [{"unit": "big", "sovereign": "Britain", "because": "b"}]}
    with pytest.raises(ValueError, match="1880-01-01: requires big sovereign='Britain'"):
        build.resolve_events(doc(start, broken), FakeSources())
    absent = {**held, "requires": [{"unit": "small", "because": "b"}]}
    with pytest.raises(ValueError, match="requires small exists=True"):
        build.resolve_events(doc(start, absent), FakeSources())
    no_reason = {**held, "requires": [{"unit": "big"}]}
    with pytest.raises(ValueError, match="takes unit, because"):
        build.resolve_events(doc(start, no_reason), FakeSources())
