"""The Python/TypeScript agreement test.

Every file in data/build/ must be declared in artefacts.yaml and pass its JSON Schema (exported
from the Zod contracts) plus the mirrored semantic checks. The shared examples in
docs/schemas/examples/ are validated the same way, and Vitest validates them with Zod, so both
halves are pinned to the same documents.
"""

import copy
import json

import pytest

import validate

EXAMPLES = validate.SCHEMAS / "examples"
EXAMPLE_SCHEMAS = {
    "mesh.example.json": "docs/schemas/mesh.schema.json",
    "attrs.example.json": "docs/schemas/attrs.schema.json",
    "atlas.example.json": "docs/schemas/atlas.schema.json",
    "regionPack.example.json": "docs/schemas/regionPack.schema.json",
    "topojson.example.json": "docs/schemas/topojson.schema.json",
}
BUILD_FILES = validate.build_files()


def example(name: str) -> dict:
    return json.loads((EXAMPLES / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("schema", sorted(p.name for p in validate.SCHEMAS.glob("*.schema.json")))
def test_exported_schemas_are_valid_2020_12(schema):
    validate.validator(f"docs/schemas/{schema}")


@pytest.mark.parametrize("name", sorted(EXAMPLE_SCHEMAS))
def test_examples_pass_their_schema(name):
    assert validate.validate_document(example(name), EXAMPLE_SCHEMAS[name]) == []


def test_every_example_is_covered():
    on_disk = {p.name for p in EXAMPLES.glob("*.example.json")}
    assert on_disk == set(EXAMPLE_SCHEMAS)


def test_every_build_artefact_is_declared_with_a_schema():
    declared = validate.declared_outputs()
    undeclared = [p.relative_to(validate.ROOT).as_posix() for p in BUILD_FILES]
    undeclared = [p for p in undeclared if p not in declared]
    assert undeclared == [], "add these to pipeline/artefacts.yaml with a schema"


@pytest.mark.parametrize("path", BUILD_FILES, ids=lambda p: p.relative_to(validate.ROOT).as_posix())
def test_build_artefact_matches_schema(path):
    rel = path.relative_to(validate.ROOT).as_posix()
    schema = validate.declared_outputs().get(rel)
    if schema is None:
        pytest.fail(f"{rel} is not declared in artefacts.yaml")
    assert validate.validate_document(validate.load_document(path), schema) == []


# --- The contract rules are really enforced by the exported JSON Schema ---------------------

MESH = "docs/schemas/mesh.schema.json"
ATTRS = "docs/schemas/attrs.schema.json"
PACK = "docs/schemas/regionPack.schema.json"


def test_cell_id_as_json_number_is_rejected():
    doc = example("mesh.example.json")
    doc["cells"][0]["id"] = int(doc["cells"][0]["id"], 16)
    assert validate.validate_document(doc, MESH)


def test_uppercase_cell_id_is_rejected():
    doc = example("mesh.example.json")
    doc["cells"][0]["id"] = doc["cells"][0]["id"].upper()
    assert validate.validate_document(doc, MESH)


def test_unsorted_cells_and_wrong_resolution_are_rejected():
    doc = example("mesh.example.json")
    doc["cells"].reverse()
    assert any("sorted" in e for e in validate.validate_document(doc, MESH))
    doc = example("mesh.example.json")
    doc["h3Resolution"] = 6
    assert any("resolution" in e for e in validate.validate_document(doc, MESH))


def test_missing_file_meta_byte_order_is_rejected():
    doc = example("mesh.example.json")
    del doc["meta"]["byteOrder"]
    assert validate.validate_document(doc, MESH)
    doc = example("regionPack.example.json")
    del doc["meta"]["byteOrder"]
    assert validate.validate_document(doc, PACK)


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(lambda c: c["population"].update(dtype="float32"), id="count-as-float32"),
        pytest.param(lambda c: c["french_share"].update(dtype="int32"), id="share-as-int32"),
        pytest.param(lambda c: c["gdp_estimate"].update(unit="cad"), id="money-not-millions-cad"),
        pytest.param(lambda c: c["gdp_estimate"].pop("unit"), id="money-without-unit"),
        pytest.param(lambda c: c["distance_to_capital_km"].pop("unit"), id="measure-without-unit"),
        pytest.param(lambda c: c["population"].update(byteOrder="be"), id="big-endian"),
        pytest.param(lambda c: c["population"].update(unit="people"), id="count-with-unit"),
        pytest.param(lambda c: c.update(totalPop=copy.deepcopy(c["population"])), id="camelCase-name"),
        pytest.param(lambda c: c.update(pop__2021=copy.deepcopy(c["population"])), id="double-underscore"),
    ],
)
def test_dtype_and_naming_rules_are_enforced(mutate):
    doc = example("attrs.example.json")
    mutate(doc["columns"])
    assert validate.validate_document(doc, ATTRS)


def test_column_length_mismatch_is_rejected():
    doc = example("attrs.example.json")
    doc["cellCount"] = 8
    assert any("cellCount" in e for e in validate.validate_document(doc, ATTRS))
