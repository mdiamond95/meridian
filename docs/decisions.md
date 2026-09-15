# Decisions

Append-only. One line of rationale per decision; a later entry supersedes an earlier one by
saying so. Read this at the start of every session (docs/plan.md, running rules).

## 2026-09-14 — Phase 0 scaffold

### Stack (from docs/plan.md)

| Layer | Choice | Rationale |
|---|---|---|
| App | Vite 8 + React 18 + TypeScript (strict) | Familiar React; Vite builds a static bundle Pages can serve. |
| Map | Leaflet 1.9 used directly, no react-leaflet | Same as the Night Atlas; one less abstraction to debug. |
| Basemap | CARTO Positron raster tiles | Quiet light basemap that lets choropleths and boundaries read. |
| State | Zustand 5 | Small, and its plain state objects serialise straight into a URL. |
| Workers | Web Worker via Vite `?worker` (Phase 3) | The partition solver must never block the UI. |
| Unit tests | Vitest 5 | Shares Vite's transform pipeline; golden baselines live here. |
| Smoke tests | Playwright on the built site | Tests the bundle Pages will actually serve, not the dev server. |
| Lint / format | ESLint 10 (typescript-eslint strict, react-hooks) + Prettier 3 | Standard, and CI-enforceable with one command. |
| Pipeline | Python 3.12: geopandas, shapely ≥2, h3 ≥4, pyogrio, pyyaml, requests, numpy | Mature geo stack that runs unchanged in Codespaces. |
| Python env | uv with committed `uv.lock` | One fast tool for Python, venv and lockfile; `--frozen` makes CI reproducible. |
| Python lint | ruff (check + format) | Replaces flake8, isort and black with one fast tool. |
| Simplify | mapshaper (pinned global install in the devcontainer) | Best topology-preserving simplifier. |
| Mesh | H3 resolution 5 (~253 km², ~40k cells) | Fine enough for a 15-region Alberta, cheap enough in a Worker. |
| Data format | TopoJSON for polygons; gzipped JSON with typed-array columns for cell attributes | ~3–6 MB total, cached by the browser. |
| Hosting | GitHub Pages via Actions (`upload-pages-artifact` + `deploy-pages`) | Shareable links, no server; no `gh-pages` branch to maintain. |
| PRNG | mulberry32 (Phase 3) | Seeds reproduce across the township generator and Meridian. |
| Dev machine | Devcontainer: Python 3.12 image + Node feature + uv + mapshaper | Same environment in Codespaces, locally and on iPad via the browser. |
| Licence | MIT for code; data licences per source in data-sources.md | Code is reusable; data terms stay with their sources. |

### Deviations from the brief

- **Node 24 LTS instead of Node 20.** Node 20 reached end-of-life in April 2026, and Vitest 5 and jsdom 30 require Node ≥22. Node 24 is LTS until April 2028. Pinned in `.nvmrc`, CI and the devcontainer.
- **TypeScript 6.0, not 7.** typescript-eslint 8 supports TypeScript <6.1 only; move to 7 once it does.
- **CARTO Positron needs a (free) API key.** CARTO now watermarks keyless tiles ("API KEY REQUIRED"). The app reads `VITE_CARTO_KEY` at build time; Pages takes it from the repository variable `CARTO_BASEMAPS_KEY`. It is a public client key, so it is a variable, not a secret. Request one at carto.com/basemaps/apikey; restrict it to `mdiamond95.github.io` and localhost.

### Layout and tooling

