# Meridian pipeline. Run from pipeline/ or via the root Makefile.
.PHONY: install dry-run lint test validate examples download mesh attrs layers atlas build verify fixture spot-check

install:
	uv sync --frozen

dry-run:
	uv run --frozen python dry_run.py

lint:
	uv run --frozen ruff check .
	uv run --frozen ruff format --check .

test:
	uv run --frozen pytest

validate:
	uv run --frozen python validate.py

examples:
	uv run --frozen python make_examples.py

download:
	uv run --frozen python download.py $(ARGS)

mesh:
	uv run --frozen python mesh.py

attrs:
	uv run --frozen python attributes.py

layers:
	uv run --frozen python polygons.py

atlas:
	uv run --frozen python -m atlas.build

# One command from raw inputs to validated, hashed artefacts.
build: mesh attrs layers atlas
	uv run --frozen python checksums.py write
	uv run --frozen python validate.py

verify:
	uv run --frozen python checksums.py verify

fixture:
	uv run --frozen python make_fixture.py

spot-check:
	uv run --frozen python spot_check.py
