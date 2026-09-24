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

## Data refresh playbook

There are two kinds of refresh:

- **Within a mesh version:** a new release of a source the mesh does not depend on, such as the GDP
  table each May or a Wikidata re-query. The artefacts are rebuilt under the same names, and every
  pack still fits.
- **A new mesh version:** the next census (2026 geography, released from 2027) changes the census
  subdivisions and dissemination areas the mesh is built from. That is a new `meshVersion`, and
  everything keyed to cells moves with it.

Each source's release cadence is in `docs/data-sources.md`.

### A. Refresh within a mesh version (for example, GDP)

1. Fetch the new input. For GDP, run the *Fetch StatCan GDP table* workflow, then
   `make download ARGS="--only statcan_gdp_36100711 --refresh"`. The manifest records the new
   file's hash.
2. Run `make build`, which rewrites `data/build/SHA256SUMS`.
3. Run `make verify`, alone, with the editor's extra windows closed (`docs/perf.md`).
4. Only the artefacts built from that input should change. For GDP, that is
   `attrs.v1.json.gz`: `mesh.v1` and `cells.v1` must be byte-identical. If the mesh changed, stop:
   this is a new mesh version (B).
5. In the app:
   - Run `npm run presets -w app`. Assignments do not change unless a lens reads the refreshed
     column. The dossiers, scores and set analysis in the packs do.
   - Run `npm test`, then `npm run determinism -w app`.
   - A golden that moves gets a one-line reason in its commit (running rules).
6. Nothing breaks for old packs: same mesh, same cells. Their dossiers describe the data they were
   made with.

### B. A new census: a new mesh version

**1. Sources**
- Add new rows to `docs/data-sources.md` (the 2026 CSD, DA and CMA boundary files and census
  profiles), each with its licence and attribution string.
- Keep the 2021 rows: `v1` must stay rebuildable.
- Pin the new inputs with `make download`.

**2. Version**
- Set `MESH_VERSION = "v2"` in `common.py`.
- Every mesh-keyed output is renamed: `mesh.v2.json.gz`, `attrs.v2.json.gz`,
  `cells.v2.topojson.gz`, `places.v2.json.gz` and `snap.v2.json.gz`.
- The atlas, contact and Indigenous artefacts are not mesh-keyed. They keep `v1` unless their own
  contract changes; `indigenous` reads census language data through `attrs`, not directly.
- Add the new outputs to `artefacts.yaml`.

**3. Build and check**
- Run `make build`, `make verify` (alone) and `make validate`.
- Check the Phase 1 gates in pytest: population reconciles to the census totals, and every cell has
  a province.
- Run `make_fixture.py` for the new `*.fixture.v2` files.

**4. Keep the old files**
- `mesh.v1.json.gz` and the other `v1` files stay in `data/build/` and on `main`, never edited
  (docs/interop.md, versioning rule 3).
- The app re-fits a pack from another mesh by fetching that mesh's cell centres from
  `MESH_ARCHIVE` (`app/src/import/pack.ts`, raw GitHub on `main`). Deleting `mesh.v1.json.gz`
  breaks every re-fit of a `v1` pack.

**5. The app**
- Point `app/src/splitter/assets.ts` at the `v2` files.
- Run `npm run presets -w app`, which writes `packs/<slug>.v2.json` beside the `v1` files and
  points `packs/index.json` at `v2`.
- Regenerate the goldens (`app/src/engine/golden/*.json`, the cross-engine hashes) and justify each
  in its commit.
- Check the wording: the text that says "2021 census" in presets, dossiers and the House of Cards
  example in `docs/interop.md`.
- Nothing needs clearing:
  - the decoded-data cache in IndexedDB is keyed by the artefacts' fingerprinted URLs, so the new
    files are a new key and the old entry is dropped on the first write;
  - the service worker's cache is per build.

**6. Release**
- Tag, so external consumers can pin both meshes by raw URL at a tag.
- Add a Migrations note to `docs/interop.md` only if the RegionPack contract itself changed. A new
  mesh is not a contract change.

### What breaks for old packs and links on a new mesh

| What | What happens | Why |
|---|---|---|
| A `v1` pack, unedited, opened from the library or a file | The app offers to **regenerate** it from its seed and parameters on `v2`, or to **re-fit** it | The recipe is kept, but a solver run on other cells gives different regions: same method, not the same map. |
| A `v1` pack edited by hand | **Re-fit only**. Regenerating would lose the edits, so `fitPack` refuses it. | Re-fit gives each new cell the region of the nearest old cell centre within 30 km. Measured on alberta-15 against a synthetic `v2`: 99.77% of population lands in the same region. |
| Land the old mesh did not cover (new coastal cells) | Unassigned after a re-fit (region −1) | Nothing within 30 km to copy from. |
| A `#split=` share link | **Reruns on the current mesh** and gives a different split, silently | The link carries the recipe, not the mesh version or the cells. A link that must reproduce exactly should be shared as a pack file instead. |
| A `#pack=<slug>` link | Loads the current mesh's preset | `index.json` lists the current mesh's files. |
| Keep-together and keep-apart pins | A pin whose CSD uid no longer exists is **dropped** without notice | CSD uids change between censuses. Pins are resolved through `data.csds`. |
| Carved metros (CMA carve-out) | Carve the new census's CMAs | CMA membership goes through each cell's CSD. |
| Nested split trees (`children`) | Each node follows the rows above on its own. A re-fitted child's parent region may no longer match its cells exactly. | Nesting records `parentRegionId`, not geometry. |
| Scenarios, the atlas, scores' definitions | Unchanged | They are geometry and rules, not cells. The scores of a regenerated pack are recomputed from `v2` data. |
| External consumers reading `packs/*.v1.json` by raw URL | Keep working if pinned to a tag. On `main` they read the `v1` files, which are never removed. | Versioning rules 3 and 4. |
| Offline | A re-fit needs the network the first time | The old mesh is fetched from `MESH_ARCHIVE`, not precached. |
