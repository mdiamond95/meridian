"""Unit tests for pipeline/atlas/primitives.py against known points on synthetic geometry.

These need no raw data, so they run in CI. test_atlas_sources.py repeats the key checks on the
real inputs when data/raw is present.
"""

import pytest
import shapely
from shapely.geometry import LineString, Point, box

from atlas import primitives as p


def test_parallel_and_meridian_run_in_the_given_direction():
    assert list(p.parallel(49, -99, -96).coords) == [(-99, 49), (-96, 49)]
    assert list(p.meridian(-96, 50.5, 49).coords) == [(-96, 50.5), (-96, 49)]


def test_km_between_matches_a_degree_of_latitude():
    assert p.km_between((-100, 49), (-100, 50)) == pytest.approx(111.2, abs=0.1)


def test_ring_builds_manitoba_1870_from_four_primitives():
    """Manitoba 1870: 49°N to 50°30'N, 96°W to 99°W, walked with pieces given in mixed directions."""
    poly = p.ring(
        [
            p.parallel(49, -99, -96),
            p.meridian(-96, 49, 50.5),
            p.parallel(50.5, -99, -96),  # reversed on purpose
            p.meridian(-99, 49, 50.5),  # reversed on purpose
        ]
    )
    assert poly.is_valid
    assert poly.bounds == (-99, 49, -96, 50.5)
    assert poly.contains(Point(-97.14, 49.9))  # Winnipeg
    assert not poly.contains(Point(-99.95, 49.85))  # Brandon, west of 99°W


def test_ring_rejects_gaps_and_open_walks():
    with pytest.raises(ValueError, match="starts"):
        p.ring([p.parallel(49, -99, -96), p.meridian(-95, 49, 50.5), p.parallel(50.5, -96, -99)])
    with pytest.raises(ValueError, match="does not close"):
        p.ring([p.parallel(49, -99, -96), p.meridian(-96, 49, 50.5), p.parallel(50.5, -96, -98)])


def test_modern_border_is_the_shared_edge():
    west, east = box(-110, 49, -102, 60), box(-102, 49, -95, 60)
    border = p.modern_border(west, east)
    assert border.length == pytest.approx(11)
    assert border.distance(Point(-102, 55)) < 1e-9
    cut = p.modern_border(west, east, start=(-102, 58), end=(-102, 50))
    assert cut.coords[0] == pytest.approx((-102, 58))
    assert cut.coords[-1] == pytest.approx((-102, 50))


def test_modern_border_needs_end_points_when_it_is_in_pieces():
    west = box(-110, 49, -102, 60)
    east = shapely.union_all([box(-102, 49, -95, 53), box(-102, 56, -95, 60)])
    with pytest.raises(ValueError, match="disjoint"):
        p.modern_border(west, east)
    walked = p.modern_border(west, east, start=(-102, 50), end=(-102, 59))
    assert walked.length == pytest.approx(9)


def test_coast_walks_with_land_on_the_chosen_side():
    land = box(0, 0, 10, 10)
    left = p.coast(land, (5, 0), (10, 5), "left")  # counter-clockwise: along the south, up the east
    assert left.length == pytest.approx(10)
    right = p.coast(land, (5, 0), (10, 5), "right")  # clockwise: the long way round
    assert right.length == pytest.approx(30)
    assert right.coords[0] == pytest.approx((5, 0)) and right.coords[-1] == pytest.approx((10, 5))


def test_river_follows_the_network_not_the_straight_line():
    # A river bending north around a lake, plus an unconnected tributary.
    network = [
        LineString([(0, 0), (1, 0), (1, 1)]),
        LineString([(1, 1), (2, 1), (2, 0), (3, 0)]),
        LineString([(5, 5), (6, 6)]),
    ]
    path = p.river(network, (0.01, 0), (3, 0.01))
    assert list(path.coords) == [(0, 0), (1, 0), (1, 1), (2, 1), (2, 0), (3, 0)]
    with pytest.raises(ValueError, match="no connected"):
        p.river(network, (0, 0), (6, 6))


def test_river_bridges_unnamed_lake_crossings_only_when_asked():
    # Two named reaches with a 0.3° (~21 km at 50°N) lake between them.
    network = [LineString([(0, 50), (1, 50)]), LineString([(1.3, 50), (2, 50)])]
    with pytest.raises(ValueError, match="no connected"):
        p.river(network, (0, 50), (2, 50))
    path = p.river(network, (0, 50), (2, 50), bridge_km=30)
    assert list(path.coords) == [(0, 50), (1, 50), (1.3, 50), (2, 50)]
    with pytest.raises(ValueError, match="no connected"):
        p.river(network, (0, 50), (2, 50), bridge_km=10)


def test_between_orients_a_substring():
    path = LineString([(0, 0), (10, 0)])
    piece = p.between(path, (8, 1), (2, -1))
    assert list(piece.coords) == [(8, 0), (2, 0)]


def test_hbc_watershed_takes_hudson_bay_drainage():
    regions = [("15", "Hudson Bay", box(-100, 50, -80, 60)), ("22", "Atlantic Ocean", box(-80, 45, -60, 60))]
    land = box(-95, 40, -70, 58)
    shed = p.hbc_watershed(regions, land)
    # South of both regions (40–45°N) the land is uncovered; it goes to whichever is nearer.
    assert shed.contains(Point(-90, 55)) and shed.contains(Point(-90, 42))
    assert not shed.contains(Point(-75, 42)) and not shed.contains(Point(-75, 55))


def test_drainage_gives_coastal_slivers_to_the_nearest_region():
    # The land runs 1° past both regions' coast in one strip; the strip splits at the divide.
    regions = [("a", box(0, 0, 10, 10)), ("b", box(10, 0, 20, 10))]
    shed = p.drainage(regions, ["a"], box(0, 0, 20, 11))
    assert shed.contains(Point(5, 10.5)) and not shed.contains(Point(15, 10.5))
    assert shed.area == pytest.approx(110, abs=0.1)  # one 0.1° column of tiles at the divide
    with pytest.raises(ValueError, match="unknown"):
        p.drainage(regions, ["c"], box(0, 0, 1, 1))


def test_island_is_the_part_under_a_point():
    land = shapely.union_all([box(0, 0, 10, 10), box(20, 0, 21, 1)])
    assert p.island(land, (20.5, 0.5)).bounds == (20, 0, 21, 1)
    with pytest.raises(ValueError, match="not on land"):
        p.island(land, (15, 5))


def test_cut_keeps_the_side_of_an_isthmus_with_the_point():
    # A dumbbell: two squares joined by a neck at x 4–6; the blade crosses the neck.
    land = shapely.union_all([box(0, 0, 4, 4), box(4, 1.5, 6, 2.5), box(6, 0, 10, 4)])
    east = p.cut(land, LineString([(5, 1), (5, 3)]), (8, 2))
    assert east.bounds == (5, 0, 10, 4)
    with pytest.raises(ValueError, match="edge to edge"):
        p.cut(land, LineString([(5, 1), (5, 2)]), (8, 2))