- **npm workspaces, with the root delegating to `app/`.** `npm test`, `npm run build` and `npm run smoke` work from the repo root, with one lockfile.
- **Relative Vite `base: './'`.** The same build serves from `/` locally and from `/meridian/` on Pages, with no environment switch.
- **Smoke runs Chromium at a desktop and an iPad (820×1180) viewport.** It checks the sheet layout in CI without a WebKit download; a real iPad Safari check stays a manual gate.
- **Sheet breakpoint at ≤1024 px.** iPad portrait and most landscape widths get bottom sheets; wider screens get the floating right panel.
- **The root Makefile forwards to `pipeline/Makefile`.** `make dry-run` works from the root or from `pipeline/`.
- **Artefact plan lives in `pipeline/artefacts.yaml`.** The dry run validates it: versioned output names under `data/build/`, unique outputs, schema files that exist, and every input id present in `docs/data-sources.md`. Blank source details are "pending", not errors.
- **ESLint bans `Math.random`.** This is the plan's determinism rule, enforced from day one.
- **CI checks that `docs/schemas/` is up to date** (`npm run schemas:check`). The exported JSON Schemas can never drift from the TypeScript contracts.

### Contracts (app/src/schema)

- **Zod 4 is the single source of truth.** TypeScript types come from `z.infer`, JSON Schema comes from `z.toJSONSchema` (draft 2020-12), and Phase 5 imports get runtime validation for free.
- **Wire vs decoded types.** `MeshFileWire` / `RegionPackWire` describe the JSON. `MeshFile` / `RegionPack` hold decoded `Float32Array` / `Int32Array`, because JSON cannot carry typed arrays.
- **Typed-array columns are encoded as `{dtype, length, data}`, with `data` as base64 of little-endian bytes.** Byte-exact across numpy (`<f4`/`<i4`) and JS, which golden hashes need; decimal JSON floats would round differently in Python and JS.
- **Columns can carry optional `method` and `confidence`.** This meets the running rule that anything estimated keeps its method all the way to the UI (e.g. `gdp_estimate.method = "allocation_v1"`).
- **Every file has a `format` literal** (`meridian.mesh`, `meridian.atlas`, `meridian.regionPack`), so a loader can reject the wrong file before validating fields.
- **Mesh cells are sorted by H3 id; `neighbours` are indices into `cells[]`.** A deterministic order makes cell index usable as the typed-array index, and neighbour indices convert straight to CSR in Phase 3.
- **`centroid` is `[lon, lat]`** (GeoJSON axis order), and `area` is in km².
- **`version` is `"v<N>"`, matching the artefact filename;** RegionPack uses integer `version: 1` for its schema version and `meta.meshVersion` for the mesh.
- **Atlas unit validity is `validFrom` inclusive, `validTo` exclusive, null for "still valid".** Dates are ISO `YYYY-MM-DD`, which holds for year 1000.
- **Atlas unit rows are keyed by (id, validFrom).** A unit whose boundary changes gets a new row; unchanged geometry is shared via `geometryRef`.
- **Atlas statuses** come from vision §5.1: colony, province, territory, district, hbc_charter, unorganized, foreign, disputed. Units have optional `note` and `confidence`.
- **RegionPack `assignment` is int32, with -1 for cells outside scope.** Scope is a tagged union: canada / province / atlasUnit / region / polygon.
- **`dossier`, `setAnalysis` and `params` are open records for now.** Phases 3–4 own their shapes, and tightening them is a RegionPack version decision.

### Versioning rule for RegionPack

- **Adding an optional field is not a version bump.** Removing, renaming or re-typing a field bumps `version` and needs a migration note in docs/interop.md (Phase 5).

## 2026-09-14 — Contract amendments (before Phase 1)

Each entry below supersedes the matching Phase 0 entry.

### Cell ids
- **`MeshCell.id` is the H3 index as a 15-character lowercase hex string, never a JSON number.** H3 indexes exceed 2^53, so a number loses precision in JS. Zod and the JSON Schema enforce `^8[0-9a-f]{14}$`, and the second hex digit must equal `h3Resolution`.
- **Cells are sorted strictly by that string in codepoint order.** JS `<` and Python `<` agree on ASCII, so both sides produce and check the same order.

