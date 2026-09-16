"""Build data/build/atlas.v1.json and atlas.v1.topojson.gz from pipeline/atlas/events.yaml.

    make atlas

Boundaries are constructed, not traced (docs/plan.md, Phase 2). events.yaml lists every change
date; each change describes a unit's boundary as an expression over the primitives in
atlas/primitives.py. This module:

1. walks the events in date order, evaluating each geometry and turning changes into unit rows
   keyed by (id, validFrom), clipped to modern Canada;
2. validates every event date: geometries are valid and non-empty, de jure units do not overlap,
   and their union covers modern Canada within COVERAGE_TOLERANCE;
3. deduplicates geometry, so a unit whose boundary did not change shares one TopoJSON object;
4. simplifies all geometry into one topology with mapshaper (shared edges stay shared) and writes
   the event list and unit rows as an AtlasFile.

Geometry expressions (events.yaml, `geometry:`), all in lon/lat degrees:
    modern: [MB, ON]                 union of modern provinces/territories (Atlas of Canada 1:1M)
    canada: true | mainland: true    modern Canada; its largest part (no islands)
    watershed: hudson_bay            Rupert's Land: land draining to Hudson Bay and Hudson Strait
    drainage: ["22", "25"]           land in StatCan drainage regions, by code
    island: [lon, lat] | islands: [[lon, lat], ...]   the land parts under the points
    coastal_islands: 5.56            every island within that many km of the mainland
    buffer: {points: [[lon, lat], ...] | line: [[lon, lat], ...], km: 150}
                                     land within km of points or a polyline (post catchments, river belts)
    near_coast: {area: expr, km: 40} mainland within km of the sea coast, inside `area`
    posts: {as_of: 1774, power: british}   catchments of that power's posts open that year (defacto.yaml)
    belts: {as_of: 1774, power: british}   corridors of that power's settlement belts open that year
    cut: {of: expr, line: [[lon, lat], ...], keep: [lon, lat]}
                                     the side of a line across an isthmus (ends in water) with `keep`
    zone: expr                       an area drawn through water: the mainland it covers, plus whole
                                     islands whose representative point it contains
    box: [west, south, east, north]  a lon/lat rectangle
    ring: [piece, ...]               an ordered walk, see below
    union: [expr, ...] | intersect: [expr, ...] | minus: [expr, expr, ...]  (first minus the rest)
    unit: <id>                       the current geometry of a unit, as of this change
    was: <id> | was: [<id>, ...]     a unit's geometry when this event began (before any change);
                                     a list unites those of the listed units that existed
    shape: <name>                    a named expression from `shapes:`
A change may also carry `clip:` beside its geometry: canada (the default, modern Canada),
north_america (Canada with the United States and Greenland, for claims over ground now theirs), or
none (no clip at all, for a shape drawn in the sea).
Ring pieces:
    parallel: [lat, lon0, lon1]      meridian: [lon, lat0, lat1]      line: [[lon, lat], ...]
    border: {a: MB, b: ON, from: [lon, lat], to: [lon, lat]}   shared modern border (from/to optional)
    river: {names: [...], region: nelson, from: [lon, lat], to: [lon, lat], bridge_km: 20}
                                     Canada1Water path; bridge_km crosses unnamed lake flow lines
    coast: {from: [lon, lat], to: [lon, lat], side: left|right}   modern Canada's shoreline
    shape: <name>                    a named ring piece from `shapes:`
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np
import shapely
import yaml

from atlas import compare
from atlas import contact as contact_frontier
from atlas import primitives as p
from atlas.sources import Sources, log
from common import BUILD, EQUAL_AREA_CRS, ROOT, WGS84, dumps, gzip_bytes, write_bytes
from polygons import mapshaper_cmd

ATLAS_VERSION = "v1"
CONTACT_VERSION = "v1"
EVENTS = Path(__file__).with_name("events.yaml")
DEFACTO = Path(__file__).with_name("defacto.yaml")
POWERS = ("french", "british", "spanish")
CHECKLIST = ROOT / "docs" / "atlas" / "checklist.md"

# Union of de jure units vs modern Canada, as a share of Canada's area.
COVERAGE_TOLERANCE = 0.005
# Largest pairwise overlap between two de jure units at one date.
OVERLAP_TOLERANCE_KM2 = 5.0
# Display simplification (metres, mapshaper weighted Visvalingam) and the smallest island kept.
SIMPLIFY_INTERVAL_M = 750
MIN_PART_KM2 = 2.0
# Vertices within this distance (degrees) of the line through their neighbours are dropped.
COLLINEAR_DEG = 1e-9
# Coordinates are snapped to this grid (degrees, ~1 cm) before hashing and export.
GRID_DEG = 1e-7
# Longest edge (degrees) before reprojecting for areas and comparisons.
PROJECT_SEGMENT_DEG = 0.02
# Control points may sit on a coast the display generalizes away (degrees, ~1 km).
CHECK_TOLERANCE_DEG = 0.01
UNIT_FIELDS = (
    "name",
    "status",
    "sovereign",
    "capital",
    "truth",
    "dispute",
    "note",
    "confidence",
    "instrument",
    "rationale",
)
# How far a geometry is cut back. Units are Canadian ground; claims need the neighbours too.
CLIPS = ("canada", "north_america", "none")
FOREIGN_CODES = ("US", "GL")
# Per-row annotations: they describe one drawing, so an alter does not carry them forward.
ROW_ANNOTATIONS = ("note", "confidence", "instrument", "rationale")
EVENT_KEYS = {"date", "title", "note", "date_confidence", "changes"}
# Parts of a clipped reference drawing smaller than this are slivers from differing coastlines.
REFERENCE_MIN_PART_KM2 = 20.0
CHANGE_KINDS = ("create", "alter", "rename", "dissolve")
NRCAN_ATTRIBUTION = (
    "Territorial Evolution of Canada, Natural Resources Canada. Contains information licensed under the "
    "Open Government Licence – Canada."
)


# ---- Geometry expressions ------------------------------------------------------------------


@dataclass
class Evaluator:
    sources: Sources
    shapes: dict[str, Any] = field(default_factory=dict)
    current: dict[str, shapely.Geometry] = field(default_factory=dict)
    # Unit geometries as they stood when the current event began, for `was:`.
    before: dict[str, shapely.Geometry] = field(default_factory=dict)
    defacto_path: Path = DEFACTO
    _cache: dict[str, shapely.Geometry] = field(default_factory=dict)

    def __call__(self, expr: Any, clip: str = "canada") -> shapely.Geometry:
        """Evaluate and clip. Units are clipped to modern Canada so every de jure map covers the
        same ground; a *claim* is not, because most of the ground claimed in these disputes is now
        American or Greenlandic, and clipping it away would draw the dispute as if it had already
        been settled our way."""
        geom = self.eval(expr)
        if clip not in CLIPS:
            raise ValueError(f"unknown clip {clip!r}; one of {', '.join(sorted(CLIPS))}")
        if clip == "none":
            clipped = p.polygonal(geom)
        else:
            extent = self.sources.canada if clip == "canada" else self.north_america
            clipped = p.polygonal(shapely.intersection(geom, extent))
        if clipped is None:
            raise ValueError(f"geometry is empty after clipping to {clip}: {expr}")
        return clipped

    @property
    def north_america(self) -> shapely.Geometry:
        """Canada with its neighbours in the same source file: enough for any claim in the atlas."""
        if "north_america" not in self._cache:
            neighbours = [self.sources.modern[c] for c in sorted(FOREIGN_CODES) if c in self.sources.modern]
            self._cache["north_america"] = shapely.union_all([self.sources.canada, *neighbours])
        return self._cache["north_america"]

    def eval(self, expr: Any) -> shapely.Geometry:
        if not isinstance(expr, dict) or len(expr) != 1:
            raise ValueError(f"a geometry expression is a one-key mapping, got {expr!r}")
        ((op, arg),) = expr.items()
        # Shapes may refer to units, so only expressions over fixed inputs are cached.
        cacheable = op in ("modern", "watershed", "drainage", "canada", "mainland", "coastal_islands")
        key = json.dumps(expr, sort_keys=True)
        if cacheable and key in self._cache:
            return self._cache[key]
        geom = self._eval(op, arg)
        if cacheable:
            self._cache[key] = geom
        return geom

    def _eval(self, op: str, arg: Any) -> shapely.Geometry:
        src = self.sources
        if op == "modern":
            missing = [c for c in arg if c not in src.modern]
            if missing:
                raise ValueError(f"unknown modern units {missing}")
            return shapely.union_all([src.modern[c] for c in sorted(arg)])
        if op == "canada":
            return src.canada
        if op == "mainland":
            return src.mainland
        if op == "watershed":
            if arg != "hudson_bay":
                raise ValueError(f"unknown watershed {arg!r}")
            return p.select(src.drainage_land, p.hudson_bay_codes(src.drainage))
        if op == "drainage":
            return p.select(src.drainage_land, arg)
        if op == "island":
            return p.island(src.canada, tuple(arg))
        if op == "islands":
            return shapely.union_all([p.island(src.canada, tuple(pt)) for pt in arg])
        if op == "cut":
            return p.cut(self.eval(arg["of"]), p.line([tuple(pt) for pt in arg["line"]]), tuple(arg["keep"]))
        if op == "buffer":
            return src.buffer(
                [tuple(pt) for pt in arg.get("points", [])],
                [tuple(pt) for pt in arg.get("line", [])],
                float(arg["km"]),
            )
        if op in ("posts", "belts"):
            return self.presence(op, arg)
        if op == "near_coast":
            return src.near_coast(self.eval(arg["area"]), float(arg["km"]))
        if op == "coastal_islands":
            return src.coastal_islands(float(arg))
        if op == "zone":
            return self.zone(self.eval(arg))
        if op == "box":
            west, south, east, north = arg
            return shapely.box(west, south, east, north)
        if op == "ring":
            return p.ring([self.piece(piece) for piece in arg])
        if op == "union":
            return shapely.union_all([self.eval(e) for e in arg])
        if op == "intersect":
            geoms = [self.eval(e) for e in arg]
            out = geoms[0]
            for g in geoms[1:]:
                out = shapely.intersection(out, g)
            return p.polygonal(out) or shapely.Polygon()
        if op == "minus":
            base, *rest = [self.eval(e) for e in arg]
            out = shapely.difference(base, shapely.union_all(rest)) if rest else base
            return p.polygonal(out) or shapely.Polygon()
        if op == "unit":
            if arg not in self.current:
                raise ValueError(f"unit {arg!r} does not exist at this point")
            return self.current[arg]
        if op == "was":
            if isinstance(arg, list):  # the union of whichever listed units existed
                present = [self.before[u] for u in arg if u in self.before]
                if not present:
                    raise ValueError(f"none of {arg} existed when this event began")
                return shapely.union_all(present)
            if arg not in self.before:
                raise ValueError(f"unit {arg!r} did not exist when this event began")
            return self.before[arg]
        if op == "shape":
            if arg not in self.shapes:
                raise ValueError(f"unknown shape {arg!r}")
            return self.eval(self.shapes[arg])
        raise ValueError(f"unknown geometry operator {op!r}")

    def presence(self, kind: str, arg: dict) -> shapely.Geometry:
        """De facto presence of one power in one year (defacto.yaml): the catchments of its open posts,
        or the corridors of its open settlement belts."""
        if set(arg) != {"as_of", "power"} or arg["power"] not in POWERS:
            raise ValueError(f"{kind} takes as_of (a year) and power ({', '.join(POWERS)})")
        data = load_defacto(self.defacto_path)
        year, power = int(arg["as_of"]), arg["power"]

        def open_in(entry: dict) -> bool:
            return any(
                start <= year and (end is None or year < end) and who == power
                for start, end, who in entry["periods"]
            )

        if kind == "posts":
            by_km: dict[float, list[tuple[float, float]]] = {}
            for post in data["posts"]:
                if open_in(post):
                    by_km.setdefault(float(data["tiers"][post["tier"]]), []).append(tuple(post["at"]))
            geoms = [self.sources.buffer(points, [], km) for km, points in sorted(by_km.items())]
        else:
            geoms = [
                self.sources.buffer(
                    [tuple(pt) for pt in belt.get("points", [])],
                    [tuple(pt) for pt in belt.get("line", [])],
                    belt["km"],
                )
                for belt in data["belts"]
                if open_in(belt)
            ]
        if not geoms:
            raise ValueError(f"no {kind} open for {power} in {year}")
        return shapely.union_all(geoms)

    def zone(self, area: shapely.Geometry) -> shapely.Geometry:
        """The land an area drawn through open water takes: the mainland cut by the area, plus every
        whole island whose representative point lies inside it. Islands are never split."""
        parts, points, mainland = self.sources.parts
        inside = points.query(area, predicate="contains")
        islands = [parts[i] for i in sorted(inside) if i != mainland]
        return shapely.union_all([shapely.intersection(parts[mainland], area), *islands])

    def piece(self, piece: Any) -> shapely.LineString:
        if not isinstance(piece, dict) or len(piece) != 1:
            raise ValueError(f"a ring piece is a one-key mapping, got {piece!r}")
        ((op, arg),) = piece.items()
        if op == "parallel":
            return p.parallel(*arg)
        if op == "meridian":
            return p.meridian(*arg)
        if op == "line":
            return p.line([tuple(pt) for pt in arg])
        if op == "border":
            start, end = arg.get("from"), arg.get("to")
            return p.modern_border(
                self.sources.modern[arg["a"]],
                self.sources.modern[arg["b"]],
                tuple(start) if start else None,
                tuple(end) if end else None,
            )
        if op == "river":
            reaches = [g for name in arg["names"] for g in self.sources.river_reaches[name]]
            return p.river(reaches, tuple(arg["from"]), tuple(arg["to"]), arg.get("bridge_km", 0.0))
        if op == "coast":
            return p.coast(self.sources.canada, tuple(arg["from"]), tuple(arg["to"]), arg["side"])
        if op == "shape":
            if arg not in self.shapes:
                raise ValueError(f"unknown shape {arg!r}")
            return self.piece(self.shapes[arg])
        raise ValueError(f"unknown ring piece {op!r}")


@cache
def load_defacto(path: Path) -> dict:
    """defacto.yaml, checked: every post has a known tier and every period a known power."""
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    for entry in [*data["posts"], *data["belts"]]:
        if "tier" in entry and entry["tier"] not in data["tiers"]:
            raise ValueError(f"{entry['id']}: unknown tier {entry['tier']!r}")
        for period in entry["periods"]:
            start, end, power = period
            if power not in POWERS or (end is not None and end <= start):
                raise ValueError(f"{entry['id']}: bad period {period}")
    ids = [entry["id"] for entry in [*data["posts"], *data["belts"]]]
    if len(ids) != len(set(ids)):
        raise ValueError("defacto.yaml: duplicate ids")
    return data


def rivers_needed(doc: dict) -> dict[str, list[str]]:
    """Canada1Water region → reach names, from every river piece in the document."""
    found: dict[str, list[str]] = {}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if "river" in node and isinstance(node["river"], dict):
                found.setdefault(node["river"]["region"], []).extend(node["river"]["names"])
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(doc)
    return {region: sorted(set(names)) for region, names in sorted(found.items())}


# ---- Events → unit rows ----------------------------------------------------------------------


@dataclass
class Row:
    id: str
    fields: dict[str, Any]
    valid_from: str
    valid_to: str | None
    geometry: shapely.Geometry
    boundary: str
    ref: str = ""
    nrcan: str = ""  # the polygon name on NRCan's map, for the checklist comparison
    # Reference drawings shipped for comparison: {id, name, source, geometry, note}.
    references: list[dict] = field(default_factory=list)


def change_kind(change: dict) -> tuple[str, str]:
    kinds = [k for k in CHANGE_KINDS if k in change]
    if len(kinds) != 1:
        raise ValueError(f"a change names exactly one of {CHANGE_KINDS}: {change}")
    return kinds[0], change[kinds[0]]


def resolve_events(doc: dict, sources: Sources) -> tuple[list[dict], list[Row]]:
    evaluator = Evaluator(sources, shapes=doc.get("shapes", {}))
    open_rows: dict[str, Row] = {}
    rows: list[Row] = []
    events_out: list[dict] = []
    previous_date = ""
    for event in doc["events"]:
        date = str(event["date"])
        if date < previous_date:
            raise ValueError(f"event {date} {event['title']!r} is out of order")
        previous_date = date
        unknown = set(event) - EVENT_KEYS
        if unknown:
            raise ValueError(f"event {date}: unknown keys {sorted(unknown)}")
        log(f"{date} {event['title']}")
        changes_out = []
        evaluator.before = dict(evaluator.current)
        for change in event["changes"]:
            kind, unit_id = change_kind(change)
            where = f"{date} {kind} {unit_id}"
            try:
                row = apply_change(kind, unit_id, change, date, open_rows, evaluator)
            except (ValueError, KeyError) as exc:
                raise ValueError(f"{where}: {exc}") from exc
            if row is not None:
                rows.append(row)
            changes_out.append({"unit": unit_id, "kind": kind})
        event_out = {"date": date, "title": event["title"], "note": " ".join(event["note"].split())}
        if "date_confidence" in event:
            event_out["dateConfidence"] = event["date_confidence"]
        events_out.append({**event_out, "changes": changes_out})
    return events_out, rows


def apply_change(
    kind: str, unit_id: str, change: dict, date: str, open_rows: dict[str, Row], evaluator: Evaluator
) -> Row | None:
    """Apply one change. Everything is checked and evaluated before state is touched, so a
    geometry may refer to the unit it replaces (`unit: <itself>`)."""
    unknown = set(change) - {kind, "geometry", "boundary", "clip", "nrcan", "nrcan_overlay", *UNIT_FIELDS}
    if unknown:
        raise ValueError(f"unknown keys {sorted(unknown)}")
    previous = open_rows.get(unit_id)
    if kind == "create":
        if previous is not None:
            raise ValueError("unit already exists")
        missing = [f for f in ("name", "status", "sovereign", "geometry", "boundary") if f not in change]
        if missing:
            raise ValueError(f"create needs {missing}")
        fields = {"capital": None, "truth": "dejure"}
    else:
        if previous is None:
            raise ValueError("unit does not exist")
        if previous.valid_from == date:
            raise ValueError("unit changed twice on one date; fold the changes into one")
        if kind == "dissolve" and set(change) != {kind}:
            raise ValueError("dissolve takes no other keys")
        if kind == "rename" and ("geometry" in change or "name" not in change):
            raise ValueError("rename changes the name and nothing about the boundary")
        if kind == "alter" and "geometry" in change and "boundary" not in change:
            raise ValueError("a new geometry needs its boundary description")
        fields = dict(previous.fields)
        # Per-row annotations do not carry forward unless restated.
        for annotation in ROW_ANNOTATIONS:
            fields.pop(annotation, None)
    fields.update({k: change[k] for k in UNIT_FIELDS if k in change})
    if kind == "dissolve":
        geometry, boundary = None, ""
    elif "geometry" in change:
        geometry = evaluator(change["geometry"], change.get("clip", "canada"))
        boundary = " ".join(change["boundary"].split())
    else:
        geometry = previous.geometry
        boundary = " ".join(change.get("boundary", previous.boundary).split())

    if previous is not None:
        previous.valid_to = date
        del open_rows[unit_id]
        del evaluator.current[unit_id]
    if geometry is None:
        return None
    nrcan = change.get("nrcan", previous.nrcan if previous is not None else fields["name"])
    row = Row(unit_id, fields, date, None, geometry, boundary, nrcan=nrcan)
    open_rows[unit_id] = row
    evaluator.current[unit_id] = geometry
    if "nrcan_overlay" in change:
        row.references = nrcan_references(row, change["nrcan_overlay"], evaluator)
    return row


def nrcan_references(row: Row, spec: dict, evaluator: Evaluator) -> list[dict]:
    """NRCan's drawing where the atlas departs from it: the named polygons of NRCan's map for
    `year`, each optionally clipped to an expression (evaluated after this change)."""
    if set(spec) - {"year", "polygons", "from", "until"} or not spec.get("polygons"):
        raise ValueError(
            "nrcan_overlay takes year, a non-empty polygons list, and optional from and until dates"
        )
    year = int(spec["year"])
    polygons = compare.nrcan_polygons_wgs84(year)
    refs = []
    for item in spec["polygons"]:
        if set(item) - {"name", "clip", "note"}:
            raise ValueError(f"nrcan_overlay polygon keys are name, clip and note: {item}")
        if item["name"] not in polygons:
            raise ValueError(f"NRCan {year} has no polygon named {item['name']!r}")
        geom = polygons[item["name"]]
        if "clip" in item:
            geom = p.polygonal(shapely.intersection(geom, evaluator.eval(item["clip"])))
            parts = [] if geom is None else list(getattr(geom, "geoms", [geom]))
            areas = [a.area / 1e6 for a in equal_area(parts)] if parts else []
            kept = [g for g, a in zip(parts, areas, strict=True) if a >= REFERENCE_MIN_PART_KM2]
            if not kept:
                raise ValueError(f"clipping NRCan {item['name']!r} leaves nothing")
            geom = shapely.union_all(kept)
        slug = re.sub(r"[^a-z0-9]+", "_", item["name"].lower()).strip("_")
        refs.append(
            {
                "id": f"nrcan_{row.id}_{year}_{slug}",
                "name": item["name"],
                "source": f"nrcan_te_{year}",
                "geometry": geom,
                "note": " ".join(item.get("note", "").split()),
                # The divergence can end before the row does (NRCan changes its drawing).
                "until": str(spec["until"]) if "until" in spec else None,
                # ... or start after it (a unit older than NRCan's first map, 1867).
                "from": str(spec["from"]) if "from" in spec else None,
            }
        )
    return refs


# ---- Validation ------------------------------------------------------------------------------


def equal_area(geoms: list[shapely.Geometry]) -> list[shapely.Geometry]:
    """Reproject to EPSG:3347 for areas. Long straight lon/lat edges (a parallel given by its two
    ends) are densified first, or they would project to chords; reprojection can fold a sliver,
    so repair afterwards."""
    dense = shapely.segmentize(np.asarray(geoms, dtype=object), PROJECT_SEGMENT_DEG)
    projected = gpd.GeoSeries(dense, crs=WGS84).to_crs(EQUAL_AREA_CRS).to_numpy()
    return list(shapely.make_valid(projected))


def active(rows: list[Row], date: str, truth: str = "dejure") -> list[Row]:
    return [
        r
        for r in rows
        if r.fields["truth"] == truth and r.valid_from <= date and (r.valid_to is None or date < r.valid_to)
    ]


def control_points(doc: dict, rows: list[Row]) -> list[tuple[dict, str | None]]:
    """The `checks:` in events.yaml: places whose unit on a date the instruments settle. Returns
    (check, problem or None)."""
    results = []
    for check_ in doc.get("checks", []):
        if set(check_) - {"date", "point", "unit", "source"} or not {
            "date",
            "point",
            "unit",
            "source",
        } <= set(check_):
            raise ValueError(f"a check has date, point, unit and source: {check_}")
        date, point = str(check_["date"]), shapely.Point(check_["point"])
        holders = [r.id for r in active(rows, date) if r.geometry.buffer(CHECK_TOLERANCE_DEG).covers(point)]
        problem = (
            None
            if check_["unit"] in holders
            else f"{date}: {check_['point']} is in {holders or 'no unit'}, not {check_['unit']}"
        )
        results.append(({**check_, "date": date}, problem))
    return results


def validate(events: list[dict], rows: list[Row], canada: shapely.Geometry) -> list[str]:
    problems = []
    for row in rows:
        if not row.geometry.is_valid or row.geometry.is_empty:
            problems.append(f"{row.id} {row.valid_from}: invalid or empty geometry")
    canada_km2 = equal_area([canada])[0].area / 1e6
    for date in sorted({e["date"] for e in events}):
        units = active(rows, date)
        projected = equal_area([r.geometry for r in units])
        tree = shapely.STRtree(projected)
        left, right = tree.query(projected, predicate="intersects")
        for i, j in zip(left, right, strict=True):
            if i < j:
                km2 = shapely.intersection(projected[i], projected[j]).area / 1e6
                if km2 > OVERLAP_TOLERANCE_KM2:
                    problems.append(f"{date}: {units[i].id} and {units[j].id} overlap by {km2:,.0f} km²")
        covered = shapely.union_all(projected).area / 1e6
        gap = abs(covered - canada_km2) / canada_km2
        if gap > COVERAGE_TOLERANCE:
            problems.append(
                f"{date}: de jure units cover {covered:,.0f} km² of {canada_km2:,.0f} km² ({gap:.2%} off)"
            )
    return problems


# ---- Output ----------------------------------------------------------------------------------


def assign_refs(rows: list[Row]) -> list[tuple[str, shapely.Geometry]]:
    """Give identical geometries one ref, named after the first row that uses it."""
    by_wkb: dict[bytes, str] = {}
    taken: set[str] = set()
    shapes: list[tuple[str, shapely.Geometry]] = []
    for row in rows:
        # Set operations leave extra vertices on shared edges (a coast cut by the drainage tiles
        # gains a vertex at every tile edge). Dropping collinear vertices gives every polygon the
        # same vertex sequence along a shared edge, which mapshaper needs to build shared arcs.
        geom = shapely.simplify(row.geometry, COLLINEAR_DEG)
        geom = shapely.normalize(shapely.set_precision(geom, GRID_DEG))
        key = shapely.to_wkb(geom)
        if key not in by_wkb:
            ref = f"{row.id}_{row.valid_from[:4]}"
            if ref in taken:
                ref = f"{row.id}_{row.valid_from.replace('-', '')}"
            taken.add(ref)
            by_wkb[key] = ref
            shapes.append((ref, geom))
        row.ref = by_wkb[key]
        row.geometry = geom
    for row in rows:
        for ref in row.references:
            geom = shapely.normalize(
                shapely.set_precision(shapely.simplify(ref["geometry"], COLLINEAR_DEG), GRID_DEG)
            )
            ref["geometry"] = geom
            shapes.append((ref["id"], geom))
    return shapes


def display_geometry(geom: shapely.Geometry) -> shapely.Geometry:
    """Drop polygon parts under MIN_PART_KM2 (thousands of Arctic islets) for the display copy."""
    parts = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
    areas = [a.area / 1e6 for a in equal_area(parts)]
    kept = [part for part, km2 in zip(parts, areas, strict=True) if km2 >= MIN_PART_KM2]
    if not kept:  # never drop a whole unit; keep its largest part
        kept = [parts[max(range(len(parts)), key=lambda i: areas[i])]]
    return shapely.MultiPolygon(kept) if len(kept) > 1 else kept[0]


def write_topology(shapes: list[tuple[str, shapely.Geometry]], out: Path) -> None:
    """One mapshaper topology for every shape, then one TopoJSON object per ref."""
    with tempfile.TemporaryDirectory(prefix="meridian-atlas-") as tmp:
        source = Path(tmp) / "atlas.geojson"
        gdf = gpd.GeoDataFrame(
            {"ref": [r for r, _ in shapes]}, geometry=[display_geometry(g) for _, g in shapes], crs=WGS84
        )
        gdf.to_file(source, driver="GeoJSON", COORDINATE_PRECISION=6)
        plain = Path(tmp) / "atlas.topojson"
        cmd = [
            *mapshaper_cmd(),
            "-i",
            str(source),
            "snap",
            "-simplify",
            "weighted",
            f"interval={SIMPLIFY_INTERVAL_M}",
        ]
        cmd += ["keep-shapes", "-o", str(plain), "format=topojson", "quantization=100000"]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"mapshaper failed:\n{result.stderr[-2000:]}")
        topo = json.loads(plain.read_text(encoding="utf-8"))
    (layer,) = topo["objects"].values()
    objects = {}
    for geometry in layer["geometries"]:
        ref = geometry.pop("properties")["ref"]
        objects[ref] = geometry
    topo["objects"] = dict(sorted(objects.items()))
    missing = {r for r, _ in shapes} - set(objects)
    if missing:
        raise RuntimeError(f"mapshaper dropped shapes: {sorted(missing)}")
    write_bytes(out, gzip_bytes(dumps(topo) + b"\n"))


def atlas_document(events: list[dict], rows: list[Row]) -> dict:
    units = []
    for row in sorted(rows, key=lambda r: (r.id, r.valid_from)):
        unit = {
            "id": row.id,
            "name": row.fields["name"],
            "status": row.fields["status"],
            "sovereign": row.fields["sovereign"],
            "capital": row.fields["capital"],
            "validFrom": row.valid_from,
            "validTo": row.valid_to,
            "truth": row.fields["truth"],
            "geometryRef": row.ref,
        }
        if row.fields.get("note"):
            unit["note"] = " ".join(row.fields["note"].split())
        if row.fields.get("confidence") is not None:
            unit["confidence"] = row.fields["confidence"]
        if row.fields.get("dispute"):
            unit["dispute"] = row.fields["dispute"]
        for key in ("instrument", "rationale"):
            if row.fields.get(key):
                unit[key] = " ".join(row.fields[key].split())
        units.append(unit)
    references = []
    for row in sorted(rows, key=lambda r: (r.id, r.valid_from)):
        for ref in row.references:
            entry = {
                "id": ref["id"],
                "name": ref["name"],
                "unit": row.id,
                "source": ref["source"],
                "attribution": NRCAN_ATTRIBUTION,
                "validFrom": max(d for d in (row.valid_from, ref["from"]) if d is not None),
                "validTo": min(d for d in (row.valid_to, ref["until"]) if d is not None)
                if row.valid_to or ref["until"]
                else None,
                "geometryRef": ref["id"],
            }
            if ref["note"]:
                entry["note"] = ref["note"]
            references.append(entry)
    doc = {"format": "meridian.atlas", "version": ATLAS_VERSION, "events": events, "units": units}
    if references:
        doc["references"] = references
    return doc


def band_ref(band: contact_frontier.Band) -> str:
    return f"contact_{band.from_year or 'start'}_{band.until_year or 'now'}"


def build_contact(sources: Sources, build_dir: Path = BUILD) -> dict:
    """The contact frontier as its own pair of artefacts (contact.v1.json + .topojson.gz).

    It is kept out of atlas.v1 on purpose: mapshaper snaps coincident points across everything in
    one topology, and a band's edge is not a boundary — it must not be allowed to move one.
    """
    doc = contact_frontier.load_contact()
    regions = contact_frontier.resolve(doc, Evaluator(sources=sources))
    bands = contact_frontier.bands(doc, regions)
    log(f"contact: {len(regions)} regions in {len(bands)} bands")
    write_topology(
        [(band_ref(b), b.geometry) for b in bands], build_dir / f"contact.{CONTACT_VERSION}.topojson.gz"
    )
    document = {
        "format": "meridian.contact",
        "version": CONTACT_VERSION,
        "caveat": doc["caveat"].strip(),
        "bands": [
            {
                "label": b.label,
                "fromYear": b.from_year,
                "untilYear": b.until_year,
                "geometryRef": band_ref(b),
            }
            for b in bands
        ],
        "regions": [
            {
                "id": r.id,
                "name": r.name,
                "year": r.year,
                "event": r.event,
                "confidence": r.confidence,
                "source": r.source,
                **({"note": " ".join(r.note.split())} if r.note else {}),
            }
            for r in regions
        ],
    }
    path = build_dir / f"contact.{CONTACT_VERSION}.json"
    write_bytes(path, json.dumps(document, ensure_ascii=False, indent=1).encode("utf-8") + b"\n")
    log(f"wrote {path} ({path.stat().st_size:,} bytes)")
    return document


def agreements(rows: list[Row]) -> dict[int, compare.Agreement | None]:
    """Per row (by id()), agreement with NRCan's map; empty when the maps are not downloaded."""
    if not compare.available():
        return {}
    projected = equal_area([r.geometry for r in rows])
    return {
        id(r): compare.agreement(g, r.nrcan, compare.comparison_date(r.valid_from, r.valid_to))
        for r, g in zip(rows, projected, strict=True)
    }


