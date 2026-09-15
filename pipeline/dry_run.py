"""Validate the artefact plan and print it, without downloading or building anything.

    make dry-run

Checks pipeline/artefacts.yaml against the repo rules and cross-references every input
against the source table in docs/data-sources.md. Exits 1 on any error. Sources whose
URL or licence is still blank are reported as pending, not errors: Phase 1 fills them.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PLAN_PATH = ROOT / "pipeline" / "artefacts.yaml"
SOURCES_PATH = ROOT / "docs" / "data-sources.md"

ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
VERSIONED_RE = re.compile(r"\.v\d+\.")
SOURCE_COLUMNS = ["id", "source", "url", "licence", "attribution", "refresh"]
PERMISSION_VALUES = {"pending", "granted", "refused"}


@dataclass
class Source:
    id: str
    name: str
    url: str
    licence: str
    attribution: str
    refresh: str

    @property
    def pending(self) -> list[str]:
        return [c for c in ("url", "licence", "attribution", "refresh") if not getattr(self, c)]


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)

    def error(self, message: str) -> None:
        self.errors.append(message)


def parse_sources(markdown: str, report: Report) -> dict[str, Source]:
    """Read the first table whose header starts with `id` from docs/data-sources.md."""
    sources: dict[str, Source] = {}
    in_table = False
    for line in markdown.splitlines():
        if not line.startswith("|"):
            in_table = False
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not in_table:
            if [c.lower() for c in cells[: len(SOURCE_COLUMNS)]] == SOURCE_COLUMNS:
                in_table = True
            continue
        if set("".join(cells)) <= set("-: "):
            continue  # header separator
        if len(cells) != len(SOURCE_COLUMNS):
            report.error(
                f"data-sources.md: row has {len(cells)} cells, expected {len(SOURCE_COLUMNS)}: {line}"
            )
            continue
        source = Source(cells[0].strip("`"), *cells[1:])
        if not ID_RE.match(source.id):
            report.error(f"data-sources.md: invalid source id {source.id!r}")
        elif source.id in sources:
            report.error(f"data-sources.md: duplicate source id {source.id!r}")
        sources[source.id] = source
    if not sources:
        report.error("data-sources.md: no source table found (header must start with | id | source |)")
    return sources


def validate_plan(plan: object, sources: dict[str, Source], report: Report) -> list[dict]:
    if not isinstance(plan, dict) or plan.get("plan_version") != 1:
        report.error("artefacts.yaml: expected a mapping with plan_version: 1")
        return []
    unknown_top = set(plan) - {"plan_version", "permissions", "source_routes", "artefacts"}
    if unknown_top:
        report.error(f"artefacts.yaml: unknown top-level keys {sorted(unknown_top)}")
    permissions = plan.get("permissions", {})
    if (
        not isinstance(permissions, dict)
        or permissions.get("native_land_permission") not in PERMISSION_VALUES
    ):
        report.error(
            f"artefacts.yaml: permissions.native_land_permission must be one of {sorted(PERMISSION_VALUES)}"
        )
    for sid, route in (plan.get("source_routes") or {}).items():
        if sid not in sources:
            report.error(f"artefacts.yaml: source_routes.{sid} has no row in docs/data-sources.md")
        if not isinstance(route, dict) or not str(route.get("official_url", "")).startswith("https://"):
            report.error(f"artefacts.yaml: source_routes.{sid} needs an https official_url")
        elif not route.get("route"):
            report.error(f"artefacts.yaml: source_routes.{sid} needs a route")
    artefacts = plan.get("artefacts")
    if not isinstance(artefacts, list) or not artefacts:
        report.error("artefacts.yaml: artefacts must be a non-empty list")
        return []

    seen_ids: set[str] = set()
    seen_outputs: set[str] = set()
    valid: list[dict] = []
    for i, artefact in enumerate(artefacts):
        where = f"artefacts[{i}]"
        if not isinstance(artefact, dict):
            report.error(f"{where}: must be a mapping")
            continue
        unknown = set(artefact) - {"id", "phase", "step", "description", "inputs", "outputs"}
        if unknown:
            report.error(f"{where}: unknown keys {sorted(unknown)}")

        aid = artefact.get("id")
        if not isinstance(aid, str) or not ID_RE.match(aid):
            report.error(f"{where}: id must be snake_case")
        elif aid in seen_ids:
            report.error(f"{where}: duplicate id {aid!r}")
        else:
            seen_ids.add(aid)
            where = f"artefact {aid!r}"

        if not isinstance(artefact.get("phase"), int):
            report.error(f"{where}: phase must be an integer")
        if not isinstance(artefact.get("step"), str) or not artefact["step"].startswith("pipeline/"):
            report.error(f"{where}: step must be a path under pipeline/")

        inputs = artefact.get("inputs")
        if not isinstance(inputs, list) or not inputs:
            report.error(f"{where}: inputs must be a non-empty list of source ids")
        else:
            for sid in inputs:
                if sid not in sources:
                    report.error(f"{where}: input {sid!r} has no row in docs/data-sources.md")

        outputs = artefact.get("outputs")
        if not isinstance(outputs, list) or not outputs:
            report.error(f"{where}: outputs must be a non-empty list")
        else:
            for entry in outputs:
                if not isinstance(entry, dict) or set(entry) != {"path", "schema"}:
                    report.error(f"{where}: each output must be {{path, schema}}, got {entry!r}")
                    continue
                out, schema = entry["path"], entry["schema"]
                if not isinstance(out, str) or not out.startswith("data/build/"):
                    report.error(f"{where}: output {out!r} must be under data/build/")
                elif not VERSIONED_RE.search(Path(out).name):
                    report.error(f"{where}: output {out!r} must carry a version, e.g. name.v1.json")
                elif out in seen_outputs:
                    report.error(f"{where}: output {out!r} is written by more than one artefact")
                else:
                    seen_outputs.add(out)
                if not isinstance(schema, str) or not (ROOT / schema).is_file():
                    report.error(f"{where}: schema {schema!r} for {out} does not exist (run npm run schemas)")
        valid.append(artefact)
    return valid


def print_plan(artefacts: list[dict], sources: dict[str, Source]) -> None:
    print("Meridian artefact plan (dry run: nothing downloaded, nothing built)\n")
    for artefact in sorted(artefacts, key=lambda a: (a.get("phase", 0), str(a.get("id")))):
        print(f"[phase {artefact.get('phase')}] {artefact.get('id')} ← {artefact.get('step')}")
        if artefact.get("description"):
            print(f"    {artefact['description']}")
        for entry in artefact.get("outputs") or []:
            if isinstance(entry, dict):
                print(f"    writes  {entry.get('path')}  (schema {entry.get('schema')})")
        for sid in artefact.get("inputs") or []:
            source = sources.get(sid)
            status = (
                "missing"
                if source is None
                else ("pending " + ",".join(source.pending) if source.pending else "ready")
            )
            print(f"    reads   data/raw/{sid}/  ({status})")
        print()

    used = {sid for a in artefacts for sid in a.get("inputs") or []}
    pending = sorted(sid for sid in used if sid in sources and sources[sid].pending)
    unused = sorted(set(sources) - used)
    print(f"{len(artefacts)} artefacts, {len(used)} sources referenced, {len(pending)} pending details.")
    if unused:
        print(f"Sources not used by any artefact: {', '.join(unused)}")


def run(plan_path: Path = PLAN_PATH, sources_path: Path = SOURCES_PATH) -> int:
    report = Report()
    sources = parse_sources(sources_path.read_text(encoding="utf-8"), report)
    artefacts: list[dict] = []
    try:
        plan = yaml.safe_load(plan_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        report.error(f"artefacts.yaml: invalid YAML: {exc}")
    else:
        artefacts = validate_plan(plan, sources, report)

    if artefacts:
        print_plan(artefacts, sources)
    if report.errors:
        print(f"\n{len(report.errors)} error(s):", file=sys.stderr)
        for message in report.errors:
            print(f"  ✗ {message}", file=sys.stderr)
        return 1
    print("Plan valid.")
    return 0


if __name__ == "__main__":
    sys.exit(run())
