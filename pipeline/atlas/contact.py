"""The contact frontier: contact.yaml → a year for every mesh cell, and bands to draw.

contact.yaml lists areas with the year of the earliest documented direct European presence there.
A place takes the *earliest* year of every entry covering it, so entries compose in any order (see
the file's own header, which explains why a basin entry must carry its interior's latest date).

Nothing here decides what "contact" means; contact.yaml says, in its `caveat`, what these years do
and do not record, and that text travels with the data into the atlas file and onto the layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import numpy as np
import shapely
import yaml

CONTACT = Path(__file__).with_name("contact.yaml")


@dataclass(frozen=True)
class Region:
    """One entry of contact.yaml, with its geometry resolved."""

    id: str
    name: str
    year: int
    event: str
    confidence: float
    source: str
    geometry: shapely.Geometry
    note: str | None = None


@dataclass(frozen=True)
class Band:
    """A display class of the choropleth: every place whose year is in [from_year, until_year)."""

    label: str
    from_year: int | None
    until_year: int | None
    geometry: shapely.Geometry


def load_contact(path: Path = CONTACT) -> dict[str, Any]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    for key in ("caveat", "bands", "regions"):
        if key not in doc:
            raise ValueError(f"{path.name} has no {key!r}")
    seen: set[str] = set()
    for region in doc["regions"]:
        missing = {"id", "name", "year", "event", "where", "confidence", "source"} - set(region)
        if missing:
            raise ValueError(f"contact region {region.get('id')!r} is missing {sorted(missing)}")
        if region["id"] in seen:
            raise ValueError(f"duplicate contact region id {region['id']!r}")
        seen.add(region["id"])
    return doc


def resolve(doc: dict[str, Any], evaluate: Callable[[Any], shapely.Geometry]) -> list[Region]:
    """Evaluate every entry's `where` expression, in file order."""
    out = []
    for region in doc["regions"]:
        out.append(
            Region(
                id=region["id"],
                name=region["name"],
                year=int(region["year"]),
                event=region["event"],
                confidence=float(region["confidence"]),
                source=region["source"],
                note=region.get("note"),
                geometry=evaluate(region["where"]),
            )
        )
    return out


def cell_years(regions: list[Region], lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
    """The earliest covering entry's year for each point, or 0 where nothing covers it.

    The 25 drainage-basin entries partition Canada, so 0 only happens for a point outside the
    modern coastline (every geometry is clipped to it) — which callers should treat as "unknown",
    not as a year.
    """
    years = np.zeros(len(lons), dtype=np.int32)
    if not regions:
        return years
    points = shapely.points(lons, lats)
    tree = shapely.STRtree([r.geometry for r in regions])
    point_idx, region_idx = tree.query(points, predicate="intersects")
    region_years = np.array([r.year for r in regions], dtype=np.int32)
    covered = np.full(len(lons), np.iinfo(np.int32).max, dtype=np.int32)
    np.minimum.at(covered, point_idx, region_years[region_idx])
    found = covered != np.iinfo(np.int32).max
    years[found] = covered[found]
    return years


def bands(doc: dict[str, Any], regions: list[Region]) -> list[Band]:
    """The choropleth's classes: each band is the land its entries cover, less anything earlier.

    Subtracting the earlier bands is what makes the drawing agree with `cell_years`: a place
    covered by a 1610 coastal strip and a 1743 basin belongs to the 1600s, not to both.
    """
    out: list[Band] = []
    earlier: list[shapely.Geometry] = []
    for spec in doc["bands"]:
        start, until = spec["from"], spec["until"]
        inside = [
            r.geometry
            for r in regions
            if (start is None or r.year >= start) and (until is None or r.year < until)
        ]
        if not inside:
            continue
        geometry = shapely.union_all(inside)
        if earlier:
            geometry = shapely.difference(geometry, shapely.union_all(earlier))
        earlier.append(shapely.union_all(inside))
        if geometry.is_empty:
            continue
        out.append(Band(label=spec["label"], from_year=start, until_year=until, geometry=geometry))
    return out
