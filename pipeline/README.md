# Meridian pipeline

Offline Python 3.12 pipeline that turns public datasets into Meridian's versioned build
artefacts. It runs once per data refresh, not in the browser.

## One command

```sh
make download     # fetch every source in docs/data-sources.md into data/raw/ (idempotent)
make build        # mesh → attrs → layers, then write data/build/SHA256SUMS and validate
make verify       # rebuild into a temp dir and confirm byte-identical output
make test         # pytest: contracts, units, and the Phase 1 gate checks
```

From the repo root, `make download`, `make build` and `make verify` forward here.

`make build` needs everything that `make download` fetched. `statcan_gdp_36100711` is a manual
download (see docs/data-sources.md); without it, `attrs` is built with no `gdp_estimate` column.

## What gets built

| Artefact | Step | Contract |
|---|---|---|
| `data/build/mesh.v1.json.gz` | `mesh.py` | `docs/schemas/mesh.schema.json` |
| `data/build/attrs.v1.json.gz` | `attributes.py` | `docs/schemas/attrs.schema.json` |
| `data/build/layers/*.v1.topojson.gz` | `polygons.py` | `docs/schemas/topojson.schema.json` |

`pipeline/artefacts.yaml` is the plan: `make dry-run` prints it, and `make validate` checks every
file in `data/build/` against its schema. The methods for each attribute column are in the
`attributes.py` docstring and on each column's `method` field.

## Determinism

Identical raw inputs (pinned by hash in `data/raw/MANIFEST.json`) and the locked environment
(`uv.lock`, mapshaper 0.7.61) produce byte-identical artefacts:
- JSON is written with fixed key order and compact separators.
- gzip uses mtime 0 and no filename.
- Spatial indexes are built from key-sorted inputs, and ties break by key.
- Integer apportionment uses largest remainder with a cell-index tiebreak.

`make verify` proves this on every run.

## Confidence caveats

- **GDP is an allocation, never a measurement.** `gdp_estimate` spreads provincial GDP by industry
  over cells in proportion to census labour force by industry (`method: allocation_v1`,
  `confidence: 0.5`). It ignores productivity differences within a province, commuting, and
  place of work vs place of residence. Label it as an estimate everywhere.
- **Population is dasymetric.** Each DA's count sits at its representative point, so a DA that
  straddles cells puts all its people in one cell. CSD totals are exact; cell values are not.
- **Language, Indigenous identity and immigrant shares** come from the 25% sample and from
  suppressed small-area data. Sparse cells fall back to their CSD's shares.
- **Industry mixes are CSD-level**, spread by population; sub-CSD variation is lost.
- **Native Land Digital territories are not included.** Their API terms forbid storing or
  redistributing the data without permission. If permission is granted, the polygons are
  approximations of relationships that were never polygonal, and every layer built from them must
  say so.
- **Treaty areas** are CIRNAC's approximate depictions, not legal boundaries.
- **Mesh coverage** uses the Atlas of Canada 1:1M outline, and cell attribution uses 20 m-generalized
  StatCan boundaries. Coastal and border cells can differ from finer-scale sources.
- **Some inputs are Internet Archive copies** of official files; see docs/data-sources.md.

## Refreshing for a new census

See docs/data-sources.md for each source's cadence. A new census means a new `MESH_VERSION`
(`common.py`), new source rows, and new artefact filenames. Old region packs keep referencing the
mesh version they were built on.
