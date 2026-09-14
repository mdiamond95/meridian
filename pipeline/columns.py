"""Typed-array column envelope: the Python half of app/src/schema/columns.ts.

Every column the pipeline writes goes through encode_column, which applies the dtype rule
(docs/decisions.md) and always writes little-endian bytes via explicit '<i4' / '<f4' dtypes,
so output never depends on the build machine's native byte order.

    counts, ids (incl. categorical codes)  → int32
    shares, rates, indices                 → float32
    money                                  → float32, unit "cad_millions"
    measure                                → float32, unit required
"""

from __future__ import annotations

import base64
import re
from typing import Any

import numpy as np

BYTE_ORDER = "le"
MONEY_UNIT = "cad_millions"
INT32_LE = np.dtype("<i4")
FLOAT32_LE = np.dtype("<f4")

KIND_DTYPE: dict[str, np.dtype] = {
    "count": INT32_LE,
    "id": INT32_LE,
    "share": FLOAT32_LE,
    "rate": FLOAT32_LE,
    "index": FLOAT32_LE,
    "money": FLOAT32_LE,
    "measure": FLOAT32_LE,
}
COLUMN_NAME_RE = re.compile(r"^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$")
UNIT_RE = re.compile(r"^[a-z][a-z0-9_]*$")


def file_meta(**provenance: str | int | float | bool) -> dict[str, Any]:
    """File-level meta for any artefact carrying encoded columns."""
    return {"byteOrder": BYTE_ORDER, **provenance}


def check_column_name(name: str) -> str:
    if not COLUMN_NAME_RE.match(name):
        raise ValueError(f"column name {name!r} is not snake_case")
    return name


def encode_column(
    values: Any,
    kind: str,
    *,
    unit: str | None = None,
    method: str | None = None,
    confidence: float | None = None,
) -> dict[str, Any]:
    if kind not in KIND_DTYPE:
        raise ValueError(f"unknown column kind {kind!r}")
    target = KIND_DTYPE[kind]
    arr = np.asarray(values)
    if arr.ndim != 1:
        raise ValueError(f"columns are 1-D, got shape {arr.shape}")

    if target == INT32_LE:
        if arr.size and not np.issubdtype(arr.dtype, np.integer):
            raise TypeError(f"kind {kind!r} needs integer values, got {arr.dtype}; round explicitly first")
        info = np.iinfo(np.int32)
        if arr.size and (arr.min() < info.min or arr.max() > info.max):
            raise OverflowError(f"kind {kind!r} values exceed int32")
    elif arr.size and not (np.issubdtype(arr.dtype, np.floating) or np.issubdtype(arr.dtype, np.integer)):
        raise TypeError(f"kind {kind!r} needs numeric values, got {arr.dtype}")

    if kind == "money" and unit != MONEY_UNIT:
        raise ValueError(f"money columns must use unit {MONEY_UNIT!r}")
    if kind == "measure" and (unit is None or not UNIT_RE.match(unit)):
        raise ValueError("measure columns need a snake_case unit, e.g. 'km'")
    if kind not in ("money", "measure") and unit is not None:
        raise ValueError(f"kind {kind!r} takes no unit")
    if confidence is not None and not 0 <= confidence <= 1:
        raise ValueError("confidence must be in [0, 1]")

    column: dict[str, Any] = {
        "kind": kind,
        "dtype": "int32" if target == INT32_LE else "float32",
        "byteOrder": BYTE_ORDER,
        "length": int(arr.size),
        "data": base64.b64encode(arr.astype(target).tobytes()).decode("ascii"),
    }
    if unit is not None:
        column["unit"] = unit
    if method is not None:
        column["method"] = method
    if confidence is not None:
        column["confidence"] = confidence
    return column


def decode_column(column: dict[str, Any]) -> np.ndarray:
    if column.get("byteOrder") != BYTE_ORDER:
        raise ValueError(f"unsupported byteOrder {column.get('byteOrder')!r}")
    dtype = {"int32": INT32_LE, "float32": FLOAT32_LE}[column["dtype"]]
    raw = base64.b64decode(column["data"], validate=True)
    if len(raw) != column["length"] * 4:
        raise ValueError(f"byte length {len(raw)} does not match {column['length']} × 4")
    return np.frombuffer(raw, dtype=dtype)