### Byte order
- **Every column envelope carries `byteOrder: "le"`, and so does the file meta** (`MeshFile.meta`, `AttrsFile.meta`, `RegionPack.meta`). AtlasFile holds no columns, so it has no byteOrder.
- **The JS encoder and decoder go through `DataView` with `littleEndian = true`.** The Python writer (`pipeline/columns.py`) uses explicit `'<i4'` / `'<f4'` dtypes. Neither depends on host byte order.
- **Shared byte vectors live in `docs/schemas/examples/column-vectors.json`** (e.g. int32 `0x01020304` → bytes `04 03 02 01`). Vitest and pytest both assert against them.

### Dtype rule (enforced by Zod and by the exported JSON Schema via `kind`)

| kind | dtype | notes |
|---|---|---|
| `count` | int32 | people, dwellings, jobs. Fractional estimates are rounded explicitly before writing. |
| `id` | int32 | ids and categorical codes (NAICS, ecozone, party, urban class). Labels go in `AttrsFile.lookups`. |
| `share`, `rate`, `index` | float32 | shares in [0, 1]; rates such as growth; derived indices |
| `money` | float32 | always millions of CAD, `unit: "cad_millions"` |
| `measure` | float32 | **extension, not in the original rule:** physical quantities such as `distance_to_capital_km`, which fit none of the above. `unit` is required. |

- **Column names are snake_case:** `^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`, so no capitals and no double or trailing underscores.
- **`unit` is allowed only on `money` and `measure`.** The Python writer refuses to silently truncate floats into an int32 kind.

### New contracts, needed so every artefact in data/build/ has a schema
- **`AttrsFile`** (`meridian.attrs`) carries the columns for one `meshVersion`, plus optional `lookups` (code → label for id columns) and `sideTables` (CSR `offsets`/`values` id columns, e.g. `native_land_territory_ids`).
- **`Topology`** is a structural TopoJSON schema for `layers/*.topojson` and the atlas geometry.

### Agreement between Python and TypeScript
- **`pipeline/artefacts.yaml` outputs are `{path, schema}` pairs.** The dry run requires the schema file to exist.
- **`pipeline/validate.py` (`make validate`) checks every file in `data/build/` with jsonschema (Draft 2020-12, formats asserted).** It also mirrors the Zod `.superRefine` invariants: sort order, resolution, column lengths, lookups, side tables. pytest fails if any build file is undeclared or invalid, and CI runs it as its own step.
- **`docs/schemas/examples/*.json` are generated by `make examples` (`pipeline/make_examples.py`).** Vitest validates them with Zod, and pytest with jsonschema.

### Basemap
- **With `CARTO_BASEMAPS_KEY` unset at build time, the app uses OpenStreetMap standard tiles** (© OpenStreetMap contributors, max zoom 19) and logs a console warning. Development and CI don't need a key.
- **The env var now has the same name as the repo variable,** exposed through Vite `envPrefix`. `VITE_CARTO_KEY` is retired.
- **Pages keeps CARTO.** `pages.yml` fails before building if the variable is empty, and the smoke test asserts the deployed bundle requests `basemaps.cartocdn.com` tiles.
- **Local key files are gitignored:** `CARTO_BASEMAPS_KEY`, `NATIVE_LAND_API_KEY`, `*.key`.

## 2026-09-15 — Phase 1: data pipeline and base mesh

