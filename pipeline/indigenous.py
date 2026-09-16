"""Indigenous language families per mesh cell, and the pre-contact base layer drawn from them.

This replaces the Native Land Digital layer, which was declined (docs/decisions.md, 2026-09-16).

The column `indigenous_language_family` (id; codes and labels in atlas/language_families.yaml):

1. Census. Each CSD's single-response mother-tongue speakers of the 70 Indigenous languages are
   summed by family (statcan_profile_csd_indigenous_languages_2021). A CSD's speakers are spread over
   its cells with the same weights as its labour force (population share, or area share where the
   CSD has no people in the mesh), and each cell takes the family with the most speakers; ties go to
   the lower family code. Cells with no speakers stay unassigned. Confidence 0.7.
2. Glottolog. Every Glottolog 5.3 language located in Canada (`CA` among its countries), extinct
   and dormant ones included, with coordinates and a family in the lookup, is a seed at the mesh
   cell holding its point. Unassigned cells take the family of the nearest seed by shortest path
   over the mesh's neighbour graph, edges weighted by great-circle distance between cell centres.
   Confidence 0.3.

The mesh graph has no edges across salt water, so the Arctic islands, Newfoundland, Vancouver
Island and the rest are separate components, and most have no Glottolog point of their own. The
fill joins them with sea crossings: each component is linked to its nearest other component by
its closest pair of cell centres (Borůvka, ties by cell index), weighted like any other edge. So a
Baffin Island cell is filled from the nearest language across Hudson Strait if there is none on the
island, and the distance says so.

Community labels come from Wikidata (see atlas/indigenous_communities.rq for what is selected and
why). They are a label layer, and a CSR side table in attrs (`indigenous_community_ids`, Wikidata
item numbers per cell).
"""

from __future__ import annotations

import csv
import heapq
import io
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import yaml

FAMILIES_PATH = Path(__file__).parent / "atlas" / "language_families.yaml"
CENSUS_SOURCE = "statcan_profile_csd_indigenous_languages_2021"
CENSUS_CONFIDENCE = 0.7
GLOTTOLOG_CONFIDENCE = 0.3
# A Glottolog point further than this from every mesh cell centre is not a place in Canada's mesh
# (a language listed for Canada but located in its US homeland, say) and seeds nothing.
MAX_SEED_OFFSET_KM = 100.0
EARTH_RADIUS_KM = 6371.0088
CENSUS_RANGE = range(386, 476)  # characteristic 385's subtree: 386-475
WIKIDATA_POINT = re.compile(r"^Point\(\s*(-?[\d.]+(?:[eE]-?\d+)?)\s+(-?[\d.]+(?:[eE]-?\d+)?)\s*\)$")
WIKIDATA_ITEM = re.compile(r"^http://www\.wikidata\.org/entity/Q(\d+)$")
PEOPLES = ("first_nation", "inuit", "metis")


@dataclass(frozen=True)
class Seed:
    """A Glottolog language as a fill seed."""

    glottocode: str
    name: str
    family: int
    lat: float
    lng: float


@dataclass(frozen=True)
class Community:
    id: int
    name: str
    people: str
    lng: float
    lat: float


# --- the lookup -----------------------------------------------------------------------------


def load_families(path: Path = FAMILIES_PATH) -> dict[str, Any]:
    """language_families.yaml, checked: every census id 386-475 exactly once, every language's
    family in `families`, codes unique and positive."""
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    for key in ("caveat", "families", "glottolog_excluded_families", "languages", "groups", "residuals"):
        if key not in doc:
            raise ValueError(f"{path.name} has no {key!r}")
    codes = [f["code"] for f in doc["families"]]
    if len(codes) != len(set(codes)) or min(codes) < 1:
        raise ValueError("family codes must be unique and >= 1")
    by_glottocode = {f["glottocode"]: f for f in doc["families"]}
    if len(by_glottocode) != len(doc["families"]):
        raise ValueError("duplicate family glottocode")
    census = [row["census"] for key in ("languages", "groups", "residuals") for row in doc[key]]
    if sorted(census) != list(CENSUS_RANGE):
        missing = sorted(set(CENSUS_RANGE) - set(census))
        repeated = sorted({c for c in census if census.count(c) > 1})
        extra = sorted(set(census) - set(CENSUS_RANGE))
        raise ValueError(f"census ids 386-475: missing {missing}, repeated {repeated}, outside {extra}")
    for language in doc["languages"]:
        for key in ("census", "name", "glottocode", "family", "source"):
            if not language.get(key):
                raise ValueError(f"census language {language.get('census')} has no {key!r}")
        if language["family"] not in by_glottocode:
            raise ValueError(
                f"census language {language['census']} names unknown family {language['family']}"
            )
    return doc


