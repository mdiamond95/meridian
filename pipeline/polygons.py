"""Build data/build/layers/*.topojson.gz: simplified overlay and snap layers (gzipped TopoJSON).

    make layers

Each layer is exported to GeoJSON (WGS84, only the properties the app needs) and simplified
with mapshaper (pinned version, Visvalingam weighted, shapes kept) into TopoJSON. Provinces,
census divisions and census subdivisions share one topology per tier (low/mid/high) for
zoom-dependent loading.

The `indigenous` builder writes its own pair instead (data/build/indigenous.v1.json and
indigenous.v1.topojson.gz): the language-family column from attrs dissolved into one area per family
and source, clipped to Canada, with the Wikidata community labels (indigenous.py).
"""

from __future__ import annotations

import resource
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely

from census import release_memory
from common import BUILD, EQUAL_AREA_CRS, MESH_VERSION, WGS84, gzip_bytes, raw_file, write_bytes
from geo import read_vector, zip_dataset
from mesh import PRUID_TO_CODE
from splitter_inputs import layer_cells, layer_places, layer_snap

MAPSHAPER_VERSION = "0.7.61"
LAYERS = BUILD / "layers"
# Simplification interval in metres per tier (mapshaper -simplify interval=).
# Tier → (simplification interval in metres, layers included). Province and CD edges are CSD edges,
# so each tier is one topology with shared arcs.
TIERS = {
    "low": (5000, ["provinces"]),
    "mid": (1000, ["provinces", "cd"]),
    "high": (400, ["provinces", "cd", "csd"]),
}
SINGLE_INTERVAL = {"treaties": 1000, "ecozones": 1500, "basins": 1500, "rivers": 150, "ridings": 500}
BASIN_TOLERANCE_M = 1000
BASIN_MIN_PART_KM2 = 50
RIVER_MIN_STRAHLER = 7  # on the 1:50K Canada1Water network; see docs/decisions.md
RIVER_REGIONS = ["arctic", "atlantic", "baffin", "hudson", "islands", "mackenzie", "nelson", "pacific"]


def log(message: str) -> None:
    peak_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024  # Linux reports KiB
    print(f"[layers {time.strftime('%H:%M:%S')} peak {peak_mb:,.0f} MB] {message}", flush=True)


def mapshaper_cmd() -> list[str]:
    exe = shutil.which("mapshaper")
    if exe:
        version = subprocess.run([exe, "-v"], capture_output=True, text=True).stdout.strip()
        if version == MAPSHAPER_VERSION:
            return [exe]
    return ["npx", "--yes", f"mapshaper@{MAPSHAPER_VERSION}"]