### Sources and access
- **The Codespace cannot reach several Government of Canada hosts.** `www12`/`www150.statcan.gc.ca`, `*.sac-isc.gc.ca`, `www.elections.ca` and `agriculture.canada.ca` drop connections from its US datacenter address. Sources are fetched through equivalent official services where possible: StatCan's 2021 boundary map service (`geo.statcan.gc.ca`), the Census Profile SDMX API (`api.statcan.gc.ca`), NRCan's `ftp.maps.canada.ca` mirror and AAFC's ArcGIS Online service. Pinned Internet Archive copies of the official files are used only where no official route works: CIRNAC treaties, Inuit regions and the GE45 results. Every URL, licence and caveat is in data-sources.md.
- **`download.py` has four fetchers selected by the URL cell:** `https`, `arcgis:` (paged, with an on-disk page cache so a failed run resumes), `sdmx:` and `manual:`. Pages are ordered by OBJECTID and features are sorted before writing, so identical server data gives identical bytes.
- **GDP: table 36-10-0711-01 replaces discontinued 36-10-0402-01, and it is a manual download.** No reachable host has it. Until it is placed, `attrs.v1` is built without `gdp_estimate`, and file meta records `gdp_method: omitted_no_source`.
- **Native Land Digital is not fetched.** The Data Sovereignty Treaty behind the API key forbids storing or distributing the data without permission. `native_land_territory_ids` is omitted until permission exists. This is a decision for Mark.
- **Census profile characteristics are the SDMX ids listed in data-sources.md.** Counts use gender total and statistic "count". Suppressed values (FLAG 6) are read as missing, not zero.

### Mesh
- **Coverage comes from the Atlas of Canada 1:1M boundary polygons, not StatCan cartographic files.** StatCan cartographic PR/CSD polygons remove the Great Lakes and the St. Lawrence estuary; the brief's "land + inland water" needs them. Summed cell area is 10.21M km², 2.2% above the official 9.98M, because coastal cells more than 30% land count in full. Alberta is within 0.1%.
- **Province is the largest overlap with the Atlas polygons.** CD and CSD are the largest overlap with StatCan 2021 cartographic CSDs, restricted to the cell's province and then its CD, so codes always nest. The 197 cells with no CSD overlap (open water) take the nearest CSD in their province.
- **StatCan boundaries are generalized server-side to 20 m** (`maxAllowableOffset=20`). Without that, the largest features (Nunavut, Qikiqtaaluk) cannot be downloaded as GeoJSON. At 253 km² cells the effect on overlaps is negligible.
- **Cell `centroid` is the H3 cell centre and `area` is the H3 spherical area.** Overlap areas are computed in EPSG:3347 (equal-area) from projected H3 vertices.
- **Big polygons are cut into 50 km tiles before overlay.** This is for speed (the whole mesh builds in about 2 minutes) and does not change the result.
- **Result: 38,323 cells, 18 of them isolated islands, Alberta 2,642 cells.**

### Attributes (methods also on each column's `method`)
- **`pipeline/attrs.py` is `pipeline/attributes.py`.** A module named `attrs` shadows the PyPI `attrs` package that jsonschema imports.
- **Population places each DA's count at its representative point** (`point_on_surface` of the generalized DA polygon) and then apportions each CSD total exactly by largest remainder. `population` is int32 per the dtype rule, so CSD totals are preserved exactly, not "rescaled". The census profile also gives `population_2016`, which is stored for Phase 4 growth.
- **A DA's CSD and CMA come from point-in-polygon on the representative point.** The GAF relationship file is unreachable, and the relationship-table service rejects DISTINCT queries.
- **Language shares split multiple mother-tongue responses equally** among the languages named. Multiple responses that include a non-official language count toward `other_language_share`, because the census does not split them into Indigenous and non-Indigenous.
- **`urban_class` is decided by where most of a cell's people live** by DA class: CMA 3, CA 2. Otherwise a cell is rural (1) at ≥ 0.4 persons/km² and remote (0) below that. The threshold is a judgement call and can be changed.
- **Industry mix is CSD labour force by NAICS 2017 sector,** spread to cells by each CSD's population share (area share if unpopulated). Cells with no data use their CD's mix. `industry_dominant` stores the 2-digit code (31 for 31–33, 44 for 44–45, 48 for 48–49).
- **`treaty_code` is the largest of numbered / other historic / modern / unceded area in the cell,** with modern agreements taking precedence where they overlap historic treaties. 0 is reserved for cells with no land. `treaty_id` (largest single treaty) is added because Treaty 6 vs 7 vs 8 matters for Alberta.
- **`metis_settlement` and `inuit_region` require at least 50% of the cell.** Ecozone, basin, sub-basin and riding use the plain largest overlap.
- **Basins:** `basin_id` is StatCan drainage region (1–25) and `ocean_drainage_id` is the ocean drainage area; together they give the Continental Divide. `subbasin_id` is the WSC sub-drainage area from the NHN index, nationally. The Saskatchewan–Nelson detail is the `05*` codes.
- **`riding_party_2025`** is the party of the candidate elected in the cell's 2023-RO riding at the 45th general election (GE45 Table 11).
- **`distance_to_capital_km`** is the great-circle distance to the provincial or territorial legislature.
- **Code columns carry `lookups`** (code → label).

