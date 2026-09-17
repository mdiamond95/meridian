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

## 2026-09-15 — Phase 2 Sitting A: atlas framework, 1867 to today

### Deviations from the brief
1. **More dates.** Research against the statutes and NRCan's maps found polygon changes the brief's list lacks: 1874 (Ontario's provisional line), 1886 (Keewatin trimmed), 1897 (districts redrawn), 1901 (Yukon's modern line) and 1920 (the 1918 district order). All are events. Two name/capital events were added as well: 1953 (Whitehorse) and 2003 ("Yukon").
   - **1877 is not an event.** Manitoba was re-described along survey lines that year, a shift of under 8 km.
   - **1903 has no polygon change.** NRCan draws the award line for every year, so the atlas does too; the claim lines are Sitting C's disputed layer.
2. **Boundaries are expressions, not only rings.** Where an instrument walks a ring (Manitoba 1870, Keewatin 1876, the 1882 districts), the unit is a ring of primitives. Where it defines by reference ("the rest of the territories", "the Hudson Bay watershed", "less Manitoba"), the unit is a set operation over units, modern borders and primitives. The same algebra guarantees tiling.
3. **Extra primitives, each unit-tested:**
   - `drainage`: land split among StatCan drainage regions.
   - `island`, `zone` and `coastal_islands`: whole islands by position or by distance from the mainland, for the orders' "islands within three miles".
   - `cut`: a line across an isthmus, used for Boothia and Melville.
   - `was`: units as they stood when an event began, for redistributions.
4. **`atlas.v1.topojson.gz`, not `.topojson`,** matching the layers. `atlas.v1.json` stays plain, since its hash is the golden.
5. **Units that existed before 1867 start at 1867-07-01** until Sitting B backdates them.
6. **The golden records both files,** in `pipeline/tests/golden/atlas.sha`, and pytest asserts it in CI.
7. **Resolve tests run twice.** pytest runs them on the artefact; Vitest runs them through the app's own loader and decoder.

### Drawing rules
- **The instrument decides where its text is clear. NRCan's Territorial Evolution maps decide where the text is silent, ambiguous or disputed.** Every divergence from NRCan is named in the unit's boundary text in `docs/atlas/checklist.md`.
- **NRCan's maps are a verification-only source.** They are the `nrcan_te_<year>` rows, under OGL-Canada. The build compares each polygon with NRCan's polygon for the same year and writes the overlap into the checklist; nothing in `data/build/` is derived from them.
- **Lake shores and survey descriptions with no source here** (Lake Manitoba to Cedar Lake, Lake Winnipeg, Lac Seul and Lake St. Joseph, the 1895/1897 Yukon ranges, the Hamilton River) **use NRCan waypoints simplified to about 2 km,** marked in `events.yaml`. Rivers with named Canada1Water reaches use the network: English, Albany, Nelson, Athabasca, Slave and Eastmain.
- **Dominion Land Survey lines are read from the modern Manitoba–Saskatchewan border's correction-line jogs.** The 9th correction line is 51.9686°N, the 12th base line 52.8422°N, and the 18th correction line 55.1116°N. The ranges 10/11 W4 line is stepped at 9.80 km per range, within about 2 km of the survey.
- **The Hudson Bay watershed is StatCan's Hudson Bay ocean drainage area.** Coastal land no region covers joins the nearest region, in 0.1° tiles.

### Where the atlas departs from NRCan's drawing
- **1867, Arctic islands:** a separate British unit. NRCan folds them into the North-Western Territory for 1867 only, which is why that row matches NRCan at 68%.
- **1870, Manitoba:** the Act's lines (96°W, 99°W, 50°30′N); NRCan's box is 2–3 km off.
- **1895–1897, Keewatin:** stays statutory. The order's enlargement needed a bill that was never introduced. The land north of Ontario and the far Hudson Bay islands stay in the territories outside any district, which is why Ungava 1895 matches at 93%.
- **1912–1920, District of Ungava:** survives as islands. The 1897 order was cancelled only from 1920; NRCan splits the islands early.
- **1920 onward, Nottingham Island:** stays in Franklin, as the order puts it; NRCan's maps from 1927 put it in Keewatin.

### Following NRCan where the law is silent
- **Labrador before 1927:** NRCan's coastal strip, with `confidence: 0.5` and a note. How to show the dispute is Mark's Sitting C decision.
- **Ontario 1867:** the height of land.
- **The Labrador interior:** Rupert's Land, then the territories.
- **The Ontario–Manitoba disputed area, 1881–1889:** between 95°09′W and 90°58′W, south of the 12th base line.
- **Keewatin's eastern limit, 1889–1895:** stays at 90°58′W.
- **Keewatin, 1905–1920:** extends west to 102°W.
- **The 1882 Saskatchewan district:** does not overlap statutory Keewatin.

