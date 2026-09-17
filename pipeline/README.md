# Meridian pipeline

Offline Python 3.12 pipeline that turns public datasets into Meridian's versioned build
artefacts. It runs once per data refresh, not in the browser.

## One command

```sh
make download     # fetch every source in docs/data-sources.md into data/raw/ (idempotent)
make build        # mesh → attrs → layers → atlas, then write data/build/SHA256SUMS and validate
make verify       # rebuild into a temp dir and confirm byte-identical output
make test         # pytest: contracts, units, and the Phase 1 and 2 gate checks
```

From the repo root, `make download`, `make build`, `make atlas` and `make verify` forward here.

`make build` needs everything that `make download` fetched. Two sources are special:

- **`statcan_gdp_36100711`**: www150.statcan.gc.ca blocks the Codespace, so a GitHub-hosted runner
  fetches it (`.github/workflows/fetch-gdp.yml`) and `make download` pulls the workflow's artifact
  with `gh` (the `gha:` fetcher). **Refreshing GDP** (new release each May): run the *Fetch StatCan
  GDP table* workflow from the Actions tab, or push a change to the workflow file. Then run
  `make download ARGS="--only statcan_gdp_36100711 --refresh"` and `make build`. Artifacts expire
  after 14 days, so refresh and build together.
- **`wikidata_indigenous_communities`** (`sparql:` fetcher): the query is
  `atlas/indigenous_communities.rq`. The manifest records the query file's path, not its text, so
  after editing the query run `make download ARGS="--only wikidata_indigenous_communities --refresh"`.
- **Native Land Digital** is declined permanently and has no source row or fetch path
  (docs/decisions.md, 2026-09-16).

## What gets built

| Artefact | Step | Contract |
|---|---|---|
| `data/build/mesh.v1.json.gz` | `mesh.py` | `docs/schemas/mesh.schema.json` |
| `data/build/attrs.v1.json.gz` | `attributes.py` | `docs/schemas/attrs.schema.json` |
| `data/build/layers/*.v1.topojson.gz` | `polygons.py` | `docs/schemas/topojson.schema.json` |
| `data/build/atlas.v1.json` | `atlas/build.py` | `docs/schemas/atlas.schema.json` |
| `data/build/atlas.v1.topojson.gz` | `atlas/build.py` | `docs/schemas/topojson.schema.json` |
| `data/build/indigenous.v1.json` | `polygons.py` (`indigenous`) | `docs/schemas/indigenous.schema.json` |
| `data/build/indigenous.v1.topojson.gz` | `polygons.py` (`indigenous`) | `docs/schemas/topojson.schema.json` |
| `data/build/places.v1.json.gz` | `polygons.py` (`places`, `splitter_inputs.py`) | `docs/schemas/places.schema.json` |
| `data/build/cells.v1.topojson.gz` | `polygons.py` (`cells`, `splitter_inputs.py`) | `docs/schemas/topojson.schema.json` |
| `data/build/snap.v1.json.gz` | `polygons.py` (`snap`, `splitter_inputs.py`) | `docs/schemas/snap.schema.json` |

`pipeline/artefacts.yaml` is the plan: `make dry-run` prints it, and `make validate` checks every
file in `data/build/` against its schema. The methods for each attribute column are in the
`attributes.py` docstring and on each column's `method` field.

## The historical atlas

```sh
make atlas                              # build the atlas and docs/atlas/checklist.md (~6 min)
uv run python -m atlas.build --check    # validate and compare with NRCan, write nothing
```

Boundaries are constructed, not traced. `atlas/events.yaml` lists every change date from 1867 on,
and each change describes a unit's boundary as an expression over the primitives in
`atlas/primitives.py`: parallels, meridians, modern borders, Canada1Water rivers, the Hudson Bay
watershed, isthmus cuts, and areas drawn through water. The operators are documented at the top
of `atlas/build.py`; the drawing rules are at the top of `events.yaml`.