def polygonal(geom):
    """Polygon parts only: make_valid can leave line or point slivers in a GeometryCollection,
    and mapshaper splits mixed geometry types into separate layers."""
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    parts = [g for g in getattr(geom, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else None


def export(gdf: gpd.GeoDataFrame, path: Path, keep: list[str], sort: str, lines: bool = False) -> None:
    gdf = gdf.sort_values(sort, kind="stable")[[*keep, "geometry"]].copy()
    if not lines:
        gdf["geometry"] = [polygonal(g) for g in gdf.geometry]
        gdf = gdf[gdf.geometry.notna()]
    gdf = gdf.to_crs(WGS84)
    path.unlink(missing_ok=True)
    gdf.to_file(path, driver="GeoJSON", COORDINATE_PRECISION=6)


def simplify(inputs: dict[str, Path], out: Path, interval: int, lines: bool = False) -> None:
    """mapshaper: one TopoJSON with one object per input. Object names come from the input file
    stems, so each input must be written as <name>.geojson."""
    for name, path in inputs.items():
        if path.stem != name:
            raise ValueError(f"input for {name!r} must be named {name}.geojson")
    # mapshaper (Node) needs its own gigabyte or more; give back what the export freed first, or the
    # Codespaces host terminates the pipeline (docs/perf.md).
    release_memory()
    cmd = [*mapshaper_cmd(), "-i", *[str(p) for p in inputs.values()], "combine-files", "snap"]
    cmd += ["-simplify", "weighted", f"interval={interval}", "keep-shapes" if not lines else "", "target=*"]
    plain = out.parent / f".{out.name.removesuffix('.gz')}"
    cmd += ["-o", str(plain), "format=topojson", "quantization=100000", "target=*"]
    cmd = [c for c in cmd if c]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"mapshaper failed for {out.name}:\n{result.stderr[-2000:]}")
    # TopoJSON compresses 3-4x; layers ship gzipped like the mesh and attributes.
    write_bytes(out, gzip_bytes(plain.read_bytes().rstrip(b"\n") + b"\n"))
    plain.unlink()


def csd_layers() -> dict[str, gpd.GeoDataFrame]:
    csd = read_vector(raw_file("statcan_csd_2021"), crs=EQUAL_AREA_CRS)
    csd["geometry"] = shapely.make_valid(csd.geometry.to_numpy())
    csd = csd.rename(columns={"CSDUID": "csd", "CSDNAME": "name"})
    csd["province"] = csd["PRUID"].map(PRUID_TO_CODE)
    csd["cd"] = csd["csd"].str[:4]
    cd = csd.dissolve("cd", as_index=False, aggfunc={"province": "first"})
    provinces = csd.dissolve("province", as_index=False)
    return {
        "provinces": (provinces, ["province"], "province"),
        "cd": (cd, ["cd", "province"], "cd"),
        "csd": (csd, ["csd", "cd", "province", "name"], "csd"),
    }


def river_network(canada) -> gpd.GeoDataFrame:
    """Canada1Water reaches at or above the order threshold, clipped to Canada and merged into
    one line per (order, name) so the layer is a few thousand features, not a million reaches."""
    import zipfile

    frames = []
    for region in RIVER_REGIONS:
        # Reading a multi-GB GeoPackage through /vsizip/ takes ~20 min per region; extracting it to
        # a scratch directory first takes about a minute.
        with tempfile.TemporaryDirectory(prefix=f"meridian-c1w-{region}-") as scratch:
            with zipfile.ZipFile(raw_file(f"nrcan_c1w_strahler_{region}")) as zf:
                member = next(m for m in zf.namelist() if m.endswith(".gpkg"))
                path = zf.extract(member, scratch)
            reaches = read_vector(
                path, columns=["Strahler", "NAME_1"], where=f"Strahler >= {RIVER_MIN_STRAHLER}"
            )
        log(f"  {region}: {len(reaches):,} reaches")
        frames.append(reaches.to_crs(EQUAL_AREA_CRS))
    rivers = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=EQUAL_AREA_CRS)
    rivers["geometry"] = shapely.force_2d(rivers.geometry.to_numpy())
    rivers["order"] = rivers["Strahler"].astype(int)
    rivers["name"] = rivers["NAME_1"].fillna("")
    merged = []
    for (order, name), group in rivers.groupby(["order", "name"], sort=True):
        lines = shapely.line_merge(shapely.union_all(group.geometry.to_numpy()))
        lines = shapely.intersection(lines, canada)
        if not lines.is_empty:
            merged.append({"order": order, "name": name or None, "geometry": lines})
    out = gpd.GeoDataFrame(merged, crs=EQUAL_AREA_CRS)
    out["key"] = np.arange(len(out))
    return out


def canada_outline() -> shapely.Geometry:
    """Canada from the drainage regions, simplified to 500 m for fast clipping."""
    drainage = read_vector(zip_dataset(raw_file("statcan_drainage_regions"), r"\.gdb/?$"), columns=[])
    return shapely.union_all(drainage.to_crs(EQUAL_AREA_CRS).geometry.simplify(500).to_numpy())


def export_boundaries(tmp: Path) -> dict[str, Path]:
    sources = {}
    for name, (gdf, keep, sort) in csd_layers().items():
        sources[name] = tmp / f"{name}.geojson"
        export(gdf, sources[name], keep, sort)
    return sources


def layer_boundaries(tmp: Path) -> list[Path]:
    # Exported in a separate function so the CSD, CD and province frames are freed before mapshaper runs.
    sources = export_boundaries(tmp)
    written = []
    for tier, (interval, names) in TIERS.items():
        out = LAYERS / f"boundaries.{tier}.{MESH_VERSION}.topojson.gz"
        simplify({n: sources[n] for n in names}, out, interval)
        written.append(out)
    return written


