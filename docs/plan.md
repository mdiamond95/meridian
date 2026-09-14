# Meridian — Technical Implementation Plan

Companion to `boundary-generator-vision.md`. Eight phases, each with what you do, a ready-to-paste Claude Code brief, and a gate that must pass before the phase is tagged. Effort is in working sessions (one session ≈ one focused Claude Code sitting), not calendar time.

Conventions carried over from Birdseye and Part Splitter: GitHub repo, Codespaces as the dev machine, GitHub Pages for hosting, a rollback tag before every phase lands, golden baselines for anything seeded, and no claim of "done" without a visual check on your iPad.

---

## Stack decisions (made once, here)

| Layer | Choice | Why |
|---|---|---|
| App | Vite + React 18 + TypeScript (strict) | You know React from the reading atlas; Vite builds to static Pages |
| Map | Leaflet 1.9 used directly (no react-leaflet) | Same as the Night Atlas; fewer abstraction bugs |
| State | Zustand | Small, URL-serializable |
| Workers | Web Worker for the solver via Vite `?worker` | UI never blocks on a 40k-cell partition |
| Tests | Vitest (unit), Playwright (smoke on built site) | Golden baselines live in Vitest |
| Pipeline | Python 3.12: geopandas, shapely 2, h3-py 4, pyogrio, pyyaml | Runs in Codespaces, outputs versioned artefacts |
| Simplify | mapshaper (npx) | Best topology-preserving simplifier |
| Mesh | H3 resolution 5 (~253 km² cells, ~40k over Canada) | Fine enough for a 15-region Alberta, cheap enough in a Worker |
| Data format | TopoJSON for polygons; gzipped JSON of typed-array columns for hex attributes | ~3–6 MB total, cached by the browser |
| Hosting | GitHub Pages from `gh-pages` via Actions | Shareable links, no server |
| PRNG | mulberry32, same as the township generator | Seeds reproduce across projects |

Non-goals for v1: server, database, accounts, live data feeds.

---

## Phase 0 — Repository, scaffold, contracts (1 session)

**Goal:** an empty app that builds, tests, deploys, and already knows the shape of its data.

**You do**
1. Create the GitHub repo `meridian` (public; MIT for code, data licences noted separately). Enable Pages (source: GitHub Actions). Enable Codespaces.
2. Copy `boundary-generator-vision.md` into `docs/vision.md` and this file into `docs/plan.md`.
3. Request a Native Land Digital API key (native-land.ca → API) and add it as a Codespaces secret `NATIVE_LAND_API_KEY`. It is only used by the pipeline, never shipped.
4. Open a Codespace and paste the brief below.

**Claude Code brief**

```
Read docs/vision.md and docs/plan.md fully before doing anything.

Scaffold the Meridian repo:

1. Root layout:
   app/            Vite + React 18 + TypeScript strict, Leaflet, Zustand, Vitest, Playwright
   pipeline/       Python 3.12 project (pyproject.toml, uv or pip-tools lockfile):
                   geopandas shapely>=2 h3>=4 pyogrio pyyaml requests numpy
   data/raw/       gitignored downloads
   data/build/     committed, versioned artefacts (mesh, atlas, attributes)
   docs/           vision.md, plan.md, decisions.md, data-sources.md
   .devcontainer/  Python 3.12 + Node 20 + mapshaper, postCreate installs both projects
   .github/workflows/ ci.yml (lint, vitest, pipeline dry-run) and pages.yml (build app, deploy)

2. Contracts (write these first; everything else conforms to them):
   app/src/schema/mesh.ts      — MeshFile: version, h3Resolution, cells[] {id, centroid, area,
                                  province, cd, csd, neighbours[]}, columns: Record<name, Float32Array|Int32Array>
   app/src/schema/atlas.ts     — AtlasFile: version, events[] {date, title, note, changes[]},
                                  units[] {id, name, status, sovereign, capital, validFrom, validTo,
                                  truth: 'dejure'|'defacto'|'disputed', geometryRef}
   app/src/schema/regionPack.ts — RegionPack v1: meta {seed, method, params, meshVersion, scope,
                                  date}, assignment: Int32Array(cellCount), regions[] {id, name,
                                  capital, stats, dossier}, setAnalysis
   Export JSON Schema for all three to docs/schemas/ via a script.

3. App shell: full-bleed Leaflet map on CartoDB Positron tiles, right-hand panel placeholder,
   bottom timeline placeholder, layers menu placeholder. Mobile/iPad layout collapses panels
   to sheets. No data yet.

4. Tooling: ESLint + Prettier, `npm test`, `npm run build`, `npm run smoke` (Playwright loads
   the built site and asserts the map container renders). Pipeline: `make dry-run` validates
   YAML and prints the artefact plan without downloading.

5. docs/decisions.md: log every stack choice above with one-line rationale. docs/data-sources.md:
   table with source, URL, licence, attribution string, refresh cadence — leave rows empty
   for Phase 1 to fill.

Deliver: green CI, Pages URL serving the shell, README with the three commands. Do not add
features beyond this list.
```

