# Changelog

One entry per release tag. Each phase was merged to `main` after `pre-phase<N>` was tagged. The
detail is in `docs/log/` (what happened in each session) and `docs/decisions.md` (why).

## v1.0.1 — 2026-09-24

- **A split lands without freezing the page.** Naming, dossiers, set analysis, scores and region
  outlines are now made in the background worker, which holds its own copy of the data. A 30-region
  split of Canada used to hold the page for about 800 ms; now no task on the page reaches 50 ms.
  The map also no longer re-fits when the split is already in view.
- **New preset: Acadie and the Maritimes** (`acadie-2`). Nova Scotia, New Brunswick and Prince
  Edward Island are split in two on French mother tongue, and the pack explains what the line means
  and what it misses. It is what "Acadian Maritimes" in the vision meant. The Maritime Union
  scenario stays, renamed `maritime-union`.
- **New scope:** several provinces or territories at once.
- **Next:** the 1.1 headline is scenarios that can use the same boundary primitives as the historical
  record, starting with No 1912 extensions held to today (`docs/backlog.md`).

## v1.0.0 — 2026-09-24 · Hardening and 1.0 (Phase 7)

### Performance
- **The timeline crosses events in under a frame.** The atlas keeps the three event windows either
  side of the current one on the map, hidden, so a step across an event swaps which paths are shown.
  The slowest one-year step at 1867 and 1999 fell from 17–31 ms to 1.7–7.3 ms.
- **The splitter opens faster the second time.** Its decoded mesh and attributes are kept in
  IndexedDB, keyed to the exact files they came from.
- **The solver worker gets the mesh once,** instead of on every run.
- **A repeated scope skips 300 ms of setup:** its scope graph is cached.
- **Measured and recorded** in `docs/perf.md`: frame times with a 30-region Canada split, and the
  memory of a 38,432-cell split under iPad emulation (flat JS heap, renderer levels off).

### Offline
- A service worker keeps the app, every data artefact and the presets after the first visit. It also
  keeps the basemap tiles of the last view you looked at. The page loads, and a saved pack opens,
  with the network off.

### Accessibility
- Timeline:
  - Page Up and Page Down jump between events;
  - the event ticks are a single tab stop, and the arrow keys move between them.
- The panel tabs follow the standard tabs pattern: one tab stop, arrow keys, a labelled tab panel.
- A visible focus ring throughout.
- **A new region palette safe for deuteranopia.** All pairs of its eight colours stay clearly apart
  (CIEDE2000 ≥ 12), with and without simulated deuteranopia; the old palette's closest pair was 3.8.
- axe reports no WCAG 2.1 A or AA violations in any panel.

### Content
- Two scenario presets:
  - **No 1912 extensions:** the Boundaries Extension Acts fail. The counterfactual holds until the
    1927 Labrador award for Quebec, and until 1999 for Manitoba and Ontario; the premise explains
    why.
  - **Maritime Union:** Nova Scotia, New Brunswick and Prince Edward Island enter Confederation as
    one province.
- `dominion-1867-5` explains why it holds cells in today's Labrador.

### Documentation
- The data refresh playbook in `pipeline/README.md`: the next census, a new mesh version, and what
  that breaks for old packs and links.
- A Licences panel in the app lists every source's attribution.
- This changelog, and a README front page.

## v0.6-scenarios — 2026-09-24 · Scenarios and game hooks (Phase 6)
- **Divergence mode.**
  - A scenario replays the atlas with its own events. Base events whose preconditions it breaks are
    skipped, with the reason shown.
  - The Scenario tab has a badge, a diff against the record at any date, and dashed outlines of what
    changed.
  - Presets: *Newfoundland independent* and *Unified Buffalo*.
- **Nesting.** Split a region of a split, as deep as you like. The whole tree saves and loads as one
  file.
- **Overlays.** Immigrant-share halos over the 40 metropolitan areas, drawn over any split.
- **Scores for games.** `regions[].stats.score` in every pack, with `meridian.getScores` and a
  worked example in `docs/interop.md`.
- A fourth preset: **the Dominion of 1867 in five.**

## v0.5-interop — 2026-09-24 · Export, import, interoperability (Phase 5)
- **Export:**
  - region pack;
  - GeoJSON and TopoJSON of the regions, with dossier properties;
  - KML with folders, capitals and dividing lines;
  - SVG and PNG with legend, scale bar and date;
  - Markdown dossiers.
- **Import:**
  - region packs, re-fitted or regenerated when made on another mesh;
  - GeoJSON and KML, used as a split, a snap layer or a scope.
- **A library of packs saved in the browser,** and share links for splits a link can reproduce.
- **`docs/interop.md`:** the RegionPack v1 contract, versioning rules, and a Leaflet example.
- The presets moved to the top-level `packs/` folder.

## v0.4-dossiers — 2026-09-17 · Dossiers and set analysis (Phase 4)
- **A dossier for every region:**
  - name, capital and cities;
  - population, area and estimated GDP;
  - industries, and borders in words;
  - language and treaty profile, and a hypothetical governing party;
  - four written fields.
- **Set analysis:**
  - a power ranking, largest-to-smallest ratios and metros split;
  - population and GDP reconciliation, and the contiguity compromises;
  - a federalism panel: what the set would break in the Senate, the amending formula, equalization,
    Quebec's asymmetry and territorial status.
- **Comparison mode** against another split or actual Canada, with a swipe divider and a difference
  table.

## v0.3-splitter — 2026-09-17 · The splitter (Phase 3)
- **A partition engine in a Web Worker,** deterministic from a seed: the same split in Chromium,
  WebKit, Firefox and Node.
- **Methods:** lens bisection, balanced partition, seeded growth, random, and templates.
- **The Generate panel:**
  - scopes: Canada, a province, an atlas unit at any date, a region, or a drawn polygon;
  - lens presets, balance targets and contiguity;
  - population limits, keep-together and keep-apart pins, and carved metros;
  - snapping to rivers, basins, the Continental Divide, treaties, census edges, the graticule,
    ridings and ecozones.
- **Regions on the map,** with names, hover statistics and a legend. Cells can be painted between
  regions by hand.
- **Share links, and three presets:** Alberta in 15, Canada in 26, and Canada in 14 around the
  capitals.

## v0.2-atlas — 2026-09-16 · Scaffold, base mesh and historical atlas (Phases 0–2)
- **Phase 0:** the repository, contracts (JSON Schemas exported from the app's Zod types), CI,
  Pages deploy and secret scan.
- **Phase 1:** the offline Python pipeline.
  - The base mesh is 38,432 H3 cells at resolution 5 over Canada, with per-cell attributes: 2021
    population, language, Indigenous identity, industry, estimated GDP, treaties, ecozones, drainage
    and ridings.
  - Every build is reproducible byte for byte (`make verify`).
- **Phase 2:** the historical atlas from 1670 to today.
  - About 50 dated events, each checked against the statutes and orders and against NRCan's
    Territorial Evolution maps.
  - Three truth layers: de jure, de facto, and claims (hatched).
  - The contact frontier, and an Indigenous language-family base before contact.
  - A timeline with a tick per event.
