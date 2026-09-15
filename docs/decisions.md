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

### Deviations from the Phase 1 brief (each detailed below)
1. **Sources reached by other routes.** Several Government of Canada hosts drop the Codespace's connections. Sources use official services (StatCan boundary map service, Census Profile SDMX API), NRCan's FTP mirror, AAFC's ArcGIS Online service, pinned Internet Archive copies of official files (CIRNAC treaties, Inuit regions, GE45 results), and a GitHub Actions runner for the GDP table.
2. **GDP table 36-10-0711-01 replaces the discontinued 36-10-0402-01,** using reference year 2022, the latest year with current-dollar values for every province and sector.
3. **Native Land Digital is not fetched,** so `native_land_territory_ids` is omitted, pending permission.
4. **Mesh coverage uses the Atlas of Canada 1:1M outline, not StatCan cartographic provinces,** which remove the Great Lakes.
5. **The mesh inclusion rule was changed at Mark's direction** (see Mesh).
6. **`pipeline/attrs.py` is `pipeline/attributes.py`.** A module named `attrs` shadows the PyPI `attrs` package that jsonschema imports.
7. **Population is apportioned with integer largest remainder per CSD** rather than "rescaled", because `population` is int32 under the dtype rule.
8. **`population_2016` spreads 2016 CSD totals with 2021 DA weights.** 2016 counts are not published at DA level.
9. **Layers are gzipped TopoJSON (`*.topojson.gz`),** and provinces, CDs and CSDs share one topology per zoom tier (`boundaries.low|mid|high`).
10. **Rivers use Canada1Water Strahler order ≥ 7, not ≥ 5.**
11. **Extra columns and fields beyond the brief's list:** `population_2016`, `treaty_id`, `ocean_drainage_id`, `lookups`, and a `measure` column kind (confirmed by Mark).

### Sources and access
- **The Codespace cannot reach several Government of Canada hosts.** `www12`/`www150.statcan.gc.ca`, `*.sac-isc.gc.ca`, `www.elections.ca` and `agriculture.canada.ca` drop connections from its US datacenter address. Every URL, licence and caveat is in data-sources.md.
- **`download.py` fetchers, selected by the URL cell:**
  - `https`: plain file download.
  - `arcgis:`: paged, with an on-disk page cache so a failed run resumes.
  - `sdmx:`: the StatCan Census Profile API.
  - `gha:`: the artifact of the latest successful run of a GitHub Actions fetch workflow, pulled with `gh`.
  - `manual:`: a file placed by hand.

  ArcGIS pages are ordered by OBJECTID and features are sorted before writing, so identical server data gives identical bytes.
- **GDP route, tried in the order Mark set:**
  - (a) The Wayback availability API had no snapshot of the zip or the WDS URL, and CDX returned 503.
  - (b) Save Page Now returned HTTP 500 on 5 attempts with backoff.
  - (c) **Worked.** `.github/workflows/fetch-gdp.yml` downloads the zip on a GitHub-hosted runner, checks it contains `36100711.csv` with the expected header, records its SHA-256, and uploads it as an artifact. `make download` pulls it with `gh`. The Codespace token cannot dispatch workflows, so the workflow also runs on a push that changes the workflow file.

  The official URL is registered in `pipeline/artefacts.yaml` under `source_routes`, and refresh steps are in pipeline/README.md.
- **Native Land Digital is not fetched.** The Data Sovereignty Treaty behind the API key forbids storing or distributing API data without explicit permission. `permissions.native_land_permission: pending` in `pipeline/artefacts.yaml` gates the fetch in `download.py`, and the dry run validates the flag. The permission request is drafted in docs/native-land-permission-request.md. The API key is available to the pipeline as the Codespaces secret `NATIVE_LAND_API_KEY` but is unused while permission is pending.
- **Census Profile characteristics are the SDMX ids listed in data-sources.md.** Counts use gender total and statistic "count". Suppressed values (FLAG 6) are read as missing, not zero.