**Gate:** CI green, Pages URL loads the map shell on iPad Safari, schemas exported. Tag `v0.0-scaffold`.

---

## Phase 1 — Data pipeline and base mesh (3–4 sessions)

**Goal:** `data/build/mesh.v1.json.gz` and `attrs.v1.json.gz` — every H3 cell in Canada with its present-day attributes — produced deterministically by one command.

**Sources (fill `docs/data-sources.md`):**
- StatCan 2021 boundary files: provinces/territories, CD, CSD, CMA/CA, dissemination areas (DA). Open Licence.
- StatCan 2021 Census Profile at DA and CSD: population, mother tongue, Indigenous identity, immigrant status, labour force by NAICS.
- StatCan provincial GDP by industry (table 36-10-0402), latest year.
- Open Government: Pre-1975 Treaties, Modern Treaties, Indian Reserves, Métis Settlements (Alberta), Inuit Nunangat regions.
- NRCan: Terrestrial Ecozones, Atlas of Canada drainage areas (major basins + Saskatchewan-Nelson sub-basins), rivers network (for snap layer), Continental Divide (derive from basin boundaries).
- Elections Canada: 2023 representation order FED polygons; latest general election results by riding.
- Native Land Digital API: territories and languages (approximate; attribution required).

**You do**
1. Confirm each licence line in `docs/data-sources.md` before the artefacts are committed.
2. Spot-check five hexes you know cold (Bonnie Doon, Fort McMurray, Grand Falls-Windsor, Iqaluit, Old Montréal) once the attribute dump exists.

**Claude Code brief**

