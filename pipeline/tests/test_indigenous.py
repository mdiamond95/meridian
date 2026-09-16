"""Indigenous language families (indigenous.py, atlas/language_families.yaml) and their artefacts."""

from __future__ import annotations

import gzip
import json
import re

import numpy as np
import pandas as pd
import pytest

import indigenous as ind
from columns import decode_column
from common import BUILD, MESH_VERSION, ROOT, load_manifest, raw_file
from dry_run import SOURCES_PATH, Report, parse_sources

ATTRS = BUILD / f"attrs.{MESH_VERSION}.json.gz"
MESH = BUILD / f"mesh.{MESH_VERSION}.json.gz"
LAYER = BUILD / "indigenous.v1.json"
DOC = ind.load_families()


def downloaded(source_id: str) -> bool:
    return source_id in load_manifest()


def load(path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


# --- the lookup -----------------------------------------------------------------------------


def test_every_census_language_maps_to_a_family():
    families = {f["glottocode"] for f in DOC["families"]}
    assert len(DOC["languages"]) == 70
    for language in DOC["languages"]:
        assert language["family"] in families, language
        assert language["source"].strip(), language


def test_every_census_id_under_indigenous_languages_is_accounted_for_once():
    ids = [row["census"] for key in ("languages", "groups", "residuals") for row in DOC[key]]
    assert sorted(ids) == list(range(386, 476))
    # The residuals are the two responses no family can be named for, and nothing else.
    assert [r["census"] for r in DOC["residuals"]] == [474, 475]


def test_the_census_source_fetches_exactly_the_mapped_languages():
    sources = parse_sources(SOURCES_PATH.read_text(encoding="utf-8"), Report())
    url = sources[ind.CENSUS_SOURCE].url.strip("`")
    _, flow, ids, _ = url.split(":")
    assert flow == "DF_CSD"
    assert [int(i) for i in ids.split(",")] == ind.census_characteristics(DOC)


def test_caveat_matches_the_schema_literal():
    schema = json.loads((ROOT / "docs" / "schemas" / "indigenous.schema.json").read_text(encoding="utf-8"))
    assert DOC["caveat"].strip() == schema["$defs"]["IndigenousFile"]["properties"]["caveat"]["const"]


def test_lookup_rejects_a_census_id_left_out(tmp_path):
    text = ind.FAMILIES_PATH.read_text(encoding="utf-8")
    broken = tmp_path / "families.yaml"
    broken.write_text(re.sub(r"\n  - \{ census: 399, [^\n]*", "", text), encoding="utf-8")
    with pytest.raises(ValueError, match=r"missing \[399\]"):
        ind.load_families(broken)


@pytest.mark.skipif(not downloaded(ind.CENSUS_SOURCE), reason="census languages not downloaded")
def test_every_language_in_the_downloaded_census_list_maps_to_a_family():
    fetched = set(pd.read_csv(raw_file(ind.CENSUS_SOURCE), usecols=["CHARACTERISTIC"])["CHARACTERISTIC"])
    mapped = {language["census"] for language in DOC["languages"]}
    assert fetched == mapped


@pytest.mark.skipif(not downloaded("glottolog_languoids"), reason="Glottolog not downloaded")
def test_census_mapping_agrees_with_glottolog_and_every_family_is_known():
    rows = ind.read_glottolog(raw_file("glottolog_languoids"))
    assert ind.check_census_mapping(rows, DOC) == []
    seeds = ind.glottolog_seeds(rows, DOC)  # raises on a family neither mapped nor excluded
    assert {"beot1247", "laur1250"} <= {s.glottocode for s in seeds}  # extinct languages are seeds


# --- the method -----------------------------------------------------------------------------


def test_family_speakers_sums_languages_by_family():
    profile = pd.DataFrame({387: [10.0, np.nan], 441: [0.0, 5.0], 395: [3.0, 0.0]}, index=["a", "b"])
    speakers = ind.family_speakers(profile, DOC)
    assert speakers.loc["a", 1] == 13 and speakers.loc["b", 3] == 5 and speakers.loc["b", 1] == 0


def test_dominant_family_ties_go_to_the_lower_code_and_silence_is_unassigned():
    counts = np.array([[0.0, 0.0, 0.0], [2.0, 5.0, 5.0], [1.0, 0.0, 0.0]])
    assert ind.dominant_family(counts, [1, 2, 3]).tolist() == [0, 2, 1]


def line_graph(n: int, gap_after: int | None = None) -> tuple[list[list[int]], np.ndarray]:
    """Cells on the equator 0.1° apart; no edge across `gap_after`."""
    neighbours = [[j for j in (i - 1, i + 1) if 0 <= j < n] for i in range(n)]
    if gap_after is not None:
        neighbours[gap_after].remove(gap_after + 1)
        neighbours[gap_after + 1].remove(gap_after)
    lngs = np.arange(n) * 0.1
    return neighbours, ind.unit_vectors(np.zeros(n), lngs)


def test_graph_fill_takes_the_nearest_seed_by_path_length():
    neighbours, xyz = line_graph(6)
    family, km = ind.graph_fill(neighbours, xyz, [(0, 0.0, "aaaa1111", 1), (5, 0.0, "bbbb1111", 2)])
    assert family.tolist() == [1, 1, 1, 2, 2, 2]
    assert km[2] == pytest.approx(2 * 11.12, rel=0.01)
    # Two seeds at the same distance from a cell: the lower glottocode wins, whatever the order.
    tied = [(3, 0.0, "zzzz1111", 9), (3, 0.0, "bbbb1111", 2)]
    assert ind.graph_fill(neighbours, xyz, tied)[0].tolist() == [2] * 6


def test_sea_crossings_join_components_and_the_fill_reaches_across():
    neighbours, xyz = line_graph(6, gap_after=2)
    assert ind.components(neighbours).tolist() == [0, 0, 0, 1, 1, 1]
    crossings = ind.sea_crossings(neighbours, xyz)
    assert [(i, j) for i, j, _ in crossings] == [(2, 3)]
    family, _ = ind.graph_fill(neighbours, xyz, [(0, 0.0, "aaaa1111", 4)], crossings)
    assert family.tolist() == [4] * 6


def test_family_column_keeps_census_cells_and_fills_the_rest():
    neighbours, xyz = line_graph(5)
    lats, lngs = np.zeros(5), np.arange(5) * 0.1
    census = np.array([0, 7, 0, 0, 0])
    family, confidence, stats = ind.family_column(census, neighbours, lats, lngs, [(4, 0.0, "cccc1111", 3)])
    assert family.tolist() == [3, 7, 3, 3, 3]
    assert confidence.tolist() == [0.3, 0.7, 0.3, 0.3, 0.3]
    assert stats["census_cells"] == 1 and stats["unassigned_cells"] == 0


def test_communities_are_one_row_per_item_sorted_and_named(tmp_path):
    path = tmp_path / "c.csv"
    path.write_text(
        "item,people,name,point\n"
        "http://www.wikidata.org/entity/Q55624,first_nation,Snuneymuxw First Nation,Point(-123.9 49.2)\n"
        "http://www.wikidata.org/entity/Q2030,inuit,Iqaluit,Point(-68.5 63.75)\n"
        "http://www.wikidata.org/entity/Q2030,inuit,Iqaluit,Point(-68.6 63.70)\n"
        "http://www.wikidata.org/entity/Q9,metis,,Point(-110 55)\n",
        encoding="utf-8",
    )
    communities, unnamed = ind.read_communities(path)
    assert [c.id for c in communities] == [2030, 55624]
    assert communities[0].lng == -68.6 and unnamed == 1  # the first row by (item, people, point)
    offsets, values = ind.community_side_table(communities, [1, 1], 3)
    assert offsets.tolist() == [0, 0, 2, 2] and values.tolist() == [2030, 55624]


# --- the built artefacts --------------------------------------------------------------------


@pytest.fixture(scope="module")
def columns():
    attrs = load(ATTRS)
    if "indigenous_language_family" not in attrs["columns"]:
        pytest.skip("attrs built before the language-family column")
    return {
        name: decode_column(attrs["columns"][name])
        for name in (
            "indigenous_language_family",
            "indigenous_language_family_confidence",
            "population",
            "indigenous_language_share",
        )
    } | {"attrs": attrs}


@pytest.mark.skipif(not ATTRS.exists(), reason="attrs not built")
def test_every_populated_cell_with_indigenous_speakers_has_a_family(columns):
    family = columns["indigenous_language_family"]
    speakers = (columns["population"] > 0) & (columns["indigenous_language_share"] > 0)
    assert speakers.sum() > 1000
    assert (family[speakers] > 0).all(), f"{int((family[speakers] == 0).sum())} cells unassigned"


@pytest.mark.skipif(not ATTRS.exists(), reason="attrs not built")
def test_the_layer_covers_more_than_95_percent_of_cells_after_the_glottolog_fill(columns):
    family = columns["indigenous_language_family"]
    confidence = columns["indigenous_language_family_confidence"]
    assert (family > 0).mean() > 0.95
    assert {round(float(v), 2) for v in np.unique(confidence)} <= {0.0, 0.3, 0.7}  # float32
    assert ((family > 0) == (confidence > 0)).all()
    assert set(np.unique(family).tolist()) <= {0} | {f["code"] for f in DOC["families"]}


@pytest.mark.skipif(not ATTRS.exists(), reason="attrs not built")
def test_community_side_table_is_well_formed(columns):
    attrs = columns["attrs"]
    table = attrs["sideTables"]["indigenous_community_ids"]
    offsets, values = decode_column(table["offsets"]), decode_column(table["values"])
    assert len(offsets) == attrs["cellCount"] + 1 and offsets[0] == 0 and offsets[-1] == len(values)
    assert (np.diff(offsets) >= 0).all() and len(values) > 500


@pytest.mark.skipif(not (LAYER.exists() and ATTRS.exists()), reason="layer not built")
def test_the_layer_file_agrees_with_the_attrs_column(columns):
    layer = load(LAYER)
    family = columns["indigenous_language_family"]
    assert layer["caveat"] == DOC["caveat"].strip()
    assert sum(a["cells"] for a in layer["areas"]) == int((family > 0).sum())
    table = columns["attrs"]["sideTables"]["indigenous_community_ids"]
    assert sorted(decode_column(table["values"]).tolist()) == [c["id"] for c in layer["communities"]]
    topology = load(BUILD / "indigenous.v1.topojson.gz")
    assert set(topology["objects"]) == {a["geometryRef"] for a in layer["areas"]}