For every event date the build checks that the geometries are valid, that no two de jure units
overlap, and that together they cover modern Canada within 0.5%. It then compares each polygon
with NRCan's *Territorial Evolution of Canada* map for that year (`nrcan_te_*` sources, used only
for this comparison) and writes the result into `docs/atlas/checklist.md`, starting with the rows
that disagree most.

Two slow steps are cached in `data/raw/.cache/`, keyed by the SHA-256 of their inputs: the split of
Canada among drainage regions, and the river reaches read from Canada1Water. Deleting the cache
only costs time.

**Changing events.yaml changes the golden hashes.** Rebuild, update
`pipeline/tests/golden/atlas.sha`, and say why in the commit.

## Determinism

Identical raw inputs (pinned by hash in `data/raw/MANIFEST.json`) and the locked environment
(`uv.lock`, mapshaper 0.7.61) produce byte-identical artefacts:
- JSON is written with fixed key order and compact separators.
- gzip uses mtime 0 and no filename.
- Spatial indexes are built from key-sorted inputs, and ties break by key.
- Integer apportionment uses largest remainder with a cell-index tiebreak.

`make verify` proves this on every run.

## Confidence caveats

- **GDP is an allocation, never a measurement.** `gdp_estimate` spreads 2022 provincial GDP by industry
  (current dollars, basic prices; the latest year StatCan publishes in current dollars for every
  province and sector) over cells in proportion to 2021 census labour force by industry
  (`method: allocation_v1`, `confidence: 0.5`). It ignores productivity differences within a province,
  commuting, and place of work vs place of residence. Provincial sums reconcile to the table exactly.
  Label it as an estimate everywhere.
- **Population is dasymetric.** Each DA's count sits at its representative point, so a DA that
  straddles cells puts all its people in one cell. CSD totals are exact; cell values are not.
- **Language, Indigenous identity and immigrant shares** come from the 25% sample and from
  suppressed small-area data. Sparse cells fall back to their CSD's shares.
- **Industry mixes are CSD-level**, spread by population; sub-CSD variation is lost.
- **Indigenous language families are not territories.** `indigenous_language_family` is derived
  from modern language distribution and linguistic records; it is not a map of pre-contact
  boundaries, and the layer says so on screen. Census cells (confidence 0.7) take the family with the
  most single-response mother-tongue speakers in 2021, spread within each CSD by population, so a
  cell reflects where speakers live now. Every other cell (confidence 0.3) takes the family of the
  nearest Glottolog language by distance over the mesh, joined across salt water by sea crossings;
  Glottolog gives one point per language, so these cells are an inference at a distance of hundreds of
  kilometres, not a record. Multiple mother-tongue responses and the census's "n.i.e."/"n.o.s."
  Indigenous responses are not assigned to a family. Community labels are Wikidata's, which is
  uneven: First Nation bands are well covered, Inuit communities are selected by region and Métis
  land bases by item (see `atlas/indigenous_communities.rq`). Native Land Digital's layer is declined
  permanently.
- **Treaty areas** are CIRNAC's approximate depictions, not legal boundaries.
- **Mesh inclusion:** a cell is in the mesh if it is ≥ 30% Canadian land (Atlas of Canada 1:1M land +
  inland water) OR it contains the representative point of a DA with population > 0. Attribution uses
  20 m-generalized StatCan boundaries, so coastal and border cells can differ from finer-scale sources,
  and a small city CSD can lose its cell to a larger surrounding CSD.
- **Some inputs are Internet Archive copies** of official files; see docs/data-sources.md.
- **Atlas polygons are first-order and generalized.** Where a legal line follows a lake shore or a
  survey description no source here carries, `events.yaml` uses waypoints simplified from NRCan's
  line (about 2 km). Newfoundland's Labrador before 1927 follows NRCan's coastal strip and carries
  `confidence: 0.5`, because no inland limit existed in law. The display copy drops islands under
  2 km² and is simplified to about 750 m.

## Refreshing for a new census

See docs/data-sources.md for each source's cadence. A new census means a new `MESH_VERSION`
(`common.py`), new source rows, and new artefact filenames. Old region packs keep referencing the
mesh version they were built on.
