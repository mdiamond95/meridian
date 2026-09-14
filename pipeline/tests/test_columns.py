import json

import numpy as np
import pytest

import validate
from columns import decode_column, encode_column

VECTORS = json.loads((validate.SCHEMAS / "examples" / "column-vectors.json").read_text())["vectors"]


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_shared_vectors_round_trip(vector):
    assert encode_column(vector["values"], vector["kind"]) == vector["column"]
    assert decode_column(vector["column"]).tolist() == vector["values"]


def test_bytes_are_little_endian_whatever_the_input_order():
    expected = bytes([0x04, 0x03, 0x02, 0x01])
    for dtype in (">i4", "<i4", "=i8"):
        column = encode_column(np.array([0x01020304], dtype=dtype), "id")
        assert column["byteOrder"] == "le"
        raw = np.frombuffer(decode_column(column).tobytes(), dtype=np.uint8).tobytes()
        assert raw == expected
    # Same bytes read big-endian are a different number: the order matters.
    assert int.from_bytes(expected, "big") == 0x04030201


def test_float_input_order_does_not_leak():
    big = np.array([1.0, -2.5], dtype=">f8")
    assert encode_column(big, "rate")["data"] == encode_column([1.0, -2.5], "rate")["data"]


@pytest.mark.parametrize(
    ("values", "kind", "kwargs", "error"),
    [
        ([1.5], "count", {}, TypeError),
        ([2**31], "id", {}, OverflowError),
        ([1.0], "money", {}, ValueError),
        ([1.0], "money", {"unit": "cad"}, ValueError),
        ([1.0], "measure", {}, ValueError),
        ([1], "count", {"unit": "people"}, ValueError),
        ([1.0], "share", {"confidence": 1.5}, ValueError),
        ([[1, 2]], "id", {}, ValueError),
        ([1], "percentage", {}, ValueError),
    ],
)
def test_writer_enforces_the_dtype_rule(values, kind, kwargs, error):
    with pytest.raises(error):
        encode_column(values, kind, **kwargs)


def test_decoder_rejects_other_byte_orders_and_bad_lengths():
    column = encode_column([1, 2], "id")
    with pytest.raises(ValueError):
        decode_column({**column, "byteOrder": "be"})
    with pytest.raises(ValueError):
        decode_column({**column, "length": 3})
