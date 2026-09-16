"""The contact frontier: contact.yaml's resolution rule, its bands, and the file itself."""

import shapely
from shapely.geometry import box

from atlas import contact


def region(id_, year, geometry):
    return contact.Region(
        id=id_,
        name=id_.title(),
        year=year,
        event="test",
        confidence=0.5,
        source="test",
        geometry=geometry,
    )


DOC = {
    "caveat": "test",
    "bands": [
        {"from": None, "until": 1600, "label": "Before 1600"},
        {"from": 1600, "until": 1700, "label": "1600–1699"},
        {"from": 1700, "until": None, "label": "1700 and after"},
    ],
    "regions": [],
}


def test_a_place_takes_the_earliest_year_covering_it():
    """The rule that lets a coastal strip cut through the basin it sits in, in any order."""
    basin = region("basin", 1743, box(-90, 50, -80, 60))
    coast = region("coast", 1610, box(-90, 50, -88, 60))
    for regions in ([basin, coast], [coast, basin]):
        lons = [-89.0, -85.0, -70.0]  # coast, interior, outside every entry
        lats = [55.0, 55.0, 55.0]
        years = contact.cell_years(regions, lons, lats)
        assert list(years) == [1610, 1743, 0]  # coast, interior, nothing covering


def test_bands_are_disjoint_and_follow_the_same_rule_as_the_years():
    """A band is the ground its entries cover less anything earlier, so the drawing and the
    per-cell years cannot disagree."""
    regions = [region("basin", 1743, box(-90, 50, -80, 60)), region("coast", 1610, box(-90, 50, -88, 60))]
    bands = contact.bands(DOC, regions)
    assert [b.label for b in bands] == ["1600–1699", "1700 and after"]
    early, late = (b.geometry for b in bands)
    assert early.intersection(late).area == 0
    assert early.contains(shapely.Point(-89, 55))
    assert late.contains(shapely.Point(-85, 55)) and not late.contains(shapely.Point(-89, 55))


def test_the_shipped_file_covers_every_drainage_basin_and_cites_everything():
    doc = contact.load_contact()
    assert doc["caveat"].strip()
    basins = {code for r in doc["regions"] if "drainage" in r["where"] for code in r["where"]["drainage"]}
    # The 25 StatCan regions partition Canada: that is what makes the map gapless.
    assert basins == {f"{n:02d}" for n in range(1, 26)}
    for r in doc["regions"]:
        assert r["source"].startswith("http"), r["id"]
        assert 0 < r["confidence"] <= 1, r["id"]
        assert r["event"].strip(), r["id"]
