# Meridian pipeline. Run from pipeline/ or via the root Makefile.
.PHONY: install dry-run lint test

install:
	uv sync --frozen

dry-run:
	uv run --frozen python dry_run.py

lint:
	uv run --frozen ruff check .
	uv run --frozen ruff format --check .

test:
	uv run --frozen pytest