def family_labels(doc: dict[str, Any]) -> dict[str, str]:
    return {"0": "unassigned"} | {str(f["code"]): f["label"] for f in doc["families"]}


def census_characteristics(doc: dict[str, Any]) -> list[int]:
    """The characteristic ids fetched: the languages, not the subtotals or residuals."""
    return sorted(language["census"] for language in doc["languages"])


# --- census ---------------------------------------------------------------------------------


def family_speakers(profile: pd.DataFrame, doc: dict[str, Any]) -> pd.DataFrame:
    """CSD × family code: single-response mother-tongue speakers. `profile` is the wide table from
    census.load_profile (index CSD, columns characteristic ids, NaN where suppressed → 0)."""
    code_of = {f["glottocode"]: f["code"] for f in doc["families"]}
    columns = sorted(code_of.values())
    out = pd.DataFrame(0.0, index=profile.index, columns=columns)
    for language in doc["languages"]:
        if language["census"] in profile.columns:
            out[code_of[language["family"]]] += profile[language["census"]].fillna(0).clip(lower=0)
    return out


def cell_speakers(
    speakers: pd.DataFrame, cell_from_csd: dict[str, tuple[np.ndarray, np.ndarray]], n: int
) -> tuple[np.ndarray, list[int]]:
    """(n × families) speakers per cell. cell_from_csd: csd → (cell indices, weights summing to 1)."""
    families = list(speakers.columns)
    out = np.zeros((n, len(families)))
    for csd, row in speakers.sort_index().iterrows():
        if csd not in cell_from_csd or row.sum() <= 0:
            continue
        cells, weights = cell_from_csd[csd]
        np.add.at(out, cells, np.outer(weights, row.to_numpy()))
    return out, families


def dominant_family(counts: np.ndarray, families: list[int]) -> np.ndarray:
    """The family with the most speakers in each row, 0 where there are none. np.argmax takes the
    first maximum, and `families` is sorted, so a tie goes to the lower code."""
    if list(families) != sorted(families):
        raise ValueError("families must be sorted")
    out = np.zeros(len(counts), dtype=np.int64)
    spoken = counts.sum(axis=1) > 0
    out[spoken] = np.asarray(families)[np.argmax(counts[spoken], axis=1)]
    return out


# --- Glottolog ------------------------------------------------------------------------------


def read_glottolog(path: Path) -> list[dict[str, str]]:
    with zipfile.ZipFile(path) as zf:
        member = next(m for m in zf.namelist() if m.endswith("languoid.csv"))
        return list(csv.DictReader(io.TextIOWrapper(zf.open(member), encoding="utf-8")))


def top_family(row: dict[str, str]) -> str:
    """A languoid's top-level family; an isolate is its own."""
    return row["family_id"] or row["id"]


def glottolog_seeds(rows: list[dict[str, str]], doc: dict[str, Any]) -> list[Seed]:
    """Languages located in Canada, with coordinates, in an Indigenous family of the lookup, sorted
    by glottocode. A family in neither list stops the build: a new Glottolog release has
    reclassified something, and someone has to decide."""
    code_of = {f["glottocode"]: f["code"] for f in doc["families"]}
    excluded = {f["glottocode"] for f in doc["glottolog_excluded_families"]}
    seeds = []
    for row in rows:
        if row["level"] != "language" or "CA" not in row["country_ids"].split():
            continue
        family = top_family(row)
        if family in excluded:
            continue
        if family not in code_of:
            raise ValueError(
                f"Glottolog language {row['id']} ({row['name']}) is in family {family}, which "
                "language_families.yaml neither maps nor excludes"
            )
        if not row["latitude"] or not row["longitude"]:
            continue
        seeds.append(
            Seed(row["id"], row["name"], code_of[family], float(row["latitude"]), float(row["longitude"]))
        )
    return sorted(seeds, key=lambda s: s.glottocode)