def checklist(events: list[dict], rows: list[Row], checks: list[tuple[dict, str | None]] = ()) -> str:
    """Markdown checklist of every polygon, for verification against the NRCan sheets."""
    areas = {id(r): g.area / 1e6 for r, g in zip(rows, equal_area([r.geometry for r in rows]), strict=True)}
    matches = agreements(rows)
    lines = [
        f"# Atlas checklist: every polygon, {events[0]['date'][:4]} to today",
        "",
        "Generated by `make atlas` from `pipeline/atlas/events.yaml`; do not edit by hand.",
        "Tick a box once the polygon matches the NRCan *Territorial Evolution of Canada* sheet for its",
        "date. Areas are in km² after clipping to modern Canada, before display simplification.",
        "Rows sharing a geometry ref are the same polygon, so one check covers them.",
        "",
        "Each polygon is also compared with NRCan's own polygon for that year (overlap = intersection",
        "over union). The comparison is a pointer, not the verdict: NRCan's maps are generalized, and",
        "where the atlas follows the legal text instead of NRCan's drawing the row says so. Before",
        "1867 there is no NRCan vector map at all, so the control points below take its place.",
        "",
    ]
    if matches:
        worst = sorted(
            (
                (m.iou, r)
                for r in rows
                if (m := matches.get(id(r))) is not None and m.iou is not None and m.iou < 0.95
            ),
            key=lambda pair: (pair[0], pair[1].valid_from, pair[1].id),
        )
        missing = [r for r in rows if (m := matches.get(id(r))) is not None and m.iou is None]
        lines += ["## Review first", ""]
        if not worst and not missing:
            lines.append("Every polygon overlaps its NRCan counterpart by 95% or more.")
        for iou, row in worst:
            lines.append(f"- {row.valid_from} **{row.fields['name']}**: {iou:.1%} overlap with NRCan")
        for row in missing:
            lines.append(f"- {row.valid_from} **{row.fields['name']}**: no NRCan polygon named “{row.nrcan}”")
        lines.append("")
    if checks:
        lines += [
            "## Control points",
            "",
            "Places whose unit on a date the instruments settle (`checks:` in events.yaml). They are",
            "the test for dates before 1867, which NRCan has no vector map for.",
            "",
        ]
        for check_, problem in checks:
            mark = "✗" if problem else "✓"
            lines.append(
                f"- {mark} {check_['date']}: {check_['point']} in `{check_['unit']}`. {check_['source']}"
            )
        lines.append("")
    seen: set[str] = set()
    for event in events:
        lines += [f"## {event['date']} — {event['title']}", "", event["note"], ""]
        if "dateConfidence" in event:
            lines += [
                f"Date confidence {event['dateConfidence']}: sources disagree; see the note.",
                "",
            ]
        if not event["changes"]:
            lines += ["No polygon changes on this date.", ""]
        for change in event["changes"]:
            match = [r for r in rows if r.id == change["unit"] and r.valid_from == event["date"]]
            if not match:
                lines.append(f"- {change['kind']}: `{change['unit']}` (no polygon)")
                continue
            row = match[0]
            shared = " — same polygon as before" if row.ref in seen else ""
            seen.add(row.ref)
            minx, miny, maxx, maxy = row.geometry.bounds
            lines.append(
                f"- [ ] {change['kind']}: **{row.fields['name']}** (`{row.ref}`, {row.fields['status']}, "
                f"{row.fields['truth']}){shared}  "
            )
            lines.append(
                f"  {row.boundary} Area {areas[id(row)]:,.0f} km²; extent {miny:.2f}°N to {maxy:.2f}°N, "
                f"{-maxx:.2f}°W to {-minx:.2f}°W."
                + (f" {compare.describe(matches[id(row)])}" if matches else "")
            )
            if row.fields.get("instrument"):
                lines.append(f"  *Instrument:* {' '.join(row.fields['instrument'].split())}")
            if row.fields.get("rationale"):
                confidence = row.fields.get("confidence")
                suffix = f" (confidence {confidence})" if confidence is not None else ""
                lines.append(f"  *Departs from NRCan:* {' '.join(row.fields['rationale'].split())}{suffix}")
            for ref in row.references:
                lines.append(f"  *NRCan overlay:* `{ref['id']}` ({ref['name']}, {ref['source']}).")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


