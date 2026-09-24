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

## 2026-09-24 — Disk: `make verify` without the Canada1Water zips

The Codespace disk was at 90% (3.0 GB free of 32 GB). The eight Canada1Water Strahler zips in
`data/raw/nrcan_c1w_strahler_*` were 10.1 GB of it, and `make verify` needed all of them because the
rivers layer (`polygons.py`) extracted every regional GeoPackage on every build. The atlas's three
river regions already came from a cache in `data/raw/.cache`.

- **Options.** (a) Keep the zips on disk permanently and find 10 GB elsewhere; (b) verify the rivers
  from a committed hash of an intermediate reaches file, so the zips can be deleted between runs.
- **Chosen: (b).** Nothing else on the disk is that size: the caches cleared held 0.5 GB, the
  Playwright browsers (1.3 GB) are all used by the determinism gate, and `/tmp` (41 GB free) is the
  Codespace's ephemeral disk, lost on a rebuild, so it cannot hold inputs "permanently".
- **How.** `common.cached_intermediate(name, produce)` keeps an intermediate in `data/raw/.cache/` and
  its SHA-256 in the committed `pipeline/intermediates.sha256`. A cached file must match its hash; with
  no cached file, `produce()` reads raw and the result must match the hash too; a name with no hash yet
  is recorded, to be committed with the build. The rivers layer now reads the Strahler ≥ 7 reaches of
  all eight regions through it (`c1w-reaches-<key>.json.gz`, 58 MB, keyed by the eight zips' manifest
  SHA-256 and the threshold), and the atlas's per-region river caches go through it as well.
- **Proof.** Rebuilt from the zips through the new path, `layers/rivers.v1.topojson.gz` is byte-identical
  to `SHA256SUMS` (`416017d9…`). The zips were then deleted and `make verify` run without them.
- **What this gives up.** `make verify` now proves the rivers layer from the intermediate, not from the
  zips. Re-proving the intermediate needs the zips again (`make download`, 10 GB): delete
  `data/raw/.cache/c1w-reaches-*.json.gz` and rebuild, and the new file must hash to the committed
  value. A new Canada1Water release changes the manifest SHA-256, so the key, so the file name: it can
  never be satisfied by a stale cache.

## 2026-09-24 — Phase 5: export, import, interoperability

### Shared packs
- **Location: a top-level `packs/` folder in this repo,** each pack named `<slug>.<meshVersion>.json`
  (`alberta-15.v1.json`), listed in `packs/index.json`. The three presets moved there from
  `app/public/packs/`. The app fetches them by the relative URL `packs/<file>`: a small Vite plugin
  serves the folder in dev and copies it into the build. Other projects use raw.githubusercontent.com
  URLs, on `main` or pinned to a tag (docs/interop.md).
- **The RegionPack v1 contract, its versioning rules and migrations live in `docs/interop.md`.** New
  rules: a new mesh is a new `meshVersion` whose files sit beside the old ones, which are never
  deleted; pack names carry the mesh version; consumers check `meshVersion` before drawing.
- **The interop example draws a pack with the pack and `cells.<meshVersion>.topojson.gz` only:**
  `topojson.merge` dissolves each region's cells. No per-pack GeoJSON has to be kept in step.