def check_census_mapping(rows: list[dict[str, str]], doc: dict[str, Any]) -> list[str]:
    """Every census language's glottocode exists and sits in the family the lookup names."""
    by_id = {row["id"]: row for row in rows}
    problems = []
    for language in doc["languages"]:
        row = by_id.get(language["glottocode"])
        if row is None:
            problems.append(
                f"census {language['census']}: glottocode {language['glottocode']} not in Glottolog"
            )
        elif top_family(row) != language["family"]:
            problems.append(
                f"census {language['census']}: {language['glottocode']} is in {top_family(row)}, "
                f"not {language['family']}"
            )
    return problems


# --- the fill -------------------------------------------------------------------------------


def unit_vectors(lats: np.ndarray, lngs: np.ndarray) -> np.ndarray:
    lat, lng = np.radians(lats), np.radians(lngs)
    return np.column_stack([np.cos(lat) * np.cos(lng), np.cos(lat) * np.sin(lng), np.sin(lat)])


def chord_to_km(chord: np.ndarray | float) -> np.ndarray | float:
    return 2 * EARTH_RADIUS_KM * np.arcsin(np.clip(np.asarray(chord) / 2, 0, 1))


def components(neighbours: list[list[int]]) -> np.ndarray:
    """Connected component of each cell, numbered in order of the lowest cell index."""
    n = len(neighbours)
    label = np.full(n, -1, dtype=np.int64)
    count = 0
    for start in range(n):
        if label[start] >= 0:
            continue
        label[start] = count
        stack = [start]
        while stack:
            u = stack.pop()
            for v in neighbours[u]:
                if label[v] < 0:
                    label[v] = count
                    stack.append(v)
        count += 1
    return label


def sea_crossings(
    neighbours: list[list[int]], xyz: np.ndarray, chunk: int = 256
) -> list[tuple[int, int, float]]:
    """Edges (i, j, km) that join every component of the neighbour graph into one (Borůvka).

    Each round links every component to its nearest other component by the closest pair of cell
    centres; ties break by (distance, lower cell index, higher cell index), so the result does not
    depend on iteration order.
    """
    label = components(neighbours)
    parent = list(range(int(label.max()) + 1 if len(label) else 0))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    edges: list[tuple[int, int, float]] = []
    while len({find(c) for c in range(len(parent))}) > 1:
        group = np.array([find(int(c)) for c in label])
        best: dict[int, tuple[float, int, int]] = {}
        for start in range(0, len(xyz), chunk):
            block = xyz[start : start + chunk]
            # |a - b|² = 2 - 2 a·b for unit vectors; chunked so the matrix stays near 80 MB.
            chord = np.sqrt(np.clip(2.0 - 2.0 * (block @ xyz.T), 0.0, None))
            chord[group[start : start + chunk, None] == group[None, :]] = np.inf
            nearest = np.argmin(chord, axis=1)
            for offset, j in enumerate(nearest):
                i, j = start + offset, int(j)
                d = float(chord[offset, j])
                if not np.isfinite(d):
                    continue
                key = (d, min(i, j), max(i, j))
                g = int(group[i])
                if g not in best or key < best[g]:
                    best[g] = key
        for d, i, j in sorted(best.values()):
            a, b = find(int(label[i])), find(int(label[j]))
            if a == b:
                continue
            parent[max(a, b)] = min(a, b)
            edges.append((i, j, float(chord_to_km(d))))
    return edges


def graph_fill(
    neighbours: list[list[int]],
    xyz: np.ndarray,
    seeds: list[tuple[int, float, str, int]],
    extra_edges: list[tuple[int, int, float]] = (),
) -> tuple[np.ndarray, np.ndarray]:
    """Multi-source Dijkstra. seeds: (cell, km from the point to the cell centre, glottocode,
    family). Returns (family, km) per cell, 0 and inf where nothing is reachable. A cell reached at
    the same distance by two seeds takes the lower glottocode."""
    n = len(neighbours)
    adjacency: list[list[tuple[int, float]]] = [[] for _ in range(n)]
    for u, vs in enumerate(neighbours):
        for v in vs:
            adjacency[u].append((v, float(chord_to_km(np.linalg.norm(xyz[u] - xyz[v])))))
    for u, v, km in extra_edges:
        adjacency[u].append((v, km))
        adjacency[v].append((u, km))

    family = np.zeros(n, dtype=np.int64)
    distance = np.full(n, np.inf)
    done = np.zeros(n, dtype=bool)
    heap = [(km, glottocode, cell, fam) for cell, km, glottocode, fam in seeds]
    heapq.heapify(heap)
    while heap:
        km, glottocode, cell, fam = heapq.heappop(heap)
        if done[cell]:
            continue
        done[cell], family[cell], distance[cell] = True, fam, km
        for v, w in adjacency[cell]:
            if not done[v] and km + w <= distance[v]:
                distance[v] = km + w
                heapq.heappush(heap, (km + w, glottocode, v, fam))
    return family, distance