### Dates chosen where sources disagree (flagged in the checklist)
| Event | Date used | Alternative |
|---|---|---|
| Manitoba enlarged | 1881-07-01 | 1881-12-23 |
| Ontario's provisional line | 1874-06-26 | orders of 1874, day uncertain |
| Provisional districts | 1882-05-08, the order's own date | 17 May |
| Labrador decision | 1927-03-01, the report | 11 March |

### Model choices
- **Newfoundland is `colony` from 1867 to 1949.** The status enum has no "dominion"; the note records 1907 and 1934.
- **From 1882 to 1999 the northern units are the districts.** A `northwest_territories` unit exists only where land lies in no district (1870–1897), then again from 1999. Territorial capitals in those years are in notes.
- **Validation tolerances:**
  - De jure units at each event date may overlap by at most 5 km².
  - Together they must cover modern Canada within 0.5%.
  - Areas are computed in EPSG:3347 after densifying to 0.02°, because a two-vertex parallel projects to a chord.
- **The display copy is built for shared arcs.** Collinear vertices are removed before export, so every polygon has the same vertex sequence along a shared edge; this took the topology from 1.74 MB to 184 KB. mapshaper then simplifies at 750 m and islands under 2 km² are dropped. Areas stay within 0.2%.
- **Slow steps are cached in `data/raw/.cache/`,** keyed by input SHA-256: the drainage partition and the Canada1Water reaches.

### App
- **Artefacts are imported with Vite `?url`,** so the bundle ships fingerprinted copies of the versioned files.
- **TopoJSON is decoded in about 40 lines** (`app/src/atlas/topology.ts`) instead of adding `topojson-client`.
- **The slider steps by year, and a year shows the map as at 31 December.** Event ticks jump to the exact date, so 1 April 1999 shows Nunavut.
- **Selection is by unit id,** so a selected Manitoba stays selected as it grows.
- **Fill is by status.** Approximate units and non-de-jure layers are lighter, and disputed units are dashed.
- **The de facto and disputed toggles exist but have no data** until Sittings B and C.
- **`@types/geojson` is declared** rather than used through Leaflet's types.

## 2026-09-15 — PR #5 review applied (Sitting A)

Mark's decisions on PR #5, and what they changed.

- **Drawing rule approved:** the instrument where its text is clear, NRCan where the text is silent or disputed.
- **The five departures from NRCan now carry a citation, a one-sentence rationale and a confidence** (`instrument`, `rationale`, `confidence` on the unit row, printed in the checklist and the unit panel):

  | Row | Instrument | Confidence |
  |---|---|---|
  | British Arctic Islands 1867 | Rupert's Land and North-Western Territory Order (23 June 1870); Adjacent Territories Order (31 July 1880, in force 1 September 1880) | 0.7 — the DCER editors note the 1821/1859 definitions could be read to include the islands; the "not transferred" view is the one officials held |
  | Manitoba 1870 | Manitoba Act, 1870, 33 Vict. c. 3, s. 1 | 0.95 |
  | Territories outside any district 1895 | P.C. 1895-2640, Keewatin paragraph (recommends a Bill); Keewatin Act, 39 Vict. c. 21, s. 1 | 0.85 |
  | District of Ungava islands 1912 | P.C. 1897-3388 (Ungava); Quebec Boundaries Extension Act, 1912, s. 2; order of 16 March 1918 (in force 1 January 1920) | 0.8 — the Act excludes islands only by following the shore |
  | Franklin 1927 (Nottingham Island) | Order of 16 March 1918, Keewatin description (line to Cape Wolstenholme) | 0.9 |

- **Keewatin 1895: the divergence stands; the evidence is strong.**
  - The order's text in the Canada Gazette (19 October 1895, p. 684) sets the four new districts' boundaries directly, but for Keewatin only "recommends that at the next Session of Parliament a Bill be introduced". Keewatin's limits were statutory, and the executive's statutory power only ran to cutting land out of it.
  - The 1897 order recites that "no steps were taken to carry out the directions of the Order". Surveyor General Deville's memos of 1896 and 1897 and Nicholson (1964, pp. 75, 77) agree.
  - **Open point:** the Commons Journals for 1896–97 were not searched directly.
  - **Reconciling this with the 1897 Keewatin:** the 1897 order annexed a full description of a *provisional* district of Keewatin, as it did for the other eight. The Minister of Justice advised in 1898 that provisional districts needed no statute, and the 1918 order recites the 1897 order as having defined "the provisional district of Keewatin". So statutory Keewatin (1876 limits, re-annexed in 1905) and provisional Keewatin (1897–1919) coexisted, which Deville called "two Districts of Keewatin". The 1897 row's note says so.
  - **Rendering:** a row with confidence of 0.75 or more is not drawn as approximate, so these citations don't grey out whole districts.