```
Implement pipeline/ end to end. Read docs/vision.md §2 and §4, docs/plan.md Phase 1, and the
schema contracts in app/src/schema before writing code.

1. pipeline/download.py — fetch every source listed in docs/data-sources.md into data/raw/,
   record SHA256 and fetch date in data/raw/MANIFEST.json. Idempotent. Native Land uses
   NATIVE_LAND_API_KEY from env; skip with a warning if absent.

2. pipeline/mesh.py — generate H3 res-5 cells covering Canada's land + inland water (polyfill
   the dissolved province layer, keep cells whose centroid or >30% area is Canadian). Assign
   province, CD, CSD by largest area overlap. Build the neighbour graph (k-ring 1, filtered to
   cells in the mesh). Write mesh.v1.json.gz matching MeshFile.

3. pipeline/attrs.py — populate columns, all Float32/Int32:
   - population: dasymetric — sum DA populations by DA centroid into hexes, then rescale so
     each CSD total is preserved exactly.
   - language shares (EN/FR/Indigenous/other), indigenous_identity_share, immigrant_share:
     population-weighted from DA.
   - urban_class: 0 remote / 1 rural / 2 small urban / 3 CMA, from CMA/CA membership + density.
   - industry_dominant (NAICS 2-digit code) and industry_shares from CSD labour force.
   - gdp_estimate: provincial GDP by industry × cell share of provincial labour force in that
     industry, summed. Store gdp_method='allocation_v1' in file meta.
   - ecozone_id, basin_id, subbasin_id (Saskatchewan-Nelson detail), treaty_code (numbered /
     historic / modern / unceded / none), reserve_share, metis_settlement, inuit_region,
     fed_riding_id, riding_party_2025 (or latest), native_land_territory_ids[] (side table).
   - distance_to_capital_km (provincial capital, great-circle), for the internal-colony index.
   Write attrs.v1.json.gz.

4. pipeline/polygons.py — simplified TopoJSON of provinces, CD, CSD (three zoom tiers via
   mapshaper), treaties, ecozones, basins, rivers ≥ Strahler 5, ridings. Write to
   data/build/layers/*.topojson.

5. Determinism: `make build` must produce byte-identical outputs from identical raw inputs.
   Add `make verify` that rebuilds and diffs hashes. Add a pytest that checks: cell count
   within 38k–45k; sum of population equals 2021 Canada total ±0.1%; every cell has ≥1
   neighbour except islands; Alberta cell count ≈ Alberta area / 253 km² ±5%.

6. Write pipeline/README.md with the one-command build and the confidence caveats
   (GDP is allocation; Native Land approximate).

Do not touch app/ beyond adding a loader in app/src/data/loadMesh.ts that fetches and decodes
the two files into typed arrays, with a unit test on a 50-cell fixture.
```

**Gate:** `make verify` clean; pytest green; the five spot-check hexes carry sane values; artefacts under 8 MB total. Tag `v0.1-mesh`.

---

## Phase 2 — Historical atlas (4–5 sessions; the research-heavy one)

**Goal:** slide a year from 1000 to today and see correct first-order boundaries in three truth layers.

