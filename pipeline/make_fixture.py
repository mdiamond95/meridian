"""Write the 50-cell loader fixture for app/src/data/loadMesh.test.ts from the built artefacts.

    make fixture

Takes the 50 mesh cells nearest to Edmonton's legislature (by H3 grid distance, then id), re-indexes
neighbours within that subset, and slices every attribute column to match.
"""

from __future__ import annotations

import gzip
import json
import sys

import h3

from columns import decode_column, encode_column
from common import BUILD, MESH_VERSION, ROOT, write_json_gz

OUT = ROOT / "app" / "src" / "data" / "fixtures"
SIZE = 50
CENTRE = (53.5335, -113.5064)


def load(name: str) -> dict:
    with gzip.open(BUILD / name, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def reencode(column: dict, positions: list[int]) -> dict:
    values = decode_column(column)[positions]
    extra = {k: column[k] for k in ("unit", "method", "confidence") if k in column}
    return encode_column(values, column["kind"], **extra)


def main() -> int:
    mesh = load(f"mesh.{MESH_VERSION}.json.gz")
    attrs = load(f"attrs.{MESH_VERSION}.json.gz")
    index = {c["id"]: i for i, c in enumerate(mesh["cells"])}
    centre = h3.latlng_to_cell(*CENTRE, mesh["h3Resolution"])
    ranked: list[str] = []
    k = 0
    while len(ranked) < SIZE:  # ring by ring outward from the centre, ids ascending within a ring
        ring = [centre] if k == 0 else h3.grid_ring(centre, k)
        ranked.extend(sorted(c for c in ring if c in index))
        k += 1
    chosen = sorted(ranked[:SIZE])
    positions = [index[c] for c in chosen]
    new_index = {old: new for new, old in enumerate(positions)}

    cells = []
    for old in positions:
        cell = dict(mesh["cells"][old])
        cell["neighbours"] = sorted(new_index[j] for j in cell["neighbours"] if j in new_index)
        cells.append(cell)
    mesh_fixture = {
        **mesh,
        "cells": cells,
        "columns": {k: reencode(v, positions) for k, v in mesh["columns"].items()},
    }
    attrs_fixture = {
        **attrs,
        "cellCount": SIZE,
        "columns": {k: reencode(v, positions) for k, v in attrs["columns"].items()},
    }
    attrs_fixture.pop("sideTables", None)
    OUT.mkdir(parents=True, exist_ok=True)
    write_json_gz(OUT / f"mesh.fixture.{MESH_VERSION}.json.gz", mesh_fixture)
    write_json_gz(OUT / f"attrs.fixture.{MESH_VERSION}.json.gz", attrs_fixture)
    print(f"wrote {SIZE}-cell fixtures to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