- **NRCan's drawing ships as a reference overlay for those five only.**
  - The file gains an optional `references` list: id, NRCan name, contrasted unit, source, attribution, validity and geometry ref. The geometry lives in the same topology.
  - A change's `nrcan_overlay` names NRCan polygons for a year, optionally clipped to an expression (Ungava's islands; Nottingham Island) and optionally ending early (`until`: NRCan separates the Arctic islands from 1870).
  - The app's "NRCan drawing" toggle (Atlas group) is off by default. It draws a dashed outline and adds the OGL attribution.
  - The five `nrcan_te_*` years become atlas inputs in `artefacts.yaml`.
- **Dates are the day the instrument took effect,** with `dateConfidence` on the event (schema field added) and the alternative in the note:
  - **Ontario's provisional line: 1874-07-09.** Ontario's approving order was the last of the matching orders (memorandum 26 June, Dominion order 8 July). Confidence 0.8.
  - **Manitoba enlarged: 1881-07-01.** 44 Vict. c. 14, s. 4 and the proclamation of 13 June 1881 (Canada Gazette, 18 June 1881, pp. 1775–76). The 23 December date is found in no Gazette. Confidence 0.95.
  - **Labrador: 1927-03-01,** the day the report was delivered; approved in Council on 22 March, not 11 March. Confidence 0.9.
- **Schema:** `AtlasEvent.dateConfidence`, `AtlasUnit.instrument` and `AtlasUnit.rationale`, and `AtlasFile.references` are optional additions. The atlas stays `v1`, by the same rule as RegionPack.
- **Labrador before 1927 is unchanged** until Sitting C.

## 2026-09-16 — Sitting B: the atlas back to 1670

- **The drawing rule from Sitting A carries back:** the instrument where its text is clear, NRCan
  where the text is silent or the claim is disputed. Every pre-1867 row cites its instrument, gives
  a one-sentence rationale and a confidence.
- **NRCan's comparison cannot reach this era.** Its *Territorial Evolution* service publishes
  vector layers only from 1867; earlier years exist as scanned rasters only. Each pre-1867 row says
  so in the checklist rather than showing a misleading overlap figure.
- **Control points replace it.** `checks:` in `events.yaml` names a place, a date, the unit the
  instruments put it in, and the citation; `make atlas` fails if any point resolves elsewhere
  (tolerance 0.01°). There are 34, and all pass. They are the pre-1867 test.
  - One check was wrong and the atlas was right: the Magdalen Islands point `[-61.75, 47.40]` is
    open water in the Atlas of Canada 1:1M coverage; Havre-aux-Maisons `[-61.79, 47.42]` is land.
- **Rupert's Land is the Hudson Bay drainage basin,** including the bay's islands and southern
  Baffin Island. The charter names no watershed; the basin is the standard reading (Historical
  Atlas of Canada). NRCan's 1667 and 1713 plates stripe a disputed band along its southern margin;
  that band is not drawn.
- **Rows carry a sovereign** — Britain, France, England, Spain, the Hudson's Bay Company,
  Indigenous nations, Canada, and the shared forms where two powers claimed the same ground.
- **The de facto layer for this era is fur-post catchments and settlement belts,** from
  `pipeline/atlas/defacto.yaml`: 94 posts with their open periods, the power holding them and a
  tier that fixes the catchment radius (bay factory 60 km, depot 80 km, post 50 km, outpost 25 km,
  French Great Lakes 50 km, French west 40 km, Pacific 30 km), and 22 settlement belts with their
  own widths. These are deliberately coarse: they show reach, not control. Every de facto row
  carries an explicit confidence and the layer is off by default.
  - Annotations do not carry across an `alter`, so each de facto row restates its confidence. That
    is by design: a row that changes shape has to re-justify itself.
