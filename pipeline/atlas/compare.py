"""Compare constructed atlas polygons with NRCan's Territorial Evolution of Canada maps.

The atlas is built from boundary primitives; NRCan's historical maps (sources `nrcan_te_<year>`)
are the reference Mark verifies against. For each unit row this measures, in equal-area metres,
how well the constructed polygon matches the NRCan polygon of the same name for the row's first
year: intersection over union, and the area that differs. The result goes into the checklist, so
review can start with the polygons that disagree most.

NRCan geometry is used here and, where the atlas departs from NRCan's drawing, shipped as a
reference overlay (events.yaml `nrcan_overlay`, AtlasFile.references). No atlas unit is derived
from it.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import cache

import geopandas as gpd
import shapely

from atlas.primitives import polygonal
from common import EQUAL_AREA_CRS, WGS84, load_manifest, raw_file

NRCAN_YEARS = (1867, 1870, 1871, 1873, 1874, 1876, 1880, 1881, 1882, 1886, 1889, 1895, 1897, 1898, 1901, 1905,
               1912, 1920, 1927, 1949, 1999, 2001)  # fmt: skip


@dataclass(frozen=True)
class Agreement:
    year: int
    nrcan_name: str
    iou: float | None  # None when NRCan has no polygon of that name
    differ_km2: float


FIRST_MAP_DATE = "1867-07-01"


def comparison_date(valid_from: str, valid_to: str | None) -> str:
    """Compare a row on its first day, or on NRCan's first map date if it began earlier and was
    still valid then (a colony founded in 1784 is compared on 1 July 1867)."""
    if valid_from < FIRST_MAP_DATE and (valid_to is None or valid_to > FIRST_MAP_DATE):
        return FIRST_MAP_DATE
    return valid_from


def nrcan_year(date: str) -> int | None:
    """The NRCan map for a date: the latest map year on or before it."""
    year = int(date[:4])
    candidates = [y for y in NRCAN_YEARS if y <= year]
    return candidates[-1] if candidates else None


def available() -> bool:
    manifest = load_manifest()
    return all(f"nrcan_te_{y}" in manifest for y in NRCAN_YEARS)


@cache
def nrcan_coverage(year: int) -> shapely.Geometry:
    """Everything NRCan draws that year. It leaves out the Great Lakes, which the Atlas of Canada
    1:1M coverage includes, so constructed polygons are clipped to this before comparing."""
    return shapely.union_all(list(nrcan_polygons(year).values()))


@cache
def nrcan_polygons(year: int) -> dict[str, shapely.Geometry]:
    """PROV_NAME → dissolved polygon in EPSG:3347."""
    gdf = gpd.read_file(raw_file(f"nrcan_te_{year}")).set_crs(WGS84, allow_override=True)
    gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
    gdf = gdf.to_crs(EQUAL_AREA_CRS)
    gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
    return {
        name: polygonal(shapely.union_all(group.geometry.to_numpy()))
        for name, group in gdf.groupby("PROV_NAME", sort=True)
    }


@cache
def nrcan_polygons_wgs84(year: int) -> dict[str, shapely.Geometry]:
    """PROV_NAME → dissolved polygon in lon/lat, for the reference overlays."""
    gdf = gpd.read_file(raw_file(f"nrcan_te_{year}")).set_crs(WGS84, allow_override=True)
    gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
    return {
        name: polygonal(shapely.union_all(group.geometry.to_numpy()))
        for name, group in gdf.groupby("PROV_NAME", sort=True)
    }


def agreement(projected: shapely.Geometry, nrcan_name: str, date: str) -> Agreement | None:
    """`projected` is the constructed polygon in EPSG:3347."""
    year = nrcan_year(date)
    if year is None:
        return None
    reference = nrcan_polygons(year).get(nrcan_name)
    if reference is None:
        return Agreement(year, nrcan_name, None, 0.0)
    projected = shapely.intersection(projected, nrcan_coverage(year))
    inter = shapely.intersection(projected, reference).area
    union = shapely.union(projected, reference).area
    return Agreement(year, nrcan_name, inter / union if union else 0.0, (union - inter) / 1e6)


def describe(result: Agreement | None) -> str:
    if result is None:
        return "No NRCan vector map before 1867 (NRCan publishes only scanned rasters for earlier dates)."
    if result.iou is None:
        return f"NRCan {result.year}: no polygon named “{result.nrcan_name}”."
    overlap = f"{result.iou:.1%} overlap, {result.differ_km2:,.0f} km² differ"
    return f"NRCan {result.year} “{result.nrcan_name}”: {overlap}."