### Export (`app/src/export/`, the Files tab)
- **Region geometry is dissolved from the hex topology by arcs:** a region's boundary is the arcs its
  cells use once; on a hex mesh every vertex has zero or two of them, so they chain into simple rings.
  Holes are found by nesting (a ring inside an odd number of the region's other rings), not by walk
  order, and rings are wound by the right-hand rule, so geojsonhint passes with no messages.
- **An arc a region uses twice is interior, and a ring with no area is dropped.** The cell topology
  stores a few edges as two identical arcs; walked, they made zero-area spikes that geojsonhint rejected.
- **TopoJSON reuses the cell topology's arcs** (re-indexed, same quantization), so a border between
  two regions is one arc.
- **GeoJSON, TopoJSON and KML carry flat headline fields** (`regionId`, `name`, `capital`,
  `population`, `areaKm2`, GDP with its caveat, …) plus the whole dossier where the format allows it.
- **KML layout:** styles, then a folder per region (its polygon, and its capital as a pin), then a
  folder of dividing lines, one placemark per pair of neighbours. The capital pin is the gazetteer
  place of the capital's name inside the region.
- **SVG** is drawn in Statistics Canada Lambert (EPSG:3347's parameters on the sphere), with labels at
  the region's cell nearest its mean centre, a legend with populations, a scale bar true at the map's
  centre latitude, a date stamp (made, atlas date, mesh, seed) and the Open Government Licence
  attribution. **PNG** is the SVG drawn onto a canvas at twice its size.
- **Markdown follows the Region panel:** `dossier/fields.ts` lists the facts in order, and the panel
  and the Markdown both render that list; a test walks the rendered panel and finds every block in the
  Markdown in the same order, with the same number of ⟨draft⟩ marks. The panel gained the one fact
  only the Markdown had (mean distance to the provincial capital).

### Import (`app/src/import/`)
- **A pack from another mesh is re-fitted or regenerated, the user's choice.** Re-fit gives each cell
  of this mesh the region of the old mesh's nearest cell centre (within 30 km); it keeps hand edits and
  template splits, and needs the old mesh, fetched from `data/build/` on GitHub. Regenerating reruns
  the recipe, which only an unedited pack has.
- **GeoJSON and KML import by majority overlap,** sampled: a cell's centre and six points 60% of the
  way to its corners. A cell mostly outside the polygons stays out; otherwise it goes to the polygon
  holding most samples. KML goes through @tmcw/togeojson, whose GeometryCollections (a MultiGeometry
  of several polygons) are read as one region.
- **An imported map can also be a snap layer** (edges whose cells fall on different sides) or **a
  scope** (the polygons' union as a `polygon` scope). The snap layer is session-only.
- **A template split has `method: "template"` and no recipe:** its names are kept as chosen names, and
  it has no share link.

### Save, load and share
- **The pack library is IndexedDB, and every call returns a value, never throws.** With storage missing
  or refused, the Files tab says so and offers downloads; the rest of the page is unaffected (unit test
  with IndexedDB absent or throwing; smoke test with `window.indexedDB` throwing).
- **Share links only for splits a link can reproduce:** not after hand edits, not for template or
  re-fitted splits, not with an imported snap layer. The button is disabled with the reason.

### Tests that replace the manual gate
- KML validates against the vendored OGC KML 2.2 schema (`xmllint-wasm`, offline; the xAL import points
  at the local copy) and re-parses through @tmcw/togeojson to the original cells, for alberta-15 and
  canada-26. GeoJSON passes geojsonhint; GeoJSON, TopoJSON and the pack come back as the same cells.
- Re-fit: a synthetic v2 mesh (1% of cells dropped, 1% added between neighbours, every centre moved by
  up to 2 km, cells reordered) keeps over 98% of alberta-15's population in the same region.
- The docs/interop.md snippet runs as written in Playwright, its network served from this checkout,
  and draws one layer per region with the region's name on hover.

## 2026-09-24 — Phase 6: scenarios and game hooks

Decisions from the brief (Mark): scenario overlays are YAML applied after the base event list, base
events carry `requires:` and are skipped with a visible notice when unmet, a scenario is saved in the
pack, the UI has a scenario badge and a diff against the base at any date; nesting stores parentPack
and parentRegionId and exports the tree as one JSON; one non-geographic overlay ships (immigrant-share
halos over CMAs) and the rotational-workforce flows wait in `docs/backlog.md`; the presets are
Newfoundland independent 1949 and Buffalo 1905; and the score object and `meridian.getScores` are
defined in `docs/interop.md`, with a House of Cards worked example.

### Divergence mode (`app/src/scenario/apply.ts`)
- **A scenario replays the event list; it does not patch the resolved map.** Base and scenario events
  are merged by date, the scenario's after the base's on the same date ("applied after the base event
  list"). The result is an atlas of the same shape, so the map, the timeline, the unit panel and the
  Generate panel's atlas scopes run on it unchanged; the store keeps the base beside it for the diff.
- **Every unit row is explained by an event change** (checked: 148 of 148 rows start and end on one),
  which is what makes a replay possible. Replaying the base with a scenario that does nothing gives the
  base's rows exactly, in the same order; the test asserts it.
- **Preconditions are explicit and implicit.** Explicit: a base event's `requires` (unit, and its
  `exists`, `status` or `sovereign`, with `because`). Implicit: an alter, rename or dissolve needs its
  unit to exist, a create needs it not to. A base event that fails either is skipped whole, and the
  notice gives each reason and each `because`. A scenario event that fails is an error: the scenario is
  broken, not the history.
- **A base change is applied as a delta:** the fields that differ between the base's rows either side
  of it. A later base event that only redraws a boundary keeps the scenario's status and sovereign.
- **`requires` lives in `pipeline/atlas/events.yaml` and passes through the build into `atlas.v1.json`**
  (optional `AtlasEvent.requires`; the atlas stays v1). The build fails if the base does not meet one of
  its own preconditions. Two events carry one: 1949 (Newfoundland joins) requires Newfoundland under
  Britain, which it was under Commission of Government; 2001 (the renaming) requires it under Canada,
  since only a Canadian amendment could rename a Canadian province. `atlas.v1.topojson.gz` is unchanged;
  `atlas.v1.json` is `0edd7ad7…`.
- **A new status, `dominion`,** for a self-governing unit outside Canada. The base atlas does not use it:
  it keeps Newfoundland as `colony` throughout, as decided in Sitting A.
- **Scenario geometry comes only from the base's drawings:** a base unit as it stood on a date, or a union
  of several with their shared arcs dissolved (`topologyTools(...).merge`, the TopoJSON merge), so a
  scenario never draws a line of its own. Buffalo is Alberta and Saskatchewan of 1905 without 110°W.
- **"Resolves cleanly"** (`checkScenario`): every row has a drawing, no unit has two rows at once, and at
  every event date and today the de jure units cover the same area as the base's within 0.5%.
- **Buffalo does not skip the 1905 event; it undoes part of it on the same day.** The base creates Alberta
  and Saskatchewan, re-annexes Keewatin and dissolves the districts; the scenario, applied after, dissolves
  the two provinces and creates Buffalo. A row that starts and ends on one date never existed, so neither
  province appears, and Keewatin's and the districts' changes still happen. Skipping the base event would
  have lost them.
- **Newfoundland's change is dated to the referendum,** 22 July 1948, not to a transition the atlas has no
  instrument for; the premise says so. A later date would have to precede 31 March 1949 anyway, for the
  1949 precondition to fail.
- **Scenarios are YAML in `docs/scenarios/`,** compiled by `npm run scenarios` into
  `app/src/scenario/scenarios.json` and checked in CI (`scenarios:check`), as the federalism rules are.
  Each event cites its sources; the schema is `docs/schemas/scenario.schema.json`.
- **UI:** a Scenario tab (choose, premise, "resolves cleanly", the diff on the timeline's date, skipped
  events with their reasons, the scenario's events with sources); a badge over the map with the number of
  skipped events and a way back to the record; the scenario's ticks on the timeline in its colour; a
  "skipped in this scenario" notice in the Details tab where the record would have had the event; and the
  record's removed or redrawn units outlined dashed on the map (on by default, a checkbox in the tab).
- **A pack made in a scenario carries the whole scenario** (`meta.scenario`), captured when the split was
  made; loading the pack restores it. A pack whose scope is read from the atlas and that names no scenario
  brings the record back.

### Nesting (`app/src/splitter/tree.ts`)
- **The parent is the scope.** A nested split's scope is `{kind: 'region', pack, region}`, and its pack
  records the same pair as `meta.parentPack` and `meta.parentRegionId`. Packs gained `meta.id`: a preset's
  slug, or `split-` and an FNV-1a hash of the recipe and the cells.
- **One region has at most one child split;** splitting it again replaces the child and everything under
  it. Anything that is not a region of a split in the tree starts a new tree.
- **The tree is one JSON: the root pack with `children`,** recursively (optional, so a v1 reader sees the
  root pack). Importing it restores every node; the Files tab downloads it; a breadcrumb over the Generate,
  Region, Set and Files tabs moves up the path and down to children already made. "Split this region"
  is in the Region tab.

### Overlays (`app/src/overlays/`)
- **An overlay is a definition with a pure `build` from the splitter's data,** of kind `point` or `flow`,
  drawn in its own pane above the atlas and the split. It reads no assignment, so it cannot claim cells.
- **Immigrant-share halos:** one circle per CMA (40) at its population-weighted centre, area proportional
  to population, colour a five-step single-hue ramp of the population-weighted `immigrant_share`, with the
  number in the tooltip. Switched on in the layers menu's new Overlays group, with its legend.
- The `flow` kind has its renderer and no data: the rotational-workforce table is in `docs/backlog.md`.

### Scores (`app/src/dossier/score.ts`, `docs/interop.md`)
- **`regions[].stats.score`:** population, gdp, resource_index, cohesion, exposure, each defined in one
  line in `docs/interop.md`. `stats` was a record of numbers and now also allows the `score` object; this is
  an optional addition, not a version bump, and the Migrations note says so.
- **Cohesion is 1 − 4 × the mean lens variance,** each lens column scaled to 0–1 over the scope, so it
  spans 0–1 (a 0–1 value varies by at most ¼). A split with no lens is scored on the Economic preset's
  columns. **Exposure is the dossier's dependency score** (the largest industry's labour-force share).
  **resource_index** is the NAICS 11 + 21 labour-force share.
- **A new scope, `atlasSovereign`:** every de jure unit under a sovereign on the pack's date, so "Canada
  in 1867" is one scope. The Generate panel offers it as "A country in the atlas at the current date".
- **The House of Cards entry point is a fourth preset, `dominion-1867-5`,** made by `npm run presets` from
  the recipe in `docs/interop.md`; a Vitest runs the page's `getScores` helper as written on it and checks
  the printed table. The four presets are regenerated for `meta.id` and `stats.score`; assignments are
  unchanged.

## 2026-09-24 — Phase 7: hardening and 1.0

The brief (Mark) takes Phase 7 as the plan writes it, with six additions:
1. Cross an event in under 16 ms at every step, by pre-decoding the adjacent event's geometry.
2. Offline after the first visit, with a Playwright test.
3. Keyboard-driven timeline and Generate panel, a deuteranopia-safe region palette checked pairwise,
   and focus order.
4. The two remaining scenario presets, and a line for dominion-1867-5 on Labrador.
5. The playbook, the CHANGELOG, a licences page, and a README front page drafted from the vision.
6. Release as v1.0.0.

### Performance
- **The "backlog item on event-crossing frame time" was not in `docs/backlog.md`.** Its substance is
  the Phase 2 note in `docs/perf.md`: crossings cost 13–21 ms at p95, guarded at 25 ms. That is
  what was cleared.
- **A crossing is a visibility swap** (`AtlasLayer`).
  - The rows of the three event windows either side of the current one (`LOOKAHEAD`) stay attached,
    with `display: none` on their paths. A crossing flips `display`.
  - Rows further away are detached, because hidden paths are still re-projected on every zoom.
  - What the brief calls "pre-decoding" has to include Leaflet's projection and the SVG path, not
    just the GeoJSON. Parsing was already done by the idle warm-up; attaching was the cost.
- **Refill in idle slices, budgeted by vertices** (about 2,000 per millisecond, measured 2,750).
  - While the slider moves, a row that does not fit the idle time left waits, until the slider has
    been still for 150 ms.
  - The idle request has a 250 ms timeout. Chromium was seen to declare no idle period for over
    60 s after a pan with a split on the map.
- **One path per row.** Splitting a multipolygon into one path per part, to spread its projection
  over slices, made crossings slower (the NWT of 1880 is 880 parts) and was reverted.
- **The gate is the step's work, and every step.** The frame-time test asserts the maximum, not the
  median, under 16 ms. The longest frames that remain (22–41 ms) are young-generation GC of the
  projected points while dragging at 60 years a second. `docs/perf.md` says so rather than hiding
  it.
- **The splitter's decoded data is cached in IndexedDB.**
  - It uses its own database (`meridian-decoded`), so the pack library's schema version does not
    move.
  - The key is the four fingerprinted artefact URLs, so a new build or mesh version is a new key.
    Writing one drops the others.
  - The whole `SplitterData` is stored by structured clone: typed arrays and Maps survive.
  - Every call is wrapped. Reading `indexedDB` itself throws where site data is blocked; the smoke
    test for that case caught it.
  - The cell topology is not cached. It is a validated TopoJSON, and it is the remaining cost of an
    open.
- **The worker gets the mesh once,** and each column the first time a run needs it. A template
  assignment is transferred; the result's assignment already was. The mask and snap edges are
  cloned, because the prepared split keeps using them on the main thread: transferring would detach
  them.
- **Scope graphs are cached by mask** (FNV-1a and the in-scope count, per mesh, the last four). All
  of Canada costs 300 ms on the main thread to build.
- **"Lazy-load layer TopoJSON" was already true.** The first view fetches only the atlas, and
  `data/build/layers/` never ships. A smoke test now holds both.
- **"Canvas renderer for hexes" was already true in effect.** The splitter never draws hexes one by
  one: regions are dissolved from the cell topology and drawn on a canvas renderer (Phase 3). The
  atlas stays on SVG because the claim hatches are SVG patterns.
- **Memory is measured with Playwright's iPad Pro 11 descriptor in Chromium** (JS heap after a
  forced GC, and renderer RSS), because Safari's cannot be read from Playwright. The heap is flat
  across runs, and the renderer levels off at about 690 MB. The Safari check is the manual iPad pass
  in the plan, which is Mark's.
- **Not done:** the main thread still runs about 800 ms of work when a 30-region split of Canada
  lands, mostly the dossiers. They supply the region names on the map, so deferring them would
  rename regions after the first paint. Moved to `docs/backlog.md`.

### Offline
- **A service worker written by the build** (`src/offline/sw.js` plus a Vite plugin).
  - It precaches every file in `dist`, versioned by a hash of their bytes.
  - Pages are network-first, falling back to the cached page. Build files are cache-first.
  - Cache lookups ignore `Vary` and the query string: a module script's request missed the copy
    that the install step fetched with other headers.
- **Tiles:**
  - They are requested with CORS, so the cache holds ordinary responses, not opaque ones that
    Chrome pads to about 7 MB each against quota. CARTO and OSM both send
    `Access-Control-Allow-Origin: *`.
  - The worker keeps a tile as it loads. When a view's tiles have all loaded, the map sends it the
    list for the current zoom level, and it drops the rest.
  - Only tiles someone actually viewed are kept, and none are prefetched, which stays within OSM's
    tile policy.
  - Tiles loaded before the worker first takes control are not kept. That is the first view of the
    first visit.
- **The worker registers in production builds only.** Smoke blocks service workers, except in the
  offline spec: requests a worker answers never reach `page.route`, which other specs rely on.

### Accessibility
- **Timeline:**
  - Page Up and Page Down jump to the next and previous event. A range input's own Page keys move a
    tenth of a thousand years.
  - The event ticks are one tab stop, with a roving tabindex. The arrow keys, Home and End move
    between events.
  - A visually hidden hint tells a screen reader user the keys.
- **Panel tabs follow the WAI-ARIA tabs pattern:** one tab stop, arrows, Home and End, and a
  `tabpanel` labelled by its tab. Tab moves from the row into the panel.
- **Focus:**
  - Every focusable element gets a `:focus-visible` ring.
  - A smoke test tabs through the Generate panel. It asserts that every stop is inside the panel
    until Run, and that scope, method, N, seed and Run come in layout order.
  - axe finds no WCAG 2.1 A or AA violations in any tab. It found one, the import file input with no
    label, which is fixed.
- **Painting cells stays pointer-only.** Pins have a keyboard route (the gazetteer search); painting
  a cell needs a point on the map.
- **The region palette is chosen for deuteranopia.**
  - Method: Machado, Oliveira and Fernandes (2009) at severity 1.0, applied in linear sRGB, and
    CIEDE2000 between every pair of the eight hues.
  - Four conditions: normal vision and deuteranopia, each at full strength (exports) and as drawn
    (fill opacity over the light basemap).
  - The old palette's worst pair was 3.8 (deuteranopia, as drawn), with a green and a pink that
    collapse. The best-known safe palettes (Okabe–Ito, Tol) reach only 5.5, because 0.42 opacity
    compresses everything.
  - The new palette came from a constrained search, with lightness 35–80 and chroma ≤ 65 so the
    fills stay map-like: `#004eb7 #ef8c8c #9e4d00 #f2be47 #2dbaff #80447b #7fd3d2 #006334`.
  - Fill opacity is now 0.5. Worst pairs: 20.6 normal and 13.5 deuteranopia at full strength; 12.7
    normal and 12.8 deuteranopia as drawn.
  - `palette.test.ts` asserts at least 12 in all four conditions. It first checks the CIEDE2000 code
    against Sharma, Wu and Dalal's published test pairs.
- **The language-family palette is unchanged.** It is a separate scheme: eight hues for eight
  families, a neutral for three small ones, and every area labelled, outside the brief's "region
  palette". It uses the old region hues, so it has the old pairs' weakness under deuteranopia; that
  is in `docs/backlog.md`.

### Content
- **The two presets were written by a subagent and reviewed here.**
  - **No 1912 extensions** (fork 15 May 1912). It holds for Quebec until the 1927 Labrador award and
    for Manitoba and Ontario until 1999; after that the map matches the record, and the premise
    says why. A scenario can only use base drawings. No base drawing is the 1927 Quebec less
    Labrador, or the southern part of Keewatin alone, so those cannot be drawn.
  - **Maritime Union** (id `acadian-maritimes`, fork 1 July 1867). "Acadian Maritimes" is read as
    Maritime Union, the proposal the Charlottetown Conference was called for, because a francophone
    Acadian province cut out of New Brunswick has no base drawing. PEI comes in with the others; the
    premise calls that the scenario's largest assumption. The name "Acadia" is not used: the only
    1864 use found was rhetorical, so "Maritime Province" is the scenario's own choice.
- **Decision for Mark:** holding No 1912 to today needs a scenario geometry operation `minus`, one
  base drawing less another, which still draws no line of its own. It changes the Phase 6 rule and
  `apply.ts`, so it was not done. It is in the backlog.
- **dominion-1867-5's premise:**
  - It gains one sentence: its 105 cells in today's Labrador, between 52° and 53°N, follow the
    atlas's 1867 reading of Quebec. That reading is the St. Lawrence side of the height of land, with
    only the Atlantic slope and Newfoundland's coast strip outside it, until 1927.
  - Checked against the pack and `events.yaml`.
  - Only `packs/index.json` changes; the packs are byte-identical.

### Docs and release
- **The licences page is generated from `docs/data-sources.md`** (`npm run licences`, checked in CI),
  so the doc stays the one source.
  - It covers the two tables plus the NRCan drawing's credit, which is in the notes.
  - It groups by attribution string and lists the sources each one covers: 10 strings, 53 sources.
  - It opens from the layers menu, a "Licences" link on the map's attribution line, or `#licences`.
- **The attribution line moves to the top right on narrow screens.** The iPad sheet covered it,
  OSM and CARTO credits included, which the licences test found.
- **The README front page is a draft.** The plan has Mark write it ("it is your project's voice");
  the brief asked for a draft from `docs/vision.md` that Mark may edit.
  - The honest-limits section is copied verbatim.
  - It says "built for an iPad", not "works on an iPad", until the manual pass is done.
- **The CHANGELOG has one entry per release tag.** There is no v0.1: v0.2-atlas is the first tag,
  and covers Phases 0–2.

## 2026-09-24 — Release 1.0.1

The brief (Mark):
1. Dossiers and set analysis in the worker, with the main thread never blocked for more than 50 ms
   when a 30-region Canada split lands.
2. A preset pack `acadie-2`.
3. The 1.1 headline in the backlog.
4. Mark's iPad findings: **none**, so there was nothing to fix.
5. Release as v1.0.1.

### The worker lands the split
- **The worker holds its own splitter data and cell topology.**
  - It loads them from the same URLs, through the same IndexedDB cache, and only writes the cache.
  - It does not receive them from the page: structured-cloning about 17 MB of `SplitterData`
    would be a main-thread task of its own.
  - The page sends `load` once its own copy is ready, so the worker's requests are cache hits.
- **Everything after the scope runs in the worker** (`land`): prepare, solve, finish, name, colour,
  dossiers, set analysis, scores, rings and node id.
  - The page computes only the scope mask, because atlas and region scopes need the atlas or a
    parent pack, which only the page has.
  - `prepareSplit` is now `scopeOf` + `prepareFromScope`.
  - The old `init`/`run` messages are gone. The mesh never crosses the thread boundary; this
    replaces the 1.0.0 "mesh once, columns as needed" step.
- **Splits made on the page are described in the worker** (`describe`): presets, files, trees and
  re-fits. Naming and preparing stay on the page for these paths.
  - The pack's names are shown at once. Before, describing was synchronous; now the worker's names
    arrive a moment later, and without this the legend would first show solver names. A smoke test
    caught it.
- **One description function** (`land.describe`) is used by the worker, by the preset builder and by
  the tests. The worker's result is tested field by field against the pre-1.0.1 single-thread path.
- **The landing is spread across tasks:** the message, the commit (after a yield), the fit, and the
  draw.
  - Rings cross as transferred typed arrays.
  - The fit is skipped when the split is already in view at about the zoom a fit would choose,
    because moving the map re-projects every path in one task.
  - When a painted edit invalidates the worker's rings, the map dissolves the rings itself, as
    before.
- **Not done:** painting a cell still recomputes the regions' stats and rings on the page, and a
  preset of all Canada still builds its scope graph on the page when it loads. Neither is the
  landing of a run. Memory is higher by the worker's copy (`docs/perf.md`); sharing the arrays is in
  the backlog.

### acadie-2
- **A new scope kind, `provinces`,** for several provinces or territories as one scope. It is added to
  the RegionPack `Scope` union and documented in `docs/interop.md`, Migrations. It widens a union
  rather than adding a field, so a strict 1.0.0 reader rejects such a pack; a reader that only draws
  the assignment is unaffected. The Generate panel gains "Several provinces or territories", with a
  checklist.
- **The recipe, as briefed:**
  - Scope NB + NS + PE, method `lens` (bisection), N = 2, lens `french_share`, hard contiguity, with
    refinement (the method's default).
  - **Two choices the brief left open:**
    - The lens weight in the refinement cost is 1. The default weight is 0, and with it refinement
      ignores French and returns New Brunswick against Nova Scotia and PEI: 30% French against 3%.
    - There is no balance target. A population balance pulls the line toward equal halves, and the
      question is language, not size.
  - The result is the same at lens weights 1 and 5: Acadie is 282,549 people, 66% French mother
    tongue, in one piece.
- **Names come from the recipe:** `spec.nameBy = {column: 'french_share', names: ['Acadie',
  'Maritimes']}`. Regions are ranked by the population-weighted mean of the column, and the rule
  applies wherever regions are named: the page's provisional names, the worker's dossiers, a share
  link, a rerun. Names given by the rule count as generated; carved metros and capitals still win.
- **The premise is in the pack** (`meta.premise`, optional). It says what the line measures (mother
  tongue, as the 2021 census counted it) and what it cannot catch: the Acadian communities of Nova
  Scotia and most of PEI's Évangéline region. It was checked against the pack: one Évangéline cell,
  at Wellington, joins Acadie across the Northumberland Strait by a mesh sea crossing, and the
  premise says so.
- **"Acadian Maritimes" leaves the scenario lists and points at the preset,** in `docs/vision.md` §8
  and `docs/plan.md`. The Maritime Union scenario stays, as a scenario in its own right; its id and
  file are renamed from `acadian-maritimes` to `maritime-union`, so no scenario claims the name.
  Packs that carry it in `meta.scenario` hold the whole scenario, so they still load.
  - **Decision for Mark:** if the brief meant to delete Maritime Union as well, it is one file and
    its tests.

### 1.1 headline
"Scenario overlays may use the same boundary primitives as base events" heads `docs/backlog.md`, with
"No 1912 extensions to today" as its first test case. It replaces the narrower `minus` entry.
