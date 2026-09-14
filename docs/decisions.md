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
