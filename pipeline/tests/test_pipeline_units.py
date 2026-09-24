import csv
import gzip
import io
import zipfile

import numpy as np
import pytest

import attributes as attrs
from common import write_json_gz


def test_apportion_preserves_total_exactly_and_breaks_ties_by_key():
    out = attrs.apportion(np.array([1.0, 1.0, 1.0]), 10, np.array([2, 0, 1]))
    assert out.sum() == 10
    assert out.tolist() == [3, 4, 3]  # remainder goes to the smallest tiebreak key
    assert attrs.apportion(np.array([0.0, 0.0]), 3, np.array([0, 1])).sum() == 3
    assert attrs.apportion(np.array([5.0]), 0, np.array([0])).tolist() == [0]


def test_gzip_output_is_byte_identical(tmp_path):
    a, b = tmp_path / "a.json.gz", tmp_path / "b.json.gz"
    write_json_gz(a, {"x": [1, 2.5], "y": "é"})
    write_json_gz(b, {"x": [1, 2.5], "y": "é"})
    assert a.read_bytes() == b.read_bytes()
    assert gzip.decompress(a.read_bytes()) == '{"x":[1,2.5],"y":"é"}'.encode()


def test_ge45_winner_parsing(tmp_path):
    path = tmp_path / "t11.csv"
    header = [
        "Province",
        "Electoral District Number/Numéro de circonscription",
        "Elected Candidate/Candidat élu",
    ]
    rows = [
        ["NL", "10001", "Connors, Paul Liberal/Libéral"],
        ["QC", "24001", "Doe, Jane Bloc Québécois/Bloc Québécois"],
        ["BC", "59001", "Roe, R. NDP-New Democratic Party/NPD-Nouveau Parti démocratique"],
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        csv.writer(fh).writerows([header, *rows])
    assert attrs.read_ge45_winners(path) == {10001: 1, 24001: 3, 59001: 4}


def test_gdp_table_uses_latest_complete_current_dollar_year(tmp_path):
    header = ["REF_DATE", "GEO", "DGUID", "Prices", "North American Industry Classification System (NAICS)",
              "UOM", "SCALAR_ID", "SCALAR_FACTOR", "VALUE"]  # fmt: skip
    labels = {s: f"Sector {s} [{s.replace('_', '-')}]" for s in attrs.NAICS_SECTORS}
    rows = []
    for year, complete in (("2021", True), ("2022", True), ("2023", False)):
        for geo in attrs.GDP_PROVINCES:
            for sector, label in labels.items():
                value = "" if not complete and sector == "21" else f"{int(year) + len(sector)}.5"
                rows.append([year, geo, "", "Current dollars", label, "Dollars", "6", "millions", value])
                rows.append([year, geo, "", "Chained (2017) dollars", label, "Dollars", "6", "millions", "1"])
    rows.append(["2022", "Canada", "", "Current dollars", labels["11"], "Dollars", "6", "millions", "999"])
    buf = io.StringIO()
    csv.writer(buf).writerows([header, *rows])
    path = tmp_path / "36100711-eng.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("36100711.csv", buf.getvalue())
        zf.writestr("36100711_MetaData.csv", "x")
    values, year = attrs.read_gdp_table(path)
    assert year == "2022"
    assert len(values) == 13 * 20
    assert values[("AB", "31_33")] == 2027.5


def test_gdp_allocation_reconciles_each_province():
    mesh = {"cells": [{"province": p} for p in ["AB", "AB", "AB", "NU"]]}
    labour = np.zeros((4, len(attrs.NAICS_SECTORS)))
    labour[0, 0], labour[1, 0], labour[3, 1] = 30, 10, 5  # AB: sector 11 only; NU: sector 21 only
    population = np.array([100, 50, 50, 10])
    gdp = {(p, s): 10.0 for p in attrs.GDP_PROVINCES.values() for s in attrs.NAICS_SECTORS}
    original = attrs.read_gdp_table
    attrs.read_gdp_table = lambda path: (gdp, "2022")
    attrs.load_manifest, manifest = (lambda: {"statcan_gdp_36100711": {}}), attrs.load_manifest
    attrs.raw_file, raw = (lambda sid: None), attrs.raw_file
    try:
        values, year = attrs.gdp_column(mesh, labour, population)
    finally:
        attrs.read_gdp_table, attrs.load_manifest, attrs.raw_file = original, manifest, raw
    assert year == "2022"
    assert values[:3].sum() == pytest.approx(200.0)  # 20 sectors × 10 for Alberta
    assert values[3] == pytest.approx(200.0)
    assert values[0] == pytest.approx(10 * 30 / 40 + 19 * 10 * 100 / 200)


def test_haversine_edmonton_to_calgary():
    assert 275 < attrs.haversine_km(53.5461, -113.4938, 51.0447, -114.0719) < 285


def test_cached_intermediate_records_reuses_and_checks_its_hash(tmp_path, monkeypatch):
    """An intermediate from raw is recorded once, then read from the cache without raw; a cache or a
    rebuild that differs from the committed hash is refused (docs/decisions.md, 2026-09-24)."""
    import pytest

    import common

    monkeypatch.setattr(common, "RAW", tmp_path / "raw")
    monkeypatch.setattr(common, "INTERMEDIATES", tmp_path / "intermediates.sha256")
    calls = []

    def produce(payload=b"reaches"):
        calls.append(payload)
        return payload

    assert common.cached_intermediate("x.json", produce) == b"reaches"
    recorded = common.read_intermediate_hashes()
    assert list(recorded) == ["x.json"]

    # Cached: raw is not read again (the zips may be gone).
    assert common.cached_intermediate("x.json", lambda: pytest.fail("raw read")) == b"reaches"
    assert calls == [b"reaches"]

    # A tampered cache is refused.
    (tmp_path / "raw" / ".cache" / "x.json").write_bytes(b"other")
    with pytest.raises(ValueError, match="does not match"):
        common.cached_intermediate("x.json", produce)

    # A rebuild from raw that disagrees with the committed hash is refused, and not cached.
    (tmp_path / "raw" / ".cache" / "x.json").unlink()
    with pytest.raises(ValueError, match="rebuilt from raw"):
        common.cached_intermediate("x.json", lambda: b"changed")
    assert not (tmp_path / "raw" / ".cache" / "x.json").exists()
