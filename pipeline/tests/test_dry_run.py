from pathlib import Path

import dry_run

HEADER = "| id | source | url | licence | attribution | refresh |\n|---|---|---|---|---|---|\n"


def write(tmp_path: Path, plan: str, rows: str) -> tuple[Path, Path]:
    plan_path = tmp_path / "artefacts.yaml"
    sources_path = tmp_path / "data-sources.md"
    plan_path.write_text(plan)
    sources_path.write_text("# Sources\n\n" + HEADER + rows)
    return plan_path, sources_path


PLAN = """
plan_version: 1
artefacts:
  - id: mesh
    phase: 1
    step: pipeline/mesh.py
    inputs: [statcan_pr_2021]
    outputs:
      - { path: data/build/mesh.v1.json.gz, schema: docs/schemas/mesh.schema.json }
"""


def test_repo_plan_is_valid():
    assert dry_run.run() == 0


def test_pending_source_details_are_not_errors(tmp_path, capsys):
    assert dry_run.run(*write(tmp_path, PLAN, "| `statcan_pr_2021` | StatCan provinces | | | | |\n")) == 0
    assert "pending url,licence,attribution,refresh" in capsys.readouterr().out


def test_unknown_source_is_an_error(tmp_path, capsys):
    assert dry_run.run(*write(tmp_path, PLAN, "| `other` | Other | | | | |\n")) == 1
    assert "has no row in docs/data-sources.md" in capsys.readouterr().err


def test_unversioned_output_is_an_error(tmp_path, capsys):
    plan = PLAN.replace("mesh.v1.json.gz", "mesh.json.gz")
    assert dry_run.run(*write(tmp_path, plan, "| `statcan_pr_2021` | StatCan | | | | |\n")) == 1
    assert "must carry a version" in capsys.readouterr().err


def test_invalid_or_empty_yaml_is_an_error(tmp_path):
    assert dry_run.run(*write(tmp_path, "artefacts: [unclosed", "| `x` | X | | | | |\n")) == 1
    assert dry_run.run(*write(tmp_path, "", "| `x` | X | | | | |\n")) == 1


def test_output_without_existing_schema_is_an_error(tmp_path, capsys):
    plan = PLAN.replace("docs/schemas/mesh.schema.json", "docs/schemas/nope.schema.json")
    assert dry_run.run(*write(tmp_path, plan, "| `statcan_pr_2021` | StatCan | | | | |\n")) == 1
    assert "does not exist" in capsys.readouterr().err


def test_bare_string_output_is_an_error(tmp_path, capsys):
    plan = PLAN.replace(
        "      - { path: data/build/mesh.v1.json.gz, schema: docs/schemas/mesh.schema.json }",
        "      - data/build/mesh.v1.json.gz",
    )
    assert dry_run.run(*write(tmp_path, plan, "| `statcan_pr_2021` | StatCan | | | | |\n")) == 1
    assert "must be {path, schema}" in capsys.readouterr().err