class EventsLoader(yaml.SafeLoader):
    """YAML 1.1 reads ON (Ontario) as true; only true/false are booleans in events.yaml."""


EventsLoader.yaml_implicit_resolvers = {
    first: [(tag, regex) for tag, regex in resolvers if tag != "tag:yaml.org,2002:bool"]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
EventsLoader.add_implicit_resolver("tag:yaml.org,2002:bool", re.compile(r"^(?:true|false)$"), list("tf"))


def load_events(path: Path) -> dict:
    return yaml.load(path.read_text(encoding="utf-8"), Loader=EventsLoader)


def build(
    events_path: Path = EVENTS, build_dir: Path = BUILD, checklist_path: Path | None = CHECKLIST
) -> dict:
    doc = load_events(events_path)
    sources = Sources(rivers=rivers_needed(doc))
    events, rows = resolve_events(doc, sources)
    shapes = assign_refs(rows)
    log(f"{len(rows)} unit rows, {len(shapes)} distinct polygons")
    checks = control_points(doc, rows)
    problems = validate(events, rows, sources.canada) + [problem for _, problem in checks if problem]
    for problem in problems:
        log(f"✗ {problem}")
    if problems:
        raise SystemExit(f"atlas: {len(problems)} validation problem(s)")
    atlas_json = build_dir / f"atlas.{ATLAS_VERSION}.json"
    topology = build_dir / f"atlas.{ATLAS_VERSION}.topojson.gz"
    write_topology(shapes, topology)
    atlas = atlas_document(events, rows)
    write_bytes(atlas_json, json.dumps(atlas, ensure_ascii=False, indent=1).encode("utf-8") + b"\n")
    build_contact(sources, build_dir)
    if checklist_path is not None:
        write_bytes(checklist_path, checklist(events, rows, checks).encode("utf-8"))
    for path in (atlas_json, topology):
        log(f"wrote {path} ({path.stat().st_size:,} bytes)")
    return atlas


def check(events_path: Path = EVENTS) -> int:
    """Resolve and validate without writing, and print the NRCan comparison: for editing events.yaml."""
    doc = load_events(events_path)
    sources = Sources(rivers=rivers_needed(doc))
    events, rows = resolve_events(doc, sources)
    problems = validate(events, rows, sources.canada) + [p_ for _, p_ in control_points(doc, rows) if p_]
    matches = agreements(rows)
    for row in rows:
        print(f"{row.valid_from} {row.id:<32} {compare.describe(matches.get(id(row)))}")
    for problem in problems:
        print(f"✗ {problem}")
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="validate and compare with NRCan; write nothing")
    parser.add_argument("--events", type=Path, default=EVENTS)
    args = parser.parse_args(argv)
    if args.check:
        return check(args.events)
    # The checklist is a document, not an artefact: `make verify` rebuilds into a temporary
    # MERIDIAN_BUILD and leaves docs/ alone.
    build(args.events, checklist_path=CHECKLIST if BUILD == ROOT / "data" / "build" else None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
