"""Validate artefacts against the exported contracts in docs/schemas/.

    make validate

JSON Schema is the only thing both halves of Meridian read: the TypeScript contracts export it
(npm run schemas) and this module checks Python output against it with jsonschema. Invariants
that JSON Schema cannot express (sort order, column lengths) are mirrored from the Zod
.superRefine blocks in app/src/schema so a file that passes here also parses in the app.
"""

from __future__ import annotations

import gzip
import json
import sys
from functools import cache
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS = ROOT / "docs" / "schemas"
BUILD = ROOT / "data" / "build"
PLAN = ROOT / "pipeline" / "artefacts.yaml"
IGNORED = {".gitkeep", "SHA256SUMS"}


def load_document(path: Path) -> Any:
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


@cache
def validator(schema_file: str) -> Draft202012Validator:
    schema = json.loads((ROOT / schema_file).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def semantic_errors(doc: Any) -> list[str]:
    """Checks mirrored from the Zod .superRefine blocks, keyed by the file's format literal."""
    if not isinstance(doc, dict):
        return []
    errors: list[str] = []
    fmt = doc.get("format")
    if fmt == "meridian.mesh":
        cells = doc["cells"]
        n = len(cells)
        digit = format(doc["h3Resolution"], "x")
        for name, column in doc["columns"].items():
            if column["length"] != n:
                errors.append(f"columns.{name}: length {column['length']} ≠ {n} cells")
        for i, cell in enumerate(cells):
            if cell["id"][1] != digit:
                errors.append(f"cells[{i}].id: not at resolution {doc['h3Resolution']}")
            if i and not cells[i - 1]["id"] < cell["id"]:
                errors.append(f"cells[{i}].id: cells not strictly sorted by id")
            if any(j >= n or j == i for j in cell["neighbours"]):
                errors.append(f"cells[{i}].neighbours: index out of range or self")
    elif fmt == "meridian.attrs":
        count = doc["cellCount"]
        for name, column in doc["columns"].items():
            if column["length"] != count:
                errors.append(f"columns.{name}: length {column['length']} ≠ cellCount {count}")
        for name in doc.get("lookups", {}):
            if doc["columns"].get(name, {}).get("kind") != "id":
                errors.append(f"lookups.{name}: must name an id column")
        for name, table in doc.get("sideTables", {}).items():
            if table["offsets"]["length"] != count + 1:
                errors.append(f"sideTables.{name}.offsets: length must be cellCount + 1")
    elif fmt == "meridian.indigenous":
        codes = [f["code"] for f in doc["families"]]
        if len(codes) != len(set(codes)):
            errors.append("families: duplicate code")
        refs = [a["geometryRef"] for a in doc["areas"]]
        if len(refs) != len(set(refs)):
            errors.append("areas: duplicate geometryRef")
        errors += [f"areas: unknown family {a['family']}" for a in doc["areas"] if a["family"] not in codes]
        ids = [c["id"] for c in doc["communities"]]
        if any(b <= a for a, b in zip(ids, ids[1:], strict=False)):
            errors.append("communities: not strictly sorted by id")
    elif fmt == "meridian.regionPack":
        ids = [r["id"] for r in doc["regions"]]
        if len(ids) != len(set(ids)):
            errors.append("regions: duplicate region id")
    elif fmt == "meridian.unitTable":
        errors += unit_table_errors(doc)
    elif fmt == "meridian.atlas":
        dates = [e["date"] for e in doc["events"]]
        if dates != sorted(dates):
            errors.append("events: not sorted by date")
        for i, unit in enumerate(doc["units"]):
            if unit["validTo"] is not None and unit["validTo"] <= unit["validFrom"]:
                errors.append(f"units[{i}].validTo: must follow validFrom")
        for i, ref in enumerate(doc.get("references", [])):
            if ref["validTo"] is not None and ref["validTo"] <= ref["validFrom"]:
                errors.append(f"references[{i}].validTo: must follow validFrom")
    return errors


def unit_table_errors(doc: dict) -> list[str]:
    """app/src/schema/unitTable.ts's checkRows: sorted ids, symmetric ascending neighbours (of the same
    kind, for the hexagons; an h3_r5 row may list cells outside the table), lookup keys, places by
    population descending, contiguous jurisdiction spans from meta.jurisdictionsFrom to today, and
    each settled or city year the year of its source."""
    errors: list[str] = []
    outside = doc["unit"] == "h3_r5"
    rows = doc["rows"]
    nid = lambda n: n["id"] if isinstance(n, dict) else n  # noqa: E731
    ids = {r["id"] for r in rows}
    links = {r["id"]: {nid(n): n for n in r["neighbours"]} for r in rows}
    for i, row in enumerate(rows):
        at = f"rows[{i}]"
        if i and rows[i - 1]["id"] >= row["id"]:
            errors.append(f"{at}.id: rows not strictly sorted by id")
        for name in ("urbanClass", "industryDominant", "ecozone"):
            if name in row and str(row[name]) not in doc["lookups"][name]:
                errors.append(f"{at}.{name}: not in lookups")
        ns = [nid(n) for n in row["neighbours"]]
        if any(b <= a for a, b in zip(ns, ns[1:], strict=False)):
            errors.append(f"{at}.neighbours: not strictly ascending")
        for n in row["neighbours"]:
            k = nid(n)
            back = links.get(k, {}).get(row["id"])
            if k == row["id"] or (k not in ids and not outside):
                errors.append(f"{at}.neighbours: {k} is itself or not a row")
            elif k not in ids:
                continue
            elif back is None:
                errors.append(f"{at}.neighbours: {k} does not list {row['id']}")
            elif isinstance(n, dict) and back["kind"] != n["kind"]:
                errors.append(f"{at}.neighbours: {k} lists {row['id']} with another kind")
        order = [(-p["population"], p["csd"]) for p in row["places"]]
        if any(b <= a for a, b in zip(order, order[1:], strict=False)):
            errors.append(f"{at}.places: not sorted by population descending, then csd")
        for p in row["places"]:
            if "csdType" in p and p["csdType"] not in doc["lookups"]["csdType"]:
                errors.append(f"{at}.places: csdType {p['csdType']} not in lookups")
        for what in ("settled", "city"):
            if f"{what}Year" not in row:
                continue
            year, source = row[f"{what}Year"], row.get(f"{what}Source")
            if (year is None) != (source is None) or (source and int(source["date"][:4]) != year):
                errors.append(f"{at}.{what}Year: {what}Year and {what}Source disagree")
        spans = row["jurisdictions"]
        if spans[0]["from"] != doc["meta"]["jurisdictionsFrom"]:
            errors.append(f"{at}.jurisdictions[0]: must start at meta.jurisdictionsFrom")
        if spans[-1]["to"] is not None:
            errors.append(f"{at}.jurisdictions: the last span must run on (to: null)")
        for j, span in enumerate(spans):
            if span["to"] is not None and span["to"] <= span["from"]:
                errors.append(f"{at}.jurisdictions[{j}].to: must follow from")
            if j and spans[j - 1]["to"] != span["from"]:
                errors.append(f"{at}.jurisdictions[{j}].from: spans not contiguous")
    return errors


def validate_document(doc: Any, schema_file: str) -> list[str]:
    errors = [
        f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message[:300]}"
        for e in sorted(validator(schema_file).iter_errors(doc), key=lambda e: list(map(str, e.path)))
    ]
    # Semantic checks assume the structure is right, so only run them on schema-valid files.
    return errors or semantic_errors(doc)


def declared_outputs(plan_path: Path = PLAN) -> dict[str, str]:
    """data/build path → schema file, from pipeline/artefacts.yaml."""
    plan = yaml.safe_load(plan_path.read_text(encoding="utf-8"))
    return {out["path"]: out["schema"] for artefact in plan["artefacts"] for out in artefact["outputs"]}


def build_files(build: Path = BUILD) -> list[Path]:
    return sorted(p for p in build.rglob("*") if p.is_file() and p.name not in IGNORED)


def main() -> int:
    outputs = declared_outputs()
    files = build_files()
    failures = 0
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        if rel not in outputs:
            print(f"✗ {rel}: not declared in pipeline/artefacts.yaml")
            failures += 1
            continue
        errors = validate_document(load_document(path), outputs[rel])
        print(f"{'✗' if errors else '✓'} {rel} against {outputs[rel]}")
        for error in errors[:20]:
            print(f"    {error}")
        failures += bool(errors)
    print(f"{len(files)} artefact(s) checked, {failures} failed.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
