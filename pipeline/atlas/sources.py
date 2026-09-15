"""Raw inputs for the atlas: modern units, the land they clip to, drainage, and named rivers.

Everything is returned in WGS84 lon/lat. Modern provinces come from the Atlas of Canada 1:1M
boundary polygons (the same coverage as the mesh), coverage-simplified in metres before
reprojection so neighbouring provinces keep identical shared edges.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from functools import cached_property

import geopandas as gpd
import shapely

from atlas.primitives import partition, polygonal
from common import RAW, WGS84, load_manifest, raw_file, write_bytes
from geo import read_vector, zip_dataset
from mesh import ATLAS_POL_DIV

ATLAS_CRS = "EPSG:3978"  # the Atlas of Canada file's own Lambert, in metres
SIMPLIFY_M = 250
# Bump when atlas.primitives.partition changes, so the cached partition is rebuilt.
PARTITION_VERSION = 1
# Foreign neighbours in the same file, by its COUNTRY code.
FOREIGN = {2: "US", 4: "GL"}
RIVER_REGIONS = ("arctic", "atlantic", "baffin", "hudson", "islands", "mackenzie", "nelson", "pacific")


def log(message: str) -> None:
    print(f"[atlas {time.strftime('%H:%M:%S')}] {message}", flush=True)


@dataclass
class Sources:
    """Lazily loaded, cached inputs. `rivers` maps a region to the reach names to read from it."""

    rivers: dict[str, list[str]] = field(default_factory=dict)

    @cached_property
    def modern(self) -> dict[str, shapely.Geometry]:
        """Province and territory code → polygon, plus foreign neighbours ("US", "GL")."""
        path = raw_file("nrcan_atlas_boundaries_1m")
        gdf = read_vector(f"/vsizip/{path}/AC_1M_BoundaryPolygons.gdb", layer="AC_1M_BoundaryPolygons")
        gdf = gdf[gdf["COUNTRY"].isin([1, *FOREIGN]) & gdf["POL_DIV"].notna()].copy()
        gdf["unit"] = [
            ATLAS_POL_DIV[int(p)] if c == 1 else FOREIGN[int(c)]
            for c, p in zip(gdf["COUNTRY"], gdf["POL_DIV"], strict=True)
        ]
        gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
        units = gdf.dissolve("unit", as_index=False, sort=True)
        canadian = units["unit"].isin(ATLAS_POL_DIV.values()).to_numpy()
        simplified = units.geometry.to_numpy().copy()
        simplified[canadian] = shapely.coverage_simplify(simplified[canadian], SIMPLIFY_M)
        simplified[~canadian] = shapely.simplify(simplified[~canadian], SIMPLIFY_M)
        units["geometry"] = simplified
        units = units.set_crs(ATLAS_CRS, allow_override=True).to_crs(WGS84)
        units["geometry"] = [polygonal(shapely.make_valid(g)) for g in units.geometry]
        log(f"modern units: {', '.join(units['unit'])}")
        return dict(zip(units["unit"], units.geometry, strict=True))

    @cached_property
    def canada(self) -> shapely.Geometry:
        return shapely.union_all(
            [g for code, g in sorted(self.modern.items()) if code in ATLAS_POL_DIV.values()]
        )

    @cached_property
    def mainland(self) -> shapely.Geometry:
        """The largest part of Canada: North America without its islands."""
        parts, _, index = self.parts
        return parts[index]

    @cached_property
    def drainage(self) -> list[tuple[str, str, shapely.Geometry]]:
        """(region code, ocean drainage area name, drainage region polygon), sorted by code."""
        gdf = read_vector(zip_dataset(raw_file("statcan_drainage_regions"), r"\.gdb/?$"))
        gdf = gdf.sort_values("Drainage_region_code", kind="stable").to_crs(ATLAS_CRS)
        # Only the inland divides matter (the land clip supplies the coast), so simplify like the
        # provinces; the regions form a coverage, and coverage_simplify keeps the divides shared.
        gdf["geometry"] = shapely.coverage_simplify(shapely.make_valid(gdf.geometry.to_numpy()), SIMPLIFY_M)
        gdf = gdf.to_crs(WGS84)
        geoms = [polygonal(shapely.make_valid(g)) for g in gdf.geometry]
        return list(zip(gdf["Drainage_region_code"], gdf["Ocean_drainage_area_name"], geoms, strict=True))

    @cached_property
    def drainage_land(self) -> dict[str, shapely.Geometry]:
        """Modern Canada split among the drainage regions (atlas.primitives.partition). Slow, so
        cached in data/raw/.cache keyed by the two inputs' recorded SHA-256."""
        manifest = load_manifest()
        inputs = [manifest[s]["sha256"] for s in ("nrcan_atlas_boundaries_1m", "statcan_drainage_regions")]
        key = hashlib.sha256(json.dumps([PARTITION_VERSION, SIMPLIFY_M, inputs]).encode()).hexdigest()[:16]
        cache = RAW / ".cache" / f"atlas-drainage-{key}.json"
        if cache.exists():
            cached = json.loads(cache.read_text(encoding="utf-8"))
            return {code: shapely.from_wkb(bytes.fromhex(h)) for code, h in cached.items()}
        parts = partition([(code, geom) for code, _, geom in self.drainage], self.canada)
        write_bytes(cache, json.dumps({c: shapely.to_wkb(g, hex=True) for c, g in parts.items()}).encode())
        log("drainage partition cached")
        return parts

    @cached_property
    def parts(self) -> tuple[list[shapely.Geometry], shapely.STRtree, int]:
        """Canada's polygon parts, a tree of their representative points, and the mainland's index."""
        parts = list(getattr(self.canada, "geoms", [self.canada]))
        mainland = max(range(len(parts)), key=lambda i: parts[i].area)
        return parts, shapely.STRtree([part.representative_point() for part in parts]), mainland

    def coastal_islands(self, km: float) -> shapely.Geometry:
        """Every island within `km` of the mainland ("islands within three miles of the coast")."""
        parts, _, mainland = self.parts
        projected = gpd.GeoSeries(parts, crs=WGS84).to_crs(ATLAS_CRS).to_numpy()
        near = shapely.STRtree(projected).query(projected[mainland], predicate="dwithin", distance=km * 1000)
        return shapely.union_all([parts[i] for i in sorted(near) if i != mainland])

    @cached_property
    def river_reaches(self) -> dict[str, list[shapely.Geometry]]:
        """Reach name → Canada1Water flow lines with that name, from the regions requested.

        Extracting a regional GeoPackage takes minutes, so the selected reaches are cached in
        data/raw/.cache, keyed by the zip's recorded SHA-256 and the names read.
        """
        out: dict[str, list[shapely.Geometry]] = {}
        manifest = load_manifest()
        for region in sorted(self.rivers):
            if region not in RIVER_REGIONS:
                raise ValueError(f"unknown Canada1Water region {region!r}")
            names = sorted(set(self.rivers[region]))
            source = f"nrcan_c1w_strahler_{region}"
            key = hashlib.sha256(json.dumps([manifest[source]["sha256"], names]).encode()).hexdigest()[:16]
            cache = RAW / ".cache" / f"atlas-rivers-{region}-{key}.json"
            if cache.exists():
                cached = json.loads(cache.read_text(encoding="utf-8"))
            else:
                cached = self._read_reaches(source, names)
                write_bytes(cache, json.dumps(cached).encode("utf-8"))
            for name in names:
                out.setdefault(name, []).extend(shapely.from_wkb([bytes.fromhex(h) for h in cached[name]]))
            log(f"rivers {region}: {', '.join(f'{n} ({len(cached[n])})' for n in names)}")
        return out

    @staticmethod
    def _read_reaches(source: str, names: list[str]) -> dict[str, list[str]]:
        quoted = ", ".join("'" + n.replace("'", "''") + "'" for n in names)
        # Reading a multi-GB GeoPackage through /vsizip/ is very slow; extract it first.
        with tempfile.TemporaryDirectory(prefix="meridian-atlas-rivers-") as scratch:
            with zipfile.ZipFile(raw_file(source)) as zf:
                member = next(m for m in zf.namelist() if m.endswith(".gpkg"))
                gpkg = zf.extract(member, scratch)
            reaches = read_vector(gpkg, columns=["NAME_1"], where=f"NAME_1 IN ({quoted})")
        reaches = gpd.GeoDataFrame(reaches, geometry="geometry").to_crs(WGS84)
        wkb = shapely.to_wkb(shapely.force_2d(reaches.geometry.to_numpy()), hex=True)
        out = {}
        for name in names:
            picked = sorted(w for w, n in zip(wkb, reaches["NAME_1"], strict=True) if n == name)
            if not picked:
                raise ValueError(f"no reaches named {name!r} in {source}")
            out[name] = picked
        return out
