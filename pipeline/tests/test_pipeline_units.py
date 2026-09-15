import csv
import gzip
import io
import zipfile

import numpy as np

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


def test_gdp_table_parsing_uses_latest_year_and_current_dollars(tmp_path):
    header = ["REF_DATE", "GEO", "DGUID", "Prices", "North American Industry Classification System (NAICS)",
              "UOM", "SCALAR_ID", "SCALAR_FACTOR", "VALUE"]  # fmt: skip
    rows = [
        ["2024", "Alberta", "", "Current dollars", "Mining, quarrying, and oil and gas extraction [21]", "Dollars", "6", "millions", "90000"],
        ["2025", "Alberta", "", "Current dollars", "Mining, quarrying, and oil and gas extraction [21]", "Dollars", "6", "millions", "95000.5"],
        ["2025", "Alberta", "", "Chained (2017) dollars", "Mining, quarrying, and oil and gas extraction [21]", "Dollars", "6", "millions", "1"],
        ["2025", "Alberta", "", "Current dollars", "Manufacturing [31-33]", "Dollars", "6", "millions", "30000"],
        ["2025", "Canada", "", "Current dollars", "Manufacturing [31-33]", "Dollars", "6", "millions", "1"],
    ]  # fmt: skip
    buf = io.StringIO()
    csv.writer(buf).writerows([header, *rows])
    path = tmp_path / "36100711-eng.zip"
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("36100711.csv", buf.getvalue())
        zf.writestr("36100711_MetaData.csv", "x")
    assert attrs.read_gdp_table(path) == {("AB", "21"): 95000.5, ("AB", "31_33"): 30000.0}


def test_haversine_edmonton_to_calgary():
    assert 275 < attrs.haversine_km(53.5461, -113.4938, 51.0447, -114.0719) < 285