def layer_treaties(tmp: Path) -> list[Path]:
    export_treaties(tmp)
    out = LAYERS / f"treaties.{MESH_VERSION}.topojson.gz"
    inputs = {"historic": tmp / "historic.geojson", "modern": tmp / "modern.geojson"}
    simplify(inputs, out, SINGLE_INTERVAL["treaties"])
    return [out]


def export_treaties(tmp: Path) -> None:
    historic = read_vector(zip_dataset(raw_file("cirnac_historic_treaties")))
    modern = read_vector(zip_dataset(raw_file("cirnac_modern_treaties")))
    historic["kind"] = np.where(
        historic["SBTP_ENAME"].str.strip() == "Numbered Treaty", "numbered", "historic"
    )
    modern["kind"] = "modern"
    for gdf, file in ((historic, "historic"), (modern, "modern")):
        gdf["geometry"] = shapely.make_valid(gdf.geometry.to_numpy())
        renamed = gdf.rename(columns={"TAG_ID": "tag", "ENAME": "name"})
        export(renamed, tmp / f"{file}.geojson", ["tag", "name", "kind"], "tag")


def layer_ecozones(tmp: Path) -> list[Path]:
    export_ecozones(tmp)
    out = LAYERS / f"ecozones.{MESH_VERSION}.topojson.gz"
    simplify({"ecozones": tmp / "ecozones.geojson"}, out, SINGLE_INTERVAL["ecozones"])
    return [out]


def export_ecozones(tmp: Path) -> None:
    eco = read_vector(raw_file("aafc_ecozones")).dissolve("ECOZONE_ID", as_index=False, aggfunc="first")
    eco = eco.rename(columns={"ECOZONE_ID": "id", "ECOZONE_NAME_EN": "name"})
    export(eco, tmp / "ecozones.geojson", ["id", "name"], "id")


def generalize(gdf: gpd.GeoDataFrame, key: str, tolerance_m: float, min_part_km2: float) -> gpd.GeoDataFrame:
    """Drop polygon parts smaller than min_part_km2 and coverage-simplify so neighbouring polygons
    keep identical shared edges. For drainage layers, where Arctic island coastline is noise."""
    parts = gdf[[key, "geometry"]].to_crs(EQUAL_AREA_CRS).explode(index_parts=False, ignore_index=True)
    parts = parts[parts.geometry.area >= min_part_km2 * 1e6]
    merged = parts.dissolve(key, as_index=False, sort=True)
    merged["geometry"] = shapely.coverage_simplify(merged.geometry.to_numpy(), tolerance_m)
    rest = pd.DataFrame(gdf.drop(columns="geometry")).drop_duplicates(key)
    return gpd.GeoDataFrame(merged.merge(rest, on=key), geometry="geometry", crs=EQUAL_AREA_CRS)


def layer_basins(tmp: Path) -> list[Path]:
    export_regions(tmp)
    release_memory()
    export_subbasins(tmp)
    out = LAYERS / f"basins.{MESH_VERSION}.topojson.gz"
    inputs = {"regions": tmp / "regions.geojson", "subbasins": tmp / "subbasins.geojson"}
    simplify(inputs, out, SINGLE_INTERVAL["basins"])
    return [out]


def export_regions(tmp: Path) -> None:
    drainage = read_vector(zip_dataset(raw_file("statcan_drainage_regions"), r"\.gdb/?$"))
    names = {
        "Drainage_region_code": "code",
        "Drainage_region_name": "name",
        "Ocean_drainage_area_name": "ocean",
    }
    drainage = drainage.rename(columns=names)[["code", "name", "ocean", "geometry"]]
    drainage["geometry"] = shapely.make_valid(drainage.geometry.to_numpy())
    regions = generalize(drainage, "code", BASIN_TOLERANCE_M, BASIN_MIN_PART_KM2)
    export(regions, tmp / "regions.geojson", ["code", "name", "ocean"], "code")