### Licence review (2026-09-15)
- **Every source behind a committed artefact is under the Statistics Canada Open Licence, OGL-Canada or OGL-Alberta.** Checked against open.canada.ca records where they exist:
  - Historic treaties, modern treaties and Inuit regions (CIRNAC/ISC)
  - Federal electoral districts 2023
  - Canada1Water
  - Atlas of Canada 1:1M
  - NHN
  - Census Profile 2021
  - GDP table 36-10-0711-01
- **GE45 results** are treated as OGL-Canada: Elections Canada publishes the 42nd–44th results on open.canada.ca under it, and the 45th is not listed yet.
- **Not cleared, and no artefact is built from them:** Native Land Digital (terms above), and the CARTO and OpenStreetMap basemap tiles, which are only displayed live in the app. They are listed for Mark in data-sources.md.

### Mesh
- **Inclusion rule, approved by Mark 2026-09-15:** a cell is in the mesh if it is ≥ 30% Canadian land OR it contains the representative point of any DA with population > 0.
  - "Canadian land" is measured against the Atlas of Canada 1:1M boundary polygons, which cover land plus inland water, including the Canadian Great Lakes. Large lakes therefore stay in the mesh, as the brief's "land + inland water" requires.
  - A DA representative point is `point_on_surface` of the 2021 cartographic DA polygon.
  - The earlier "cell centre in Canada" clause is gone.
- **Effect of the rule change:** 38,323 → 38,432 cells, with 154 added and 45 removed.
  - The additions are coastal cells holding populated DA points, mainly outports and islands in Newfoundland, Nova Scotia, New Brunswick, PEI, the Gaspé, Vancouver Island, the Gulf Islands, and Nunavik/Nunavut coastal communities.
  - The removals are cells whose centre was in Canada but which were under 30% Canadian, mostly uninhabited Arctic coast.
  - **Correction to the earlier Iqaluit finding:** Iqaluit's 3 DA representative points, with all 7,429 residents, fall in `850f0bc7fffffff`, which was already in the mesh. `850f0b1bfffffff` contained only the legislature coordinate used for the first spot check, and it has no DA point, so it is still excluded.
- **Gate test:** every provincial and territorial capital's CSD representative point falls in a mesh cell. The 13 points are recorded in `tests/test_mesh_artefacts.py` and re-derived from raw data when it is present.
- **Province** is the largest overlap with the Atlas polygons. A cell kept only for a DA point, with no Atlas overlap, takes that DA's province.
- **CD and CSD** are the largest overlap with StatCan 2021 cartographic CSDs, restricted to the cell's province and then its CD, so codes always nest. The 197 cells with no CSD overlap (open water) take the nearest CSD in their province. Because the largest overlap wins, a small city CSD can lose its cell to the surrounding CSD: Iqaluit's cell is CSD 6204030, not 6204003.
- **StatCan boundaries are generalized server-side to 20 m** (`maxAllowableOffset=20`). Without that, the largest features cannot be downloaded as GeoJSON.
- **Cell `centroid` is the H3 cell centre and `area` is the H3 spherical area.** Overlaps are computed in EPSG:3347 (equal-area) from projected H3 vertices. Big polygons are cut into 50 km tiles before overlay, for speed only.
- **Result:** 38,432 cells; Alberta has 2,642.

### Attributes (methods also on each column's `method`)
- **Population places each DA's count at its representative point** and apportions each CSD total exactly by largest remainder, so the Canada total is exactly 36,991,981.
- **A DA's CSD and CMA come from point-in-polygon on the representative point.** The GAF relationship file is unreachable.
- **Language shares split multiple mother-tongue responses equally** among the languages named. Multiple responses that include a non-official language count toward `other_language_share`.
- **`urban_class` is decided by where most of a cell's people live** by DA class: CMA 3, CA 2. Otherwise a cell is rural (1) at ≥ 0.4 persons/km² and remote (0) below that.
- **Industry mix is CSD labour force by NAICS 2017 sector,** spread to cells by each CSD's population share (area share if unpopulated), with the CD's mix as fallback. `industry_dominant` stores the 2-digit code.
- **`gdp_estimate`** (kind `money`, `cad_millions`, `method: allocation_v1`, `confidence: 0.5`): each province's 2022 current-dollar GDP by NAICS sector × the cell's share of that province's census labour force in the sector, summed.
  - A sector with no census labour force in a province is shared by population, so every province reconciles exactly to the table.
  - Tests check each provincial sum against the table's totals.
  - File meta records `gdp_reference_year: 2022` and `gdp_prices: current_dollars_basic_prices`.
