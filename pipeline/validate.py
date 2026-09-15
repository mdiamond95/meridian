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
    elif fmt == "meridian.regionPack":
        ids = [r["id"] for r in doc["regions"]]
        if len(ids) != len(set(ids)):
            errors.append("regions: duplicate region id")
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
