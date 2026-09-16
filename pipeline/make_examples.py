"""Write the contract examples in docs/schemas/examples/.

    make examples

The examples are shared fixtures: pytest validates them with jsonschema against
docs/schemas/*.json, and Vitest validates them with the Zod contracts and decodes the columns
this Python writer encoded. If either side drifts, one of the two suites fails.

Values are illustrative (real H3 cells around Edmonton, made-up attributes); they are not
ground truth.
"""

from __future__ import annotations

import json
from pathlib import Path

import h3

from columns import MONEY_UNIT, encode_column, file_meta

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "schemas" / "examples"
EDMONTON = (53.5461, -113.4938)
RESOLUTION = 5


def write(name: str, doc: object) -> None:
    path = OUT / name
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(ROOT)}")


def mesh_example() -> dict:
    ids = sorted(h3.grid_disk(h3.latlng_to_cell(*EDMONTON, RESOLUTION), 1))
    index = {cell: i for i, cell in enumerate(ids)}
    cells = []
    for cell in ids:
        lat, lng = h3.cell_to_latlng(cell)
        neighbours = sorted(index[n] for n in h3.grid_ring(cell, 1) if n in index)
        cells.append(
            {
                "id": cell,
                "centroid": [round(lng, 6), round(lat, 6)],
                "area": round(h3.cell_area(cell, unit="km^2"), 3),
                "province": "AB",
                "cd": "4811",
                "csd": "4811061",
                "neighbours": neighbours,
            }
        )
    return {
        "format": "meridian.mesh",
        "version": "v1",
        "h3Resolution": RESOLUTION,
        "meta": file_meta(source="make_examples.py"),
        "cells": cells,
        "columns": {},
    }


def attrs_example(cell_count: int) -> dict:
    return {
        "format": "meridian.attrs",
        "version": "v1",
        "meshVersion": "v1",
        "cellCount": cell_count,
        "meta": file_meta(gdp_method="allocation_v1", census_year=2021),
        "columns": {
            "population": encode_column([412000, 58000, 91000, 120500, 33000, 77000, 1500], "count"),
            "french_share": encode_column([0.021, 0.018, 0.025, 0.02, 0.012, 0.03, 0.0], "share"),
            "gdp_estimate": encode_column(
                [31250.5, 4100.25, 6800.0, 9050.75, 2200.5, 5600.0, 90.125],
                "money",
                unit=MONEY_UNIT,
                method="allocation_v1",
                confidence=0.6,
            ),
            "distance_to_capital_km": encode_column(
                [0.0, 21.5, 20.8, 22.1, 21.9, 20.6, 22.4], "measure", unit="km"
            ),
            "urban_class": encode_column([3, 3, 3, 3, 2, 3, 1], "id"),
        },
        "lookups": {"urban_class": {"0": "remote", "1": "rural", "2": "small urban", "3": "CMA"}},
        "sideTables": {
            "indigenous_community_ids": {
                "offsets": encode_column([0, 0, 0, 0, 1, 1, 1, 2], "id"),
                "values": encode_column([123033, 55624], "id"),
            }
        },
    }


def region_pack_example(cell_count: int) -> dict:
    assignment = [0, 0, 1, 1, 0, 1, -1][:cell_count]
    return {
        "format": "meridian.regionPack",
        "version": 1,
        "meta": {
            "seed": 42,
            "method": "balanced",
            "params": {"n": 2},
            "meshVersion": "v1",
            "scope": {"kind": "province", "province": "AB"},
            "date": None,
            "byteOrder": "le",
        },
        "assignment": encode_column(assignment, "id"),
        "regions": [
            {"id": 0, "name": "North", "capital": "Edmonton", "stats": {"population": 503000}, "dossier": {}},
            {"id": 1, "name": "South", "capital": "Calgary", "stats": {"population": 288500}, "dossier": {}},
        ],
        "setAnalysis": {},
    }


def atlas_example() -> dict:
    return {
        "format": "meridian.atlas",
        "version": "v1",
        "events": [
            {
                "date": "1905-09-01",
                "title": "Alberta and Saskatchewan",
                "note": (
                    "Two provinces are carved from the North-West Territories. Their northern limit is 60°N."
                ),
                "changes": [{"unit": "alberta", "kind": "create"}],
            },
            {
                "date": "1927-03-01",
                "title": "The Labrador boundary",
                "note": "The Privy Council reports on 1 March 1927; the approving order is of 11 March.",
                "dateConfidence": 0.8,
                "changes": [],
            },
        ],
        "units": [
            {
                "id": "alberta",
                "name": "Alberta",
                "status": "province",
                "sovereign": "Canada",
                "capital": "Edmonton",
                "validFrom": "1905-09-01",
                "validTo": None,
                "truth": "dejure",
                "geometryRef": "alberta_1905",
                "instrument": "Alberta Act, 4–5 Edw. VII, c. 3, s. 1 (in force 1 September 1905)",
            }
        ],
        "references": [
            {
                "id": "nrcan_alberta_1905",
                "name": "Alberta",
                "unit": "alberta",
                "source": "nrcan_te_1905",
                "attribution": "Contains information licensed under the Open Government Licence – Canada.",
                "validFrom": "1905-09-01",
                "validTo": None,
                "geometryRef": "nrcan_alberta_1905",
            }
        ],
    }


def topology_example() -> dict:
    return {
        "type": "Topology",
        "transform": {"scale": [0.001, 0.001], "translate": [-120.0, 49.0]},
        "objects": {
            "provinces": {
                "type": "GeometryCollection",
                "geometries": [{"type": "Polygon", "arcs": [[0]], "properties": {"code": "AB"}}],
            }
        },
        "arcs": [[[0, 0], [10000, 0], [0, 11000], [-10000, 0], [0, -11000]]],
    }


def column_vectors() -> dict:
    """Values whose bytes differ between little- and big-endian, for both test suites."""
    cases = [
        ("int32 0x01020304", [0x01020304, -2, 2147483647, -2147483648], "id"),
        ("float32 dyadic", [1.0, -2.5, 3.140625, 65504.0], "index"),
    ]
    return {
        "vectors": [
            {"name": name, "kind": kind, "values": values, "column": encode_column(values, kind)}
            for name, values, kind in cases
        ]
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    mesh = mesh_example()
    write("mesh.example.json", mesh)
    write("attrs.example.json", attrs_example(len(mesh["cells"])))
    write("regionPack.example.json", region_pack_example(len(mesh["cells"])))
    write("atlas.example.json", atlas_example())
    write("topojson.example.json", topology_example())
    write("column-vectors.json", column_vectors())


if __name__ == "__main__":
    main()