- **`treaty_code` is the largest of numbered / other historic / modern / unceded area in the cell,** with modern agreements taking precedence where they overlap. `treaty_id` records the largest single treaty.
- **`metis_settlement` and `inuit_region` need at least 50% of the cell.** Ecozone, basin, sub-basin and riding use the plain largest overlap. `ocean_drainage_id` gives the Continental Divide.
- **`riding_party_2025`** is the party elected in the cell's 2023-RO riding at GE45. **`distance_to_capital_km`** is the great-circle distance to the legislature.

### Layers
- **Gzipped TopoJSON.** The boundary layers blow the 8 MB budget uncompressed, and TopoJSON compresses 3–4×.
- **Boundary tiers** share one topology each: `boundaries.low` (provinces at 5 km), `boundaries.mid` (+ CDs at 1 km), `boundaries.high` (+ CSDs at 400 m).
- **Drainage layers drop parts under 50 km² and are coverage-simplified to 1 km,** so shared edges stay identical.
- **Rivers use Canada1Water Strahler order ≥ 7.** Order 7 is the lowest that includes the Bow, Red Deer, Battle and Qu'Appelle; on this 1:50K network the Nelson region alone has 76,000 km at order ≥ 5. Reaches are merged per (order, name), clipped to Canada, and simplified at 150 m. Regional GeoPackages are extracted before reading.
- **mapshaper is pinned to 0.7.61.**
- **Artefact sizes:** mesh 1.07 MB, attrs 0.98 MB, layers 3.28 MB; total 5.33 MB, under the 8 MB gate, which is enforced by a test.

### Keys
- **Key storage.** `CARTO_BASEMAPS_KEY` is a repository Actions variable, read by the Pages build (confirmed: the live site requests keyed CARTO tiles with no watermark). `NATIVE_LAND_API_KEY` is a Codespaces secret (confirmed present in env; value never printed).
- **Local key files.** They were deleted from disk and never committed; their `.gitignore` entries stay.
- **Secret scan.** `scripts/check_secrets.py` runs in the `.githooks/pre-commit` hook and in the CI **Secret scan** job. It fails on files named `*_KEY`, `*_SECRET` or `*_TOKEN`, and on common credential patterns.

### Determinism and verification
- **`make verify`** rebuilds all artefacts into a temp directory from the same raw inputs and diffs hashes against `data/build/SHA256SUMS`.
- **Raw inputs are pinned by SHA-256 in `data/raw/MANIFEST.json`,** which is not committed. After the Codespace restart wiped `/tmp`, the 8 Canada1Water files were re-downloaded into `data/raw/` with identical hashes. Upstreams that change (NRCan Aboriginal Lands is regenerated monthly) make a data refresh, not nondeterminism.

## 2026-09-15 — Devcontainer: persist Claude Code

- **Claude Code comes from the official feature `ghcr.io/anthropics/devcontainer-features/claude-code:1.0`.** It installs the CLI and the VS Code extension on every build, so a rebuild no longer loses them.
- **Sign-in lives in a named volume, `claude-code-config-${devcontainerId}`, mounted at `/home/vscode/.claude`, with `CLAUDE_CONFIG_DIR` pointing there.** The volume survives rebuilds; setting the env var also moves `.claude.json` inside it. The path is `/home/vscode`, not `/home/codespace`, because the Python image's `remoteUser` is `vscode`.
- **`post-create.sh` chowns the volume to the remote user.** Docker creates a named volume root-owned when the target is absent from the image.
- **Pushed straight to `main`, no PR.** Config only; nothing in the app, pipeline or artefacts changes.