### Layers
- **Layers ship as gzipped TopoJSON (`layers/*.v1.topojson.gz`), like the mesh and attributes.** Uncompressed, the boundary layers alone blow the 8 MB budget (the high tier is ~4.6 MB for 5,161 CSDs), and TopoJSON compresses 3–4×. The app loader already gunzips.
- **Provinces, CDs and CSDs are dissolved from the same 2021 CSD source** and share one topology per zoom tier, so province and CD edges reuse CSD arcs:
  - `boundaries.low`: provinces at a 5 km weighted interval (56 KB)
  - `boundaries.mid`: provinces and CDs at 1 km (330 KB)
  - `boundaries.high`: provinces, CDs and CSDs at 400 m (1.38 MB)
- **Drainage layers drop polygon parts under 50 km² and are coverage-simplified to 1 km** before mapshaper. Otherwise Arctic island coastline makes up most of the 384,000 arcs (4.2 MB → 880 KB). Shared edges stay identical, so the Continental Divide stays intact.
- **Rivers use Canada1Water Strahler order ≥ 7, not ≥ 5.** On this 1:50K network, order 5 is a small stream: the Nelson region alone has 76,000 km at ≥ 5 against 18,700 km at ≥ 7. Order 7 is the lowest that still includes the Bow, Red Deer, Battle and Qu'Appelle, the rivers Alberta's borders snap to.
  - Reaches (244,000 nationally) are merged per (order, name), clipped to Canada, and simplified at 150 m, giving 363 KB.
  - Each regional GeoPackage is extracted before reading. Through `/vsizip/` a single region took 20+ minutes.
- **mapshaper is pinned to 0.7.61.** The global devcontainer install is used if its version matches; otherwise `npx mapshaper@0.7.61`.
- **Artefact sizes:** mesh 1.07 MB, attrs 0.94 MB, layers 3.28 MB; total 5.29 MB, under the 8 MB gate, which is enforced by a test.

### Spot checks (Phase 1 "You do" — for Mark to confirm)
- **Bonnie Doon, Fort McMurray, Grand Falls-Windsor, Old Montréal:** cells carry plausible values; the full dump is in the session log.
- **Iqaluit's own cell (`850f0b1bfffffff`) is not in the mesh.** Only 24.5% of it is land in the Atlas 1:1M outline, below the brief's 30% keep rule. Its 7,429 residents go to the adjacent inland cell `850f0bc7fffffff`, so totals are exact, but the capital's own hexagon is missing. **Recommendation:** also keep any cell that contains a populated DA representative point. That adds a handful of coastal settlement cells and needs Mark's approval, since it changes the brief's rule.

### Determinism and verification
- **`make verify` rebuilds all artefacts into a temp directory from the same raw inputs** and diffs hashes against `data/build/SHA256SUMS`.
- **Raw inputs are pinned by SHA-256 in `data/raw/MANIFEST.json`,** which is not committed. Some upstreams change: NRCan Aboriginal Lands is regenerated monthly. Re-downloading can change outputs; that is a data refresh, not nondeterminism.