def seed_cells(
    seeds: list[Seed], xyz: np.ndarray, cell_of: dict[str, int], resolution: int
) -> tuple[list[tuple[int, float, str, int]], list[Seed]]:
    """Each seed's cell: the mesh cell holding its point, else the nearest cell centre within
    MAX_SEED_OFFSET_KM. Returns (seeds for graph_fill, seeds dropped as outside the mesh)."""
    import h3

    placed, dropped = [], []
    for seed in seeds:
        point = unit_vectors(np.array([seed.lat]), np.array([seed.lng]))[0]
        chord = np.linalg.norm(xyz - point, axis=1)
        cell = cell_of.get(h3.latlng_to_cell(seed.lat, seed.lng, resolution))
        if cell is None:
            cell = int(np.argmin(chord))
        km = float(chord_to_km(chord[cell]))
        if km > MAX_SEED_OFFSET_KM:
            dropped.append(seed)
            continue
        placed.append((cell, km, seed.glottocode, seed.family))
    return placed, dropped


def family_column(
    census_family: np.ndarray,
    neighbours: list[list[int]],
    lats: np.ndarray,
    lngs: np.ndarray,
    seeds: list[tuple[int, float, str, int]],
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """Census families first; the Glottolog fill for cells the census left unassigned. Returns
    (family, confidence, stats)."""
    xyz = unit_vectors(lats, lngs)
    crossings = sea_crossings(neighbours, xyz)
    filled, km = graph_fill(neighbours, xyz, seeds, crossings)
    from_census = census_family > 0
    family = np.where(from_census, census_family, filled)
    confidence = np.where(from_census, CENSUS_CONFIDENCE, np.where(filled > 0, GLOTTOLOG_CONFIDENCE, 0.0))
    stats = {
        "census_cells": int(from_census.sum()),
        "glottolog_cells": int((~from_census & (filled > 0)).sum()),
        "unassigned_cells": int((family == 0).sum()),
        "sea_crossings": len(crossings),
        "longest_crossing_km": max((e[2] for e in crossings), default=0.0),
        "median_fill_km": float(np.median(km[~from_census & np.isfinite(km)]))
        if (~from_census).any()
        else 0.0,
    }
    return family, confidence, stats


# --- Wikidata -------------------------------------------------------------------------------


def read_communities(path: Path) -> tuple[list[Community], int]:
    """Rows of the recorded query, one per item: the first by (item, people, point) wins. Rows with
    no English label are skipped (a label layer cannot draw them). Returns (communities sorted by
    id, rows skipped for lack of a name)."""
    with open(path, encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    parsed = []
    unnamed = 0
    for row in rows:
        item = WIKIDATA_ITEM.match(row["item"])
        point = WIKIDATA_POINT.match(row["point"])
        if not item or not point or row["people"] not in PEOPLES:
            raise ValueError(f"unexpected Wikidata row {row}")
        if not row["name"].strip():
            unnamed += 1
            continue
        parsed.append(
            (int(item.group(1)), row["people"], float(point.group(1)), float(point.group(2)), row["name"])
        )
    seen: dict[int, Community] = {}
    for qid, people, lng, lat, name in sorted(parsed):
        if qid not in seen:
            seen[qid] = Community(qid, name.strip(), people, round(lng, 5), round(lat, 5))
    return [seen[q] for q in sorted(seen)], unnamed


def community_side_table(
    communities: list[Community], cells: list[int], n: int
) -> tuple[np.ndarray, np.ndarray]:
    """CSR offsets (n + 1) and values: the Wikidata ids of the communities in each cell, ascending.
    `cells[k]` is the mesh cell of `communities[k]`."""
    per_cell: list[list[int]] = [[] for _ in range(n)]
    for community, cell in zip(communities, cells, strict=True):
        per_cell[cell].append(community.id)
    offsets = np.zeros(n + 1, dtype=np.int64)
    values: list[int] = []
    for i, ids in enumerate(per_cell):
        values.extend(sorted(ids))
        offsets[i + 1] = len(values)
    return offsets, np.array(values, dtype=np.int64)