def export_subbasins(tmp: Path) -> None:
    """NHN work units: 25M vertices. Each major drainage area (the first two characters of the
    sub-drainage code) is read, simplified to 100 m and dissolved to sub-drainage areas on its own,
    so the full-resolution units are never all in memory; a sub-drainage area never spans two major
    areas, so this equals one national pass. Then the US parts are clipped away."""
    path = zip_dataset(raw_file("nrcan_nhn_workunits"))
    codes = read_vector(path, columns=["WSCSDA"], read_geometry=False)["WSCSDA"].dropna()
    chunks = []
    for major in sorted({code[:2] for code in codes}):
        nhn = read_vector(path, columns=["WSCSDA", "WSCSDANAME", "WSCMDA"], where=f"WSCSDA LIKE '{major}%'")
        nhn = nhn[nhn["WSCSDA"].notna()].to_crs(EQUAL_AREA_CRS)
        nhn["geometry"] = shapely.make_valid(shapely.simplify(nhn.geometry.to_numpy(), 100))
        chunks.append(nhn.dissolve("WSCSDA", as_index=False, aggfunc="first"))
        del nhn
        release_memory()
    nhn = gpd.GeoDataFrame(pd.concat(chunks, ignore_index=True), geometry="geometry", crs=EQUAL_AREA_CRS)
    del chunks
    nhn = nhn.sort_values("WSCSDA", kind="stable").reset_index(drop=True)
    nhn["geometry"] = shapely.intersection(nhn.geometry.to_numpy(), canada_outline())
    nhn["geometry"] = [polygonal(g) for g in nhn.geometry]
    nhn = nhn[nhn.geometry.notna()].rename(
        columns={"WSCSDA": "code", "WSCSDANAME": "name", "WSCMDA": "major"}
    )
    subbasins = generalize(
        nhn[["code", "name", "major", "geometry"]], "code", BASIN_TOLERANCE_M, BASIN_MIN_PART_KM2
    )
    export(subbasins, tmp / "subbasins.geojson", ["code", "name", "major"], "code")


def layer_rivers(tmp: Path) -> list[Path]:
    export(river_network(canada_outline()), tmp / "rivers.geojson", ["order", "name"], "key", lines=True)
    out = LAYERS / f"rivers.{MESH_VERSION}.topojson.gz"
    simplify({"rivers": tmp / "rivers.geojson"}, out, SINGLE_INTERVAL["rivers"], lines=True)
    return [out]


def layer_ridings(tmp: Path) -> list[Path]:
    export_ridings(tmp)
    out = LAYERS / f"ridings.{MESH_VERSION}.topojson.gz"
    simplify({"ridings": tmp / "ridings.geojson"}, out, SINGLE_INTERVAL["ridings"])
    return [out]


def export_ridings(tmp: Path) -> None:
    feds = read_vector(zip_dataset(raw_file("elections_fed_2023"), r"\.shp$"))
    feds = feds.rename(columns={"FED_NUM": "fed", "ED_NAMEE": "name"})
    feds["geometry"] = shapely.make_valid(feds.geometry.to_numpy())
    export(feds, tmp / "ridings.geojson", ["fed", "name"], "fed")


INDIGENOUS_VERSION = "v1"
INDIGENOUS_JSON = BUILD / f"indigenous.{INDIGENOUS_VERSION}.json"
INDIGENOUS_TOPOLOGY = BUILD / f"indigenous.{INDIGENOUS_VERSION}.topojson.gz"
INDIGENOUS_ATTRIBUTION = [
    "glottolog_languoids",
    "statcan_profile_csd_indigenous_languages_2021",
    "wikidata_indigenous_communities",
]
STATCAN_LICENCE_URL = "https://www.statcan.gc.ca/en/terms-conditions/open-licence"


def attribution_rows(source_ids: list[str]) -> list[dict[str, str]]:
    """Attribution text and licence for each source, from docs/data-sources.md (one place to edit)."""
    import re

    from dry_run import SOURCES_PATH, Report, parse_sources

    sources = parse_sources(SOURCES_PATH.read_text(encoding="utf-8"), Report())
    rows = []
    for sid in source_ids:
        licence = sources[sid].licence
        url = re.search(r"https://\S+", licence)
        rows.append(
            {
                "source": sid,
                "text": sources[sid].attribution,
                "licence": licence[: url.start()].rstrip(" ,") if url else licence,
                "url": url.group(0) if url else STATCAN_LICENCE_URL,
            }
        )
    return rows


