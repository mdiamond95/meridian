"""Census inputs shared by mesh.py and attributes.py."""

from __future__ import annotations

import geopandas as gpd
import h3
import pandas as pd
import shapely

from common import EQUAL_AREA_CRS, H3_RESOLUTION, WGS84, raw_file
from geo import read_vector

C_POP = 1  # Census Profile characteristic: population, 2021


def load_profile(source_id: str) -> pd.DataFrame:
    """Wide table: index geo code, columns characteristic ids, NaN where suppressed."""
    df = pd.read_csv(raw_file(source_id), dtype={"ALT_GEO_CODE": str, "CHARACTERISTIC": int, "FLAG": str})
    df["OBS_VALUE"] = pd.to_numeric(df["OBS_VALUE"], errors="coerce")
    return df.pivot_table(index="ALT_GEO_CODE", columns="CHARACTERISTIC", values="OBS_VALUE", aggfunc="first")


def da_points() -> gpd.GeoDataFrame:
    """One representative point (point_on_surface, EPSG:3347) per 2021 DA, sorted by DAUID, with
    its 2021 population (0 where not published) and the H3 cell containing it."""
    das = read_vector(raw_file("statcan_da_2021"), crs=EQUAL_AREA_CRS).sort_values("DAUID", kind="stable")
    das = das.reset_index(drop=True)
    points = gpd.GeoSeries(
        shapely.point_on_surface(shapely.make_valid(das.geometry.to_numpy())), crs=EQUAL_AREA_CRS
    )
    wgs = points.to_crs(WGS84)
    population = das["DAUID"].map(load_profile("statcan_profile_da_2021")[C_POP]).fillna(0)
    return gpd.GeoDataFrame(
        {
            "dauid": das["DAUID"].to_numpy(),
            "pruid": das["PRUID"].to_numpy(),
            "population": population.to_numpy(),
            "cell": [
                h3.latlng_to_cell(lat, lng, H3_RESOLUTION) for lat, lng in zip(wgs.y, wgs.x, strict=True)
            ],
        },
        geometry=points.to_numpy(),
        crs=EQUAL_AREA_CRS,
    )