**Method:** boundaries are *constructed*, not traced. `pipeline/atlas/events.yaml` describes each unit at each event as boundary primitives — segments of modern boundaries, parallels, meridians, named rivers, and shoreline. `pipeline/atlas/build.py` assembles polygons with shapely. This is deterministic, auditable, and matches how the boundaries were actually defined (Manitoba 1870: 49°N to 50°30'N, 96°W to 99°W, is three primitives).

**You do**
1. Review the event list in the vision §5.4 and add or strike events. Decide the pre-contact default (recommend 1497 as default, 1000 and per-region frontier as options).
2. Verify each constructed map against the NRCan *Territorial Evolution of Canada* reference sheets (Atlas of Canada). This is your eyes, not a test. Do it era by era as briefs land: 1670–1791, 1791–1867, 1867–1905, 1905–1949, 1949–today.
3. Decide how disputed Labrador should render before 1927 (recommend: hatched overlap of the 1927 award and Quebec's claim line).

**Claude Code brief (split into three sittings: A framework + 1867–today, B 1670–1867, C pre-contact and disputed)**

```
Sitting A. Read docs/vision.md §5 and the AtlasFile schema.

1. pipeline/atlas/primitives.py — functions returning shapely geometries:
   parallel(lat, lon0, lon1), meridian(lon, lat0, lat1), modern_border(unitA, unitB) extracted
   from the high-res provincial boundary file, river(name, from, to) from the NRCan network,
   coast(from_point, to_point, side), hbc_watershed() = Hudson Bay drainage from basin data.
   Every primitive is deterministic and unit-tested against known points.

2. pipeline/atlas/events.yaml — one entry per event with date, title, note (two sentences,
   plain, in the voice of the Confederation sequence), and unit changes. Start with the
   1867–today events: 1867, 1870, 1871, 1873, 1876, 1880, 1881, 1882, 1889, 1895, 1898,
   1903, 1905, 1912, 1927, 1949, 1999, 2001. Each unit lists its boundary as an ordered
   ring of primitives plus status, sovereign, capital, truth layer.

3. pipeline/atlas/build.py — resolve every event into unit polygons, validate (no self-
   intersections, union of de jure units equals modern Canada after 1949 within 0.5%),
   write data/build/atlas.v1.json (+ topojson geometries per event, deduplicated so an
   unchanged unit shares geometry across events).

4. app: timeline slider (year), event ticks, "resolve date → units" selector, unit fill by
   status, click → unit panel (name, status, sovereign, capital, note, valid range).
   Truth-layer toggles: de jure on by default, de facto and disputed off. Layers menu gains
   an Atlas group.

5. Tests: resolve(1900) contains Yukon and NWT districts, not Alberta; resolve(1906) has
   Alberta and Saskatchewan with 60°N northern limits; resolve(1930) Manitoba reaches 60°N;
   resolve(1950) includes Newfoundland; resolve(1998) has no Nunavut; resolve(1999-04-01) does.
   Golden: SHA of atlas.v1.json recorded in tests/golden/atlas.sha and asserted in CI.

Deliver a checklist of every polygon for Mark to verify against the NRCan sheets.
```

```
Sitting B. Extend events.yaml back to 1670: HBC charter (Rupert's Land as Hudson Bay
watershed), Acadia/Nova Scotia 1713, 1763 Proclamation (Quebec, Nova Scotia, Newfoundland,
Indian Reserve), 1774 Quebec Act, 1783, 1784 NB and Cape Breton, 1791 Upper/Lower Canada,
1818, 1820 Cape Breton merger, 1841, 1842 Webster–Ashburton, 1846 Oregon, 1849 Vancouver
Island, 1858 BC, 1866 BC merger. Add colonial sovereign field (Britain, France, HBC, Spain,
USA, Russia for Alaska). De facto layer for this era = fur-post catchments and settlement
extents; source these as approximate polygons in events.yaml with a `confidence` field and
render with reduced opacity. Same tests/golden pattern.
```

```
Sitting C. Pre-contact and disputed.
1. Pre-contact base (before the user-chosen contact date): render Native Land territory and
   language polygons with the mandatory attribution and an on-layer caveat. Add per-hex
   `first_contact_year` to attrs (Cabot 1497 coast → Champlain → Henday 1754 for Alberta →
   Arctic 19th c.) as a documented lookup in pipeline/atlas/contact.yaml; expose "contact
   frontier" as a choropleth and as the third start-date option.
2. Disputed layer polygons: Oregon Country (to 1846), Alaska panhandle claim lines (to 1903),
   Labrador (Quebec claim vs 1927 award), San Juan Islands (to 1872), Hans Island (to 2022),
   Machias Seal Island (open). Hatched fill, with claimant labels.
3. Timeline start-date selector: 1000 / 1497 / contact frontier. Below the chosen date the
   atlas shows the pre-contact base only.
```

**Gate:** all era checklists signed off by you; tests and golden hash green; iPad slider is smooth (frame time under 16 ms at 1867 and 1999). Tag `v0.2-atlas`. This is the first thing worth showing anyone.

---

## Phase 3 — Splitter engine (4–5 sessions)

**Goal:** choose a scope, a method, a lens and N; get regions in seconds, reproducibly.

**Solver design**
- Graph: mesh neighbours, optionally restricted to scope (province, atlas unit at a date, saved region, drawn polygon).
- Cost = Σ_regions imbalance(target metric) + λ_compactness × perimeter/area + λ_lens × within-region variance of lens columns − snap bonus when a boundary edge lies on a snap layer.
- Methods map to initialisers plus a shared refinement: hierarchical bisection (lens method), seeded growth (Voronoi in graph distance, weighted), random Voronoi / random cuts, template load. Refinement = boundary-cell swap moves with simulated annealing; every move checks contiguity by BFS on the affected region (incremental, not full).
- Determinism: mulberry32(seed); iteration order fixed by cell id; no Math.random anywhere.

**You do**
1. Pick the first three templates to encode by hand: 15-region Alberta, 26-region Canada, Incrementalist 14. I will draft the cell assignments from the border descriptions; you correct on the map.
2. Run the same seed on iPad and desktop and confirm identical output — that is the determinism gate.

**Claude Code brief (two sittings: A engine, B UI and constraints)**

```
Sitting A. Read docs/vision.md §3 and the RegionPack schema.

1. app/src/engine/graph.ts — build a compact adjacency (CSR arrays) for a scope mask over
   the mesh. Scope sources: whole mesh, province code, atlas unit id at date, region id from a
   loaded pack, GeoJSON polygon (point-in-polygon on centroids).

2. app/src/engine/prng.ts — mulberry32 + helpers, identical sequence to the township
   generator (copy its implementation; add a cross-project fixture test).

3. app/src/engine/solver.ts — the cost model above with weights in a Params object.
   Initialisers: bisect(lens), seeded(capitals[] | k), randomVoronoi, randomCuts, template.
   refine(): annealing over boundary cells, incremental contiguity via BFS restricted to the
   changed region, early stop on plateau, max wall time param. Returns Int32Array assignment
   plus per-region stats (pop, area, gdp, lens means/variances, compactness).

4. app/src/engine/worker.ts — runs solver in a Web Worker with progress messages; cancellable.

5. Tests: (a) same seed+params → identical assignment (golden hashes for 5 seeds × 3 methods
   on an Alberta scope); (b) every region contiguous when contiguity=hard; (c) equal-population
   with N=10 on Canada yields max/min ratio < 1.15; (d) bisect with lens=french_share on
   Canada N=2 places >90% of Quebec francophone population in one region; (e) solver on
   full Canada N=20 completes under 8 s in CI.
```

```
Sitting B. UI and constraints.
1. Right panel "Generate": scope picker (Canada / province / atlas unit at current date /
   saved region / draw), method, N, lens weights (sliders over attribute columns with
   presets: Economic, Demographic, Linguistic, Indigenous-constitutional, Physical,
   Political, Internal-colony index), balance target, contiguity hard/soft/off, seed, run.
2. Constraints: min/max population per region; keep-together and keep-apart pins by clicking
   places (place gazetteer from CSD centroids); carve-CMA-first toggle; snap layers multi-
   select (rivers, basins, Continental Divide, treaties, township lines where available,
   CD/CSD edges, parallels/meridians at 0.5°, ridings, ecozones).
3. Rendering: hex fill by region with a stable palette; region outlines dissolved client-side
   (topojson merge of hexes); hover stats; legend.
4. Manual override mode: click-paint cells into the selected region; stats recompute; an
   `edited` flag and edit log go into the pack meta.
5. URL state: scope, method, N, seed, params, and date serialised into the hash; reload
   reproduces the split (without edits; edits require a saved pack).
6. Template packs under app/public/packs/: alberta-15.json, canada-26.json, incrementalist-14
   .json — assignments drafted from the border descriptions in docs/templates/*.md that Mark
   supplies; mark them draft until verified.
```

**Gate:** determinism test across two devices; golden hashes committed; the Alberta 15 template reproduces the regions you recognise; N=1 through N=30 on Canada produce no crash and no non-contiguous region under hard mode. Tag `v0.3-splitter`.

---

## Phase 4 — Dossiers and set analysis (3 sessions)

**Goal:** every generated region describes itself; every set is analysed.

**You do**
1. Approve the dossier field list (vision §6) and the wording style; supply the "character line" style rule you liked from the cities model.
2. Sanity-check GDP totals against StatCan provincial figures and the running-total reconciliation.

**Claude Code brief**

```
1. app/src/dossier/ — pure functions from (assignment, mesh, attrs, atlas date) to
   RegionDossier and SetAnalysis per the RegionPack schema.
   - name: deterministic generator seeded by region seed: pattern library from physical
     features, rivers, treaty/nation names where appropriate (with a flag so Indigenous names
     are never auto-applied to non-Indigenous-majority regions), historic district names;
     manual rename always wins and persists in the pack.
   - capital: largest CSD by population unless pinned; main/secondary cities: next 4.
   - stats: population, area, density, gdp (allocation), growth 2016→2021, language and
     Indigenous profile, treaty composition, dominant industries (top 3 by share),
     urban share, internal-colony index, distance-to-capital mean.
   - governing_party: population-weighted riding results with the largest share; label
     "hypothetical".
   - borders_in_words: walk the dissolved boundary, classify each run by the snap layer or
     feature it follows (river name, parallel, meridian, provincial border, township line,
     free-form "east of Highway 2 corridor"), merge runs, emit clockwise from the north-west.
     Golden test on the Alberta N/S template: must mention 52°N, Continental Divide,
     Saskatchewan border.
   - text fields: character line, rival region (highest attribute similarity + adjacency),
     one_sentence, kill/save — templated from stats with a placeholder marker so Mark or a
     later LLM pass can rewrite; never invented facts.
2. SetAnalysis: power ranking (economic leverage = gdp share; chokepoints = count of
   inter-region edges crossed by major rivers/highways/rail — use rivers and ridings as a
   proxy for v1; resource ownership = extractive industry share); size ratios; metros split
   (CMA spans >1 region); population and GDP reconciliation vs. scope totals; contiguity
   compromise log from the solver; federalism panel with static rules (Senate regions,
   7/50 amending formula, equalization, Quebec asymmetry, territorial status) evaluated
   against the set and rendered as "what breaks".
3. UI: region panel with dossier; set panel with ranking table and federalism panel;
   Compare mode: two packs side by side with a swipe divider and a difference table
   (cells reassigned, population moved, metros split).
4. Markdown export of the full dossier set (used by Phase 5).
```

**Gate:** borders-in-words golden passes; GDP reconciles to scope total; compare mode works on iPad. Tag `v0.4-dossiers`.

---

## Phase 5 — Export, import, interoperability (2 sessions)

**Goal:** a split leaves the tool in every format the other projects need, and comes back in.

**You do**
1. Import one exported KML into Google My Maps and one GeoJSON into the cities atlas to prove the round trip.
2. Decide the shared pack location (recommend a `packs/` folder in this repo that other repos fetch by raw URL and version).

**Claude Code brief**

```
1. app/src/export/: regionPack.json (schema-validated), regions.geojson and .topojson
   (dissolved polygons + dossier properties), KML (one folder per region: polygon, capital pin,
   dividing lines as separate folder — the layout we used for Alberta), SVG (regions, labels,
   legend, scale bar, date stamp, attribution) and PNG via canvas, dossier.md.
2. app/src/import/: RegionPack (validate, check meshVersion, offer re-fit onto current mesh by
   centroid nearest-cell if versions differ), GeoJSON/KML as template (assign cells by majority
   overlap), as snap layer, or as scope.
3. Save/load: packs to IndexedDB with a library panel; download/upload files; "share link"
   for unedited splits.
4. docs/interop.md: the RegionPack v1 contract, versioning rules, and a 20-line example of
   loading a pack in a vanilla Leaflet page (for the cities atlas and Birdseye).
5. Tests: round-trip pack → export → import equals original assignment; KML validates
   against the OGC schema; GeoJSON passes geojsonhint.
```

**Gate:** Google My Maps round trip works; cities atlas loads a pack via the doc's snippet. Tag `v0.5-interop`.

---

## Phase 6 — Scenarios and game hooks (3–4 sessions, optional ordering)

**Goal:** the atlas branches; splits nest; non-geographic regions coexist; games can read scores.

**You do**
1. Choose the first two counterfactual presets to ship (recommend Newfoundland independent 1949 and unified Buffalo 1905).
2. Define the scoring fields a first game needs; I'll map them to pack stats.

**Claude Code brief**

```
1. Divergence mode: fork the atlas at a date into a scenario; scenario events are a YAML
   overlay applied after the base event list; later base events carry `requires:` conditions
   (e.g., 1949 requires unit 'newfoundland' status='dominion') and are skipped with a notice
   when unmet. UI: scenario badge, diff against base at any date, scenario save in the pack.
2. Nesting: a split's region becomes the scope of a child split; store as a tree in the pack
   (parentPack, parentRegionId); breadcrumb navigation; tree export.
3. Non-geographic overlays: point/flow layers driven by attributes (rotational workforce as
   flows between home CSDs and camp sites from a curated table; immigrant-share halos) that
   render over any partition without claiming cells.
4. Presets: docs/scenarios/*.yaml for Newfoundland-independent, Buffalo, no-1912-extensions,
   Acadian Maritimes; each with a one-paragraph premise and its overlay events.
5. Game hooks: `pack.regions[].stats` gains a stable `score` object (population, gdp,
   resource_index, cohesion = 1 − lens variance, exposure = dependency score) and a
   `meridian.getScores(packUrl)` helper in docs/interop.md.
```

**Gate:** Newfoundland-independent scenario shows no 1949 accession and the atlas still resolves cleanly to today; nesting three levels deep round-trips. Tag `v0.6-scenarios`.

---

## Phase 7 — Hardening and 1.0 (2 sessions)

**You do**
1. Full iPad pass: Safari, offline after first load, memory under control on a 40k-cell Canada split.
2. Write the README's front page yourself — it is your project's voice.

**Claude Code brief**

```
1. Performance: lazy-load layer TopoJSON; cache decoded attrs in IndexedDB keyed by version;
   Worker transfers assignment buffers zero-copy; Leaflet canvas renderer for hexes;
   measure and record frame times in docs/perf.md at 1867, 1999, and a 30-region Canada split.
2. Offline: service worker precaching build artefacts and tiles for the last viewed extent.
3. Accessibility: keyboard timeline, palette safe for deuteranopia, panel focus order.
4. Data refresh playbook in pipeline/README.md: how to move to the next census with a new
   meshVersion and what breaks for old packs.
5. Release: CHANGELOG, licences page with every attribution string, tag v1.0.0, Pages deploy.
```

**Gate:** all golden tests green; perf numbers recorded; iPad pass complete. Tag `v1.0.0`.

---

## Running rules for every session

- Start each session by having Claude Code read `docs/plan.md`, the current phase, and `docs/decisions.md`. End each by appending to `docs/decisions.md` and a `docs/log/YYYY-MM-DD.md` handoff (same discipline as the township generator's HANDOFF.md).
- Before any phase merges: `git tag pre-<phase>` on `main`, then merge, then `git tag v0.<n>`.
- No feature lands without a test or a golden; no golden changes without a one-line justification in the commit.
- Build artefacts are committed with their version in the filename; the app never reads an unversioned file.
- Anything estimated (GDP, pre-1871 population, Native Land polygons, de facto extents) carries a `confidence` or `method` field all the way to the UI.

## Effort summary

| Phase | Sessions | Cumulative |
|---|---|---|
| 0 Scaffold | 1 | 1 |
| 1 Mesh and attributes | 3–4 | 5 |
| 2 Atlas | 4–5 | 10 |
| 3 Splitter | 4–5 | 15 |
| 4 Dossiers | 3 | 18 |
| 5 Interop | 2 | 20 |
| 6 Scenarios | 3–4 | 24 |
| 7 Hardening | 2 | 26 |

Roughly 26 sittings to 1.0. The atlas is usable and shareable after 10; the splitter after 15. If you want a faster first payoff, Phase 2 Sitting A alone (1867–today) is a complete, demonstrable artefact.