def layer_indigenous(tmp: Path) -> list[Path]:
    """The pre-contact base: one area per (family, source) and the community labels."""
    import gzip
    import json

    import indigenous
    from atlas.build import write_topology
    from columns import decode_column
    from common import write_json
    from geo import cell_polygons
    from mesh import MESH_PATH

    doc = indigenous.load_families()
    with gzip.open(MESH_PATH, "rt", encoding="utf-8") as fh:
        cells = [c["id"] for c in json.load(fh)["cells"]]
    with gzip.open(BUILD / f"attrs.{MESH_VERSION}.json.gz", "rt", encoding="utf-8") as fh:
        attrs = json.load(fh)
    family = decode_column(attrs["columns"]["indigenous_language_family"])
    confidence = decode_column(attrs["columns"]["indigenous_language_family_confidence"])
    del attrs
    polys = cell_polygons(cells).to_numpy()
    canada = canada_outline()

    shapes, areas = [], []
    for code in sorted(int(c) for c in set(family.tolist()) - {0}):
        for source, level in (
            ("census", indigenous.CENSUS_CONFIDENCE),
            ("glottolog", indigenous.GLOTTOLOG_CONFIDENCE),
        ):
            mask = (family == code) & np.isclose(confidence, level)
            if not mask.any():
                continue
            geometry = polygonal(
                shapely.make_valid(shapely.intersection(shapely.union_all(polys[mask]), canada))
            )
            if geometry is None:
                continue
            ref = f"family_{code}_{source}"
            largest_part = max(getattr(geometry, "geoms", [geometry]), key=lambda g: g.area)
            label = gpd.GeoSeries([largest_part.point_on_surface()], crs=EQUAL_AREA_CRS).to_crs(WGS84).iloc[0]
            shapes.append((ref, gpd.GeoSeries([geometry], crs=EQUAL_AREA_CRS).to_crs(WGS84).iloc[0]))
            areas.append(
                {
                    "family": code,
                    "source": source,
                    "confidence": level,
                    "cells": int(mask.sum()),
                    "geometryRef": ref,
                    "labelPoint": [round(label.x, 4), round(label.y, 4)],
                }
            )
    del polys
    release_memory()
    write_topology(shapes, INDIGENOUS_TOPOLOGY)

    communities, _ = indigenous.read_communities(raw_file("wikidata_indigenous_communities"))
    write_json(
        INDIGENOUS_JSON,
        {
            "format": "meridian.indigenous",
            "version": INDIGENOUS_VERSION,
            "caveat": doc["caveat"].strip(),
            "families": [
                {
                    "code": f["code"],
                    "glottocode": f["glottocode"],
                    "glottologName": f["glottolog_name"],
                    "label": f["label"],
                }
                for f in doc["families"]
            ],
            "areas": areas,
            "communities": [
                {"id": c.id, "name": c.name, "people": c.people, "lng": c.lng, "lat": c.lat}
                for c in communities
            ],
            "attribution": attribution_rows(INDIGENOUS_ATTRIBUTION),
        },
    )
    return [INDIGENOUS_JSON, INDIGENOUS_TOPOLOGY]


BUILDERS = {
    "boundaries": layer_boundaries,
    "treaties": layer_treaties,
    "ecozones": layer_ecozones,
    "basins": layer_basins,
    "rivers": layer_rivers,
    "ridings": layer_ridings,
    "indigenous": layer_indigenous,
    # Splitter inputs (splitter_inputs.py); snap reads the rivers layer built above.
    "places": layer_places,
    "cells": layer_cells,
    "snap": layer_snap,
}


def build(only: list[str] | None = None) -> list[Path]:
    written: list[Path] = []
    for name, builder in BUILDERS.items():
        if only and name not in only:
            continue
        log(name)
        with tempfile.TemporaryDirectory(prefix=f"meridian-{name}-") as tmp_dir:
            for path in builder(Path(tmp_dir)):
                log(f"  {path.relative_to(BUILD)}: {path.stat().st_size:,} bytes")
                written.append(path)
        release_memory()
    return written


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Build data/build/layers/*.topojson.gz")
    parser.add_argument("--only", nargs="*", choices=sorted(BUILDERS), help="layers to build (default: all)")
    build(parser.parse_args(argv).only)
    return 0


if __name__ == "__main__":
    sys.exit(main())
