"""Paths and deterministic writers shared by every pipeline step.

Determinism rules (plan Phase 1 §5): identical raw inputs must give byte-identical outputs.
  - JSON: fixed key order (as built), compact separators, no NaN, UTF-8.
  - gzip: mtime 0, no embedded filename, fixed compression level.
  - floats: rounded explicitly before serialising where the value is geometry-derived.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
RAW = Path(os.environ.get("MERIDIAN_RAW", ROOT / "data" / "raw"))
BUILD = Path(os.environ.get("MERIDIAN_BUILD", ROOT / "data" / "build"))
MANIFEST = RAW / "MANIFEST.json"

MESH_VERSION = "v1"
H3_RESOLUTION = 5
# Equal-area CRS for every area computation: Statistics Canada Lambert (EPSG:3347).
EQUAL_AREA_CRS = "EPSG:3347"
WGS84 = "EPSG:4326"


def dumps(doc: Any) -> bytes:
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def write_json(path: Path, doc: Any) -> None:
    write_bytes(path, dumps(doc))


def gzip_bytes(data: bytes) -> bytes:
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, compresslevel=9, mtime=0) as gz:
        gz.write(data)
    return buf.getvalue()


def write_json_gz(path: Path, doc: Any) -> None:
    write_bytes(path, gzip_bytes(dumps(doc)))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest() -> dict[str, Any]:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {}


def raw_file(source_id: str) -> Path:
    """The downloaded file for a source, as recorded in data/raw/MANIFEST.json."""
    entry = load_manifest().get(source_id)
    if entry is None:
        raise FileNotFoundError(f"{source_id} not downloaded; run make download")
    path = RAW / source_id / entry["file"]
    if not path.exists():
        raise FileNotFoundError(f"{path} missing; run make download")
    return path
