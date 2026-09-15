"""Census inputs shared by mesh.py and attributes.py."""

from __future__ import annotations

import ctypes
import gc
from collections.abc import Iterable

import geopandas as gpd
import h3
import pandas as pd
import shapely

from common import EQUAL_AREA_CRS, H3_RESOLUTION, WGS84, raw_file
from geo import read_vector

C_POP = 1  # Census Profile characteristic: population, 2021
# Statistics Canada province and territory codes (PRUID), in code order.
PROVINCE_UIDS = ("10", "11", "12", "13", "24", "35", "46", "47", "48", "59", "60", "61", "62")


def load_profile(source_id: str, characteristics: Iterable[int] | None = None) -> pd.DataFrame:
    """Wide table: index geo code, columns characteristic ids, NaN where suppressed. Pass
    `characteristics` to keep only those rows before pivoting (the CSV is long: one row per geo and
    characteristic)."""
    df = pd.read_csv(
        raw_file(source_id),
        usecols=["ALT_GEO_CODE", "CHARACTERISTIC", "OBS_VALUE"],
        dtype={"ALT_GEO_CODE": str, "CHARACTERISTIC": int},
    )
    if characteristics is not None:
        df = df[df["CHARACTERISTIC"].isin(set(characteristics))]
    df["OBS_VALUE"] = pd.to_numeric(df["OBS_VALUE"], errors="coerce")
    return df.pivot_table(index="ALT_GEO_CODE", columns="CHARACTERISTIC", values="OBS_VALUE", aggfunc="first")


def da_points() -> gpd.GeoDataFrame:
    """One representative point (point_on_surface, EPSG:3347) per 2021 DA, sorted by DAUID, with
    its 2021 population (0 where not published) and the H3 cell containing it.

    GDAL parses the whole DA GeoJSON on every read, so DAs are read one province at a time and only
    their points are kept: the polygons for all of Canada are never in memory together.
    """
    path = raw_file("statcan_da_2021")
    frames = []
    for pruid in PROVINCE_UIDS:
        das = read_vector(path, crs=EQUAL_AREA_CRS, columns=["DAUID", "PRUID"], where=f"PRUID = '{pruid}'")
        points = shapely.point_on_surface(shapely.make_valid(das.geometry.to_numpy()))
        frames.append(
            pd.DataFrame(
                {"dauid": das["DAUID"].to_numpy(), "pruid": das["PRUID"].to_numpy(), "point": points}
            )
        )
        del das, points
        release_memory()
    table = pd.concat(frames, ignore_index=True).sort_values("dauid", kind="stable").reset_index(drop=True)
    del frames
    points = gpd.GeoSeries(table["point"].to_numpy(), crs=EQUAL_AREA_CRS)
    wgs = points.to_crs(WGS84)
    population = table["dauid"].map(load_profile("statcan_profile_da_2021", [C_POP])[C_POP]).fillna(0)
    return gpd.GeoDataFrame(
        {
            "dauid": table["dauid"].to_numpy(),
            "pruid": table["pruid"].to_numpy(),
            "population": population.to_numpy(),
            "cell": [
                h3.latlng_to_cell(lat, lng, H3_RESOLUTION) for lat, lng in zip(wgs.y, wgs.x, strict=True)
            ],
        },
        geometry=points.to_numpy(),
        crs=EQUAL_AREA_CRS,
    )


def release_memory() -> None:
    """Collect garbage and hand freed heap back to the OS. glibc keeps freed arenas otherwise, so
    peak RSS would only ever grow; the Codespaces host terminates a process that pushes the
    container below about 1 GB free (docs/perf.md)."""
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:  # not glibc (e.g. macOS): nothing to trim
        pass