- **Four new geometry operators:** `buffer`, `near_coast`, `posts`, `belts`.
- **Open questions, not decided here:**
  - **Interior Labrador, 1763–1867, has three incompatible readings** — NRCan's 1974 plate
    (Quebec/Lower Canada), the JCPC's 1927 judgment (Newfoundland, the whole watershed), and
    Sitting A (Rupert's Land). The atlas keeps Rupert's Land; Sitting C draws the overlap hatched.
  - **The "two Districts of Keewatin" phrase is Surveyor General Deville's (1899)**, not the
    Minister of Justice's; the 1897 row's note is corrected.
  - **British Columbia's capital on 1 July 1867 was New Westminster;** Victoria from 1868-05-25,
    which is now its own event.

## 2026-09-16 — Sitting C: the contact frontier, and claims as claims

- **The contact frontier is our own data, in `pipeline/atlas/contact.yaml`,** not a traced map.
  Each of its 65 entries is a year, an area expression and a source. A place takes the **earliest**
  year of every entry covering it, so entries compose in any order and the file survives being
  edited by hand for years.
  - **A basin entry therefore carries its interior's *latest* date,** with coasts, rivers, islands
    and posts layered on as smaller shapes that cut through. The opposite convention dates the
    interior of northern Ontario a century early with no way to correct it.
  - **The 25 StatCan drainage regions partition modern Canada,** so "every hex has a year" is a
    property of the data rather than a hope. Measured: the bands cover 9,652,844 km² against
    Canada's 9,650,830 km².
  - **Reconstructed journey corridors are deliberately absent** — Hearne 1770–72, Henday 1754–55,
    de Troyes 1686, Albanel 1672. The years are solid; the routes are argued over (Hearne's own
    longitudes were badly out), and drawing them from prose would be tracing a guess. The interior
    takes its basin's later, documented date until a published route map can be used.
- **The caveat ships with the data and the schema requires it.** `ContactFile.caveat` is not
  optional, and the app shows it with the layer: "first contact" is a European frame, contact
  usually arrived before Europeans did (the smallpox epidemic of 1780–82 moved along Indigenous
  networks into country no European had visited), and the dates are uneven in kind.
- **`first_contact_year` is a per-hex column in attrs** (measure, unit `year`, 0 where no entry
  covers the cell's centre), so Phase 3 can use it as a lens.
- **The contact frontier is its own artefact pair** (`contact.v1.json`, `contact.v1.topojson.gz`),
  not part of `atlas.v1`. mapshaper snaps coincident points across everything in one topology, and
  a band's edge is not a boundary: it must not be allowed to move one. The same argument applies to
  a claim line, but claim rows are units with a validity range, so they stay in the atlas.
- **Claims are not clipped to Canada.** `clip:` on a change is `canada` (the default),
  `north_america` (Canada with the United States and Greenland) or `none`. Most of the ground in
  these disputes is now American or Greenlandic; clipping a claim away would draw the dispute as if
  it had already been settled our way.
- **A `dispute:` id groups the claim rows of one dispute,** so the map can say whose claim a hatch
  is instead of hatching every claim identically.
- **Claims are hatched, never filled.** A flat fill says "this is how it was"; a hatch says "this is
  a statement about a claim". The pattern is installed into Leaflet's overlay pane
  (`app/src/map/patterns.ts`), which has no API for pattern fills.
- **Native Land stays gated.** The permission flag is read from `pipeline/artefacts.yaml` at build
  time, so the pipeline and the app cannot disagree about it. Until it says `granted`, nothing of
  theirs is fetched or shipped, the pre-contact base is plain, and it says why — an empty country
  with no explanation would be its own kind of claim.
- **The timeline's start is 1000, 1497 or the contact frontier,** defaulting to 1497. Before the
  first event of 1670 the atlas has no units, which is the point: that is where the pre-contact
  base and, with "frontier", the moving contact line do the talking.
- **The Alaska panhandle claim is not drawn, and the atlas says why.** The 1825 convention fixes no
  coordinate between 56°N and 141°W ("la crête des montagnes", "les sinuosités de la côte"), and
  the 1903 tribunal answered by marking a map, so the Canadian claim survives only on Map 37 of the
  British atlas filed on 23 September 1903. A ±5–10 km tracing of that map is the one thing this
  atlas refuses to do, so the 1903 event carries the explanation instead of a polygon.
- **Hans Island's 2022 division is in the row, not the picture.** The Greenlandic part is about
  0.57 km², under the 2 km² minimum that keeps thousands of Arctic islets out of the display
  topology, so both Nunavut rows share one drawn polygon. The event, its date and its instrument
  are what the artefact carries.

## 2026-09-16 — Native Land declined; an in-house Indigenous language-family layer

- **Native Land Digital is declined permanently, not pending.** The flag in
  `pipeline/artefacts.yaml` says `declined` and `make dry-run` fails on any other value. The two
  source rows, `download.py`'s gate, the app's loader (`nativeLand.ts`), the Vite define and the
  devcontainer secret are gone; the terms note stays under "Not cleared" in
  `docs/data-sources.md`. The permission request was never sent and is marked superseded.
- **The replacement is built from open sources we can redistribute:** the 2021 Census Profile
  (Open Licence), Glottolog 5.3 (CC BY 4.0) and Wikidata (CC0).
- **A family is a Glottolog top-level family or isolate.** Each of the 70 census languages is
  matched to one Glottolog languoid in `pipeline/atlas/language_families.yaml`, which cites that
  languoid on every row, and pytest checks each glottocode's family against the downloaded table.
  Using Glottolog's families for the census as well is what lets the two sources fill one column
  without disagreeing about what "Salish" means. Two consequences worth knowing: Tlingit sits with
  the Dene languages (Athabaskan-Eyak-Tlingit), and Michif is Algonquian (Glottolog 5.3 files it under
  Plains Cree).
- **Census ids 386–475 are each accounted for exactly once:** 70 languages (fetched), 18 subtotals
  (not fetched, so no speaker counts twice), and 2 residuals, "Indigenous languages, n.i.e." and
  "n.o.s.", which name no family and are not assigned one.
- **The map says "Inuit", not Glottolog's "Eskimo-Aleut".** The Glottolog name is kept in the data.
- **Census cells:** each CSD's single-response speakers by family, spread over its cells with the
  labour-force weights (population share, area share where the CSD has no people in the mesh), the
  largest family wins, ties to the lower code. Confidence 0.7.
- **Glottolog cells:** every language with `CA` among its countries and coordinates, extinct and
  dormant ones included (Beothuk, Laurentian), seeds its cell; unassigned cells take the nearest
  seed by shortest path over the mesh graph, edges in great-circle km. Confidence 0.3. Points more
  than 100 km from every mesh cell (languages listed for Canada but located in the United States)
  seed nothing.
- **Deviation from the brief: sea crossings.** The mesh graph has no edges over salt water, so it
  is 50 components; the mainland is 89% of cells, and graph distance alone reaches about 91%, short
  of the 95% bar. Rather than lower the bar, the fill joins components by their closest pair of cell
  centres (Borůvka, ties by cell index), weighted like any other edge. That is still a distance over
  the mesh, and it is the only way Baffin Island or Newfoundland has a nearest language at all.
- **The caveat is a literal in the schema** (`INDIGENOUS_CAVEAT` in `app/src/schema/indigenous.ts`).
  The app renders it from the schema, the pipeline writes the same text from
  `language_families.yaml`, and pytest checks the two against the exported JSON Schema.
- **The layer is its own artefact pair** (`indigenous.v1.json`, `indigenous.v1.topojson.gz`),
  built by the `layers` step from the attrs column: one area per family and source, clipped to
  Canada. Hex edges are left visible on purpose: they show the resolution the method has.
- **Both Indigenous layers draw automatically before the atlas begins** (the pre-contact base) and
  can be switched on at any date from the layers menu's new "Indigenous" group.
- **Colour:** the eight largest families take the eight categorical slots; Haida, Ktunaxa and Beothuk
  share a neutral fill. A choropleth puts every pair of families side by side, and eight hues cannot
  keep every pair apart for every reader, so every area carries its family's name on the map, in its
  tooltip and in the legend. Census areas are drawn solid and Glottolog-filled areas faint, so
  confidence is visible.
- **Community labels are Wikidata's, and uneven.** First Nation bands have a class; Inuit
  communities are selected by region (Nunavut, Nunavik, Nunatsiavut) plus the six Inuvialuit
  communities by item; Métis land bases are the eight Alberta Métis Settlements by item. The query
  and its reasoning are in `pipeline/atlas/indigenous_communities.rq`. They also go into attrs as a
  side table, `indigenous_community_ids` (Wikidata item numbers per cell). Names appear from zoom 6.
- **Numbers from the first build:** 1,809 cells from the census and 36,623 from the Glottolog fill
  (0 unassigned of 38,432); 72 Glottolog seeds, 10 more dropped as beyond 100 km of the mesh
  (Cayuga, Chippewa, Dakota, Lakota, Mohawk, Munsee, North Alaskan Inupiatun, Potawatomi, Seneca,
  Tuscarora); 49 sea crossings, the longest 112 km; median fill distance 281 km. Of 1,172 populated
  cells with Indigenous mother-tongue speakers (by `indigenous_language_share`), 1,069 take their
  family from the census and 103 from the fill: the DA data counts speakers there, but the CSD
  language counts are rounded to zero or fall in the n.i.e./n.o.s. residuals. 642 Wikidata
  communities (2 rows without an English label skipped).

## 2026-09-16 — Phase 3 Sitting A: the splitter engine

### Deviations from the brief
- **The PRNG is canonical mulberry32, not a copy of the township generator's.** That project is not
  on this machine or in the GitHub account, so there was nothing to copy or cross-check. The
  implementation is the published reference (`Math.imul` and unsigned shifts only), and
  `app/src/engine/fixtures/mulberry32.json` pins its first 8 outputs for 5 seeds. **Open:** the
  township generator should assert the same fixture; until it does, "same sequence as the township
  generator" is assumed, not tested.
- **Sea crossings in the solver graph.** As in the language-family fill, the mesh graph is 50
  components, and hard contiguity would otherwise make every island its own region. The scope
  graph joins components at their closest cell centres (Borůvka) and marks those edges: they
  connect a region, and they do not count as boundary length. Canada gets 49, the same as the
  pipeline's Python.
- **Test (a) runs 5 seeds × 3 methods on Alberta** with shortened refinement (10–30k moves), so the
  golden test stays under 4 s. Methods: balanced (N=10), lens on `french_share` (N=4), random cuts
  (N=15). Hashes are in `app/src/engine/golden/alberta.json`; regenerate with
  `UPDATE_GOLDEN=1 npx vitest run src/engine/solver.test.ts`.

### Determinism across engines
- **Only operations IEEE 754 fixes to the bit.** +, −, ×, ÷ and `Math.sqrt` are the same bits on
  every engine; `Math.exp`, `Math.cos`, `Math.pow` and `**` are not required to be. One differing bit
  in an annealing acceptance and iPad and desktop diverge for good. So the engine uses `detExp` and
  `detCos` (`app/src/engine/detmath.ts`: fixed-length series, exact doubling), squares by
  multiplication, and random directions from two uniforms normalised by `sqrt`.
- **Order is fixed by cell id.** Local indices follow mesh order, which is H3 id order; heaps and
  searches break ties by index.
- **`maxMs` is the one non-deterministic control.** It is a wall-time safety cap. A run that hits it
  reports `stoppedBy: 'time'` and is not reproducible; the tests assert that no run hits it.

### Model choices
- **Cost terms are normalised so weights compare:** balance Σ((L−T)/T)²/N; compactness = cut edges ÷
  all edges; lens = within-region sum of squares of standardised lens columns ÷ total; snap = −cut
  snap edges ÷ snap edges (the hook is in; the layers arrive in Sitting B); soft contiguity = extra
  pieces ÷ N.
- **Initialisers:** `lens` splits the most heterogeneous region into equal halves along its lens
  principal axis (N and N+1 nest); `balanced` and `random: 'cuts'` use quota bisection (a region
  that must become q regions splits ⌊q/2⌋ : ⌈q/2⌉ by load, along its geometric axis or a random one),
  which balances non-power-of-two N; `seeded` grows from capitals or load-weighted seeds; `random`
  (Voronoi) grows from uniform seeds without balancing; `template` loads an assignment.
- **Contiguity check:** a move keeps its region whole if the moved cell's neighbours in that region
  touch one another (no search). Otherwise one search front starts per group of neighbours, the fronts
  advance in turn and merge when they meet, and a front that runs out proves a split. The cost is
  about twice the smaller side, not the region.
- **Annealing:** linear cooling from 0.02 × the mean size of 400 sampled moves to a thousandth of
  that. A sweep on Canada by population found 0.5 and 0.1 stay hot so long that N=20 plateaued at
  max/min 2.7 and 2.3; 0.02 reaches 1.01 (N=10) and 1.04 (N=20). The plateau stop only applies in
  the second half of the schedule, because hot moves wander above the best on purpose.
- **The worker advances in chunks,** each a separate task, so `cancel` lands between chunks. The host
  (`app/src/engine/protocol.ts`) is plain code with injected `post` and `schedule`, tested without a
  Worker.

## 2026-09-17 — PRNG reference and the cross-engine determinism gate

- **The standard mulberry32 and its pinned fixture are the reference from now on**
  (`app/src/engine/prng.ts`, `app/src/engine/fixtures/mulberry32.json`). Anything that claims to
  share Meridian's random sequence, the township generator included, conforms to that fixture; the
  open question from Sitting A ("same sequence as the township generator") is closed that way.
- **The determinism gate is a test, not a two-device check.** `npm run determinism -w app`
  (`app/tests/determinism/engines.spec.ts`) bundles the engine with esbuild, launches Chromium,
  WebKit and Firefox, runs two fixed cases on the committed mesh (Alberta, bisect, N=15; Canada,
  equal population, N=10; seed 20260917; `src/engine/testing/determinismCases.ts`) and asserts
  identical assignment hashes in all three, equal to `src/engine/golden/cross-engine.json`. Vitest
  asserts the same hashes in Node. It runs in CI after the smoke tests. First run: all three
  engines and Node agree, which confirms the `detmath` approach.
- **esbuild is now a direct dev dependency** (pinned 0.28.2, the version already installed through
  Vite and tsx), because the gate imports it.

## 2026-09-17 — Phase 3 Sitting B: the Generate panel, constraints and presets

### Pipeline inputs for the splitter (`pipeline/splitter_inputs.py`, built by the layers step)
- **`places.v1.json.gz`:** the gazetteer (4,830 populated CSDs, each with a representative point and
  mesh cell) and 40 CMAs with their cells. **A cell belongs to a CMA through its mesh CSD**, and a CSD
  to the CMA holding its point. Testing cell centres instead cost Toronto 1.2 million people, because
  its waterfront hexagons have their centres in Lake Ontario. Ottawa–Gatineau's two provincial parts
  are one CMA.
- **`cells.v1.topojson.gz`:** every mesh hexagon as one topology (1.44 MB gzipped, quantised to
  about 70 m), so the app dissolves regions by dropping shared arcs. Every hex edge is its own arc
  (each vertex is where three cells meet).
- **`snap.v1.json.gz`:** 11,373 mesh edges whose centre-to-centre segment crosses a Strahler 7+
  river. The other snap layers are partitions the app compares directly (basins, ocean drainage for
  the Continental Divide, treaties, CD, CSD, 0.5° graticule, ridings, ecozones). **Township lines are
  listed but unavailable:** there is no Dominion Land Survey data in the pipeline.
- `places` and `snap` are gzipped like the mesh; `data/build` is 7.6 MB, under the Phase 1 budget.

### Engine additions
- **Population limits and pins are penalty terms,** weight 10 when set: people outside [min, max]
  ÷ total population; keep-together cells not with their group's first cell ÷ pinned cells, plus
  keep-apart pairs sharing a region ÷ pairs. Unused, they are exactly zero and leave every golden hash
  unchanged. The result reports remaining violations.
- **Capitals can be points** (`capitalPoints`), each resolved to the nearest scope cell, so a pack's
  recipe survives a mesh change.
- **Seeded growth without a balance target grows by distance alone.** It previously balanced by load
  whatever the setting.
- **Region stats are a standalone function,** so painting recomputes them.

### App
- **A split is a `SplitSpec`** (`app/src/splitter/split.ts`): scope, date, method, N, seed, lens,
  balance, contiguity, capitals, limits, pins (as CSD uids), carve-CMA-first, snap layers, weights and
  iterations. The panel edits it, the share link carries it, and a pack's `meta.params` holds it.
- **Lenses** (`lenses.ts`): shares, measures and money are used as they are; categorical ids become
  0/1 indicators; GDP per capita, growth since 2016, primary-industry share and a density rank are
  derived. **Internal-colony index** = the mean of three ranks within the province: distance from
  the capital, primary-industry share, and sparseness (1 − density rank). Ranks use sorting only, so
  lens columns are identical on every engine.
- **Carving CMAs** takes every CMA above a population threshold (default 1,000,000) wholly inside the
  scope, removes its cells from the solve, and adds it as its own named region.
- **Region names** come from the CSD with the most people inside the region; names are unique (a city
  split three ways names one region, and the next becomes, say, "Calgary (2)"). Seeded regions with
  named capitals take the capital's name.
- **Colours:** the eight categorical hues, assigned greedily so neighbours differ. Colour does not
  identify a region on its own: every region is named on the map and in the legend.
- **Manual painting** writes `meta.edited` and `meta.edits` (H3 id, from, to) into the pack; the
  RegionPack schema gained both as optional fields. A share link reproduces the split without edits.
- **Re-fit across mesh versions** (`fitPack`): same mesh → the assignment as it is; another mesh →
  regenerated from the pack's seed and params; edited on another mesh → refused with the reason.
- **Share links** are `#split=<base64url spec>` or `#pack=<id>`, followed on load and on hashchange.

### The three presets (`app/src/splitter/presets.ts`, `npm run presets -w app`)
- **alberta-15:** Alberta, lens bisection on the Economic preset, N=15, seed 15, balanced by
  population.
- **canada-26:** Canada, lens bisection on the internal-colony index, N=26, seed 26. Population is
  deliberately unbalanced (largest/smallest 174): the lens, not the head count, drives the cuts.
- **canada-14:** growth from the 13 provincial and territorial legislatures **and Ottawa**, which
  makes 14. No balance target and **no refinement:** with nothing to balance, annealing optimised
  compactness alone and traded whole cities for shorter boundaries (Edmonton's region lost Edmonton).
  Each region is the land nearest its capital over the mesh.
- Each pack records its full spec; `src/splitter/presets.test.ts` regenerates all three and fails if a
  committed pack no longer matches. They are also the test cases for the loader, the library, share
  links, re-fit and edit recording.

## 2026-09-17 — Phase 4: dossiers and set analysis

### Borders in words
- **Each boundary arc is one hexagon edge with a cell on each side,** so "what does this follow?" is a
  question about two cells: a different province, a river crossing between them (named, from the snap
  artefact), the Continental Divide, a drainage divide, the edge of a treaty area or an ecozone. Runs
  that follow nothing get a second look as a run: a long flat stretch is a parallel or a meridian, and
  what is left is open country, named by the nearest town.
- **The pipeline's snap artefact now carries the river's name per edge** (549 named rivers over 11,373
  crossings), because "the Athabasca River" is the useful sentence, not "a river".
- **A surveyed line and a line this tool drew are not the same claim.** On the edge of the mesh a flat
  run is "the 49°N parallel (the international boundary)". Inside the mesh it is "about 49°N": the
  split drew it, and it must not borrow the authority of a line someone surveyed. The first draft said
  "the 49°N parallel" for both, which was wrong in southern Alberta.
- **Runs under 45 km fold into their neighbours,** and neighbours that say the same thing merge. At 60
  km the rivers disappeared from the Alberta set, which the golden test exists to catch.
- **Township lines are in the classifier's vocabulary but never emitted:** there is no DLS data
  (docs/backlog.md).
- **Golden (Mark, 2026-09-17):** alberta-15 must name a parallel or township line, a river and a
  provincial border, correctly — Alberta's real neighbours, real river names, parallels between 49°N
  and 60°N, and the 49th parallel marked as the international boundary.

### Names
- **A name comes from the ground:** the river running through the region, its drainage basin, its
  ecozone, its Inuit region, or the province with a direction. Ties are broken by the pack's seed, and
  names are unique within a set.
- **Indigenous names are never applied to a region without an Indigenous-majority population.** It is a
  hard gate in `candidates()`, not a weighting, and `namesRespectIndigenousRule` is asserted for all
  three presets.
- **Chosen names win:** a seeded region keeps its capital's name, a carved metro keeps the CMA's, and a
  manual rename beats both and is kept in the pack.

### Written fields
- **The style rule:** one sentence, concrete, and no adjective that could apply to any region. Every
  line is built from that region's own numbers and names; `VAGUE_WORDS` lists what a generated line
  may not say, and the tests hold every line to it, to one sentence, and to containing a number or a
  name.
- **Every templated line carries `placeholder: true` and opens with ⟨draft⟩,** in the app and in the
  Markdown export, so a draft is never mistaken for written prose.

### Set analysis
- **Power ranking** = 0.5 × GDP share + 0.3 × extractive-labour share + 0.2 × chokepoints, where
  chokepoints are the boundary runs a major river or a provincial border crosses (rivers and borders
  stand in for infrastructure until there is a highway and rail layer).
- **Reconciliation compares the regions with the scope cell by cell,** and `ok` allows a rounding
  difference of one person.
- **Federalism rules live in `app/src/dossier/federalism.yaml`,** one entry per rule with the
  instrument and section it comes from, and a named evaluator. `npm run rules` compiles it to
  `federalism.rules.json`, which the app, Vitest and the presets script all import; `npm run
  rules:check` keeps them in step in CI. Vite's `?raw` import would not have loaded under tsx or Node.
  Six rules: Senate divisions, the 7/50 formula, equalization, Quebec's asymmetry, territorial status,
  and the senatorial floor. A verdict is `holds`, `strained` or `breaks`, and says what the instrument
  requires and what the set does — it is not legal advice. Provinces-as-regions holds the three
  structural rules, which is the test that the panel is not just saying "breaks".
- **GDP carries its allocation caveat everywhere it appears:** dossier, set panel, Generate panel, map
  tooltip and Markdown.

### Compare mode
- **Regions are matched by overlap, greedily and largest first,** so "reassigned" means cells that
  changed hands between matched regions, not cells whose region has a different number. Actual Canada
  (the 13 provinces and territories) is always available as the other side.
- **The swipe divider clips the two map panes** (`clip-path: inset(...)`), with a draggable handle and
  arrow-key support; the panel has a slider for the same value.

### Packs
- A pack now carries every region's dossier and the set analysis, and the region's name comes from the
  dossier. `buildPresetPack` is the one path that builds a preset, used by `npm run presets` and by the
  test that regenerates them, so the script and the test cannot drift.
