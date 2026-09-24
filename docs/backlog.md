# Backlog

Work that is wanted but not scheduled. Each entry says what it is for, what it needs, and what
blocks it. Phases and their gates are in docs/plan.md; decisions already taken are in
docs/decisions.md.

## Data

### Dominion Land Survey township polygons — the township snap layer
**For:** the `township` snap layer in the splitter (`app/src/splitter/snap.ts`), which is listed in
the Generate panel but disabled: there is no DLS data in the pipeline. Township and range lines are
how the Alberta borders were describable in words ("north boundary at Township 54"), so this also
feeds borders-in-words in the dossiers (Phase 4).

**Sources to add** (Prairie provinces only; the DLS does not cover the rest of Canada):
- **Alberta:** AltaLIS Township Grid (Alberta Township System, sections/townships/ranges/meridians),
  published under the Open Government Licence – Alberta. AltaLIS distributes the provincial base
  data; confirm the licence line on the download page before committing anything built from it.
- **Saskatchewan:** the equivalent grid from Saskatchewan's ISC / GeoSask (Saskatchewan Township
  System). Check the licence: some ISC products are not open.
- **Manitoba:** Manitoba Land Initiative township/range grid, Manitoba Open Government Licence.

**Work:** three source rows in docs/data-sources.md, a `townships` builder in
`pipeline/splitter_inputs.py` marking mesh edges that a township or range line crosses (the same
shape as the rivers edges already there), the layer enabled in `SNAP_LAYERS`, and a borders-in-words
classifier that can say "Township 54" and "Range 5, west of the 4th meridian".

**Blocked on:** confirming each province's licence, and whether one national assembly of the three
exists under an open licence (NRCan's Canada Lands Survey System covers federal lands, not the
prairie township grid).

## Overlays

### Rotational workforce as flows between home and camp
**For:** the second non-geographic overlay (vision §8, "Rotational Canada"; plan Phase 6 §3): lines from
the census subdivisions where fly-in fly-out and rotational workers live to the camps and sites they work
at, weighted by headcount, drawn over any partition without claiming cells. The overlay framework already
has the `flow` kind and its renderer (`app/src/overlays/overlays.ts`, `OverlayLayer.tsx`); only the data
is missing.

**Needs:** a curated home-to-camp table: one row per (home CSD uid, site name, site point, workers, year,
source), with the site as a point, not a CSD, since camps are rarely where anyone is counted. Candidate
sources, none yet checked for licence or coverage: the census's place-of-work tables (they record the
work CSD, which for a camp is usually an unorganized area, and cannot tell rotation from commuting),
provincial camp registries (Alberta's oil sands camp inventories), company sustainability reports, and
published studies of rotational work in the oil sands, northern mining and offshore Newfoundland.

**Work:** the table under `pipeline/` with a source row per input in docs/data-sources.md, a small build
step that resolves home CSDs to points and writes a versioned `flows.<version>.json`, a schema, and one
`OverlayDef` of kind `flow`.

**Blocked on:** the table itself. No open source gives home and site together, so it has to be compiled
and cited by hand, and a thin or one-industry table would be a misleading map.

## Engine and app

### Dossiers off the main thread
**For:** responsiveness when a large split lands.
- A 30-region split of Canada holds the main thread for about 800 ms, 1.2 s on the profile run.
  Most of it is `describeSplit`: dossiers 434 ms, set analysis, and ring dissolving 162 ms
  (`docs/perf.md`, Phase 7).
- On an iPad that is a visible freeze.

**Work:** run `buildDossiers` and `buildSetAnalysis` in the solver worker, or a second worker, from
the assignment and the columns the worker already holds. The main thread would get names and
dossiers back. Names are the catch: the map's labels come from the dossiers, so the first paint would
either wait or show the solver's provisional names.

**Blocked on:** nothing; it is a refactor of `app/src/dossier/` inputs into transferable form.

### A `minus` geometry operation for scenarios
**For:** holding "No 1912 extensions" to today.
- It now reverts to the record for Quebec in 1927 and for Manitoba and Ontario in 1999, because no
  base drawing is 1927 Quebec without its Labrador side, or Keewatin south of 60°N alone.
- `minus: [a, b]`, one base drawing less another, draws no line the base does not have. It would
  also let later scenarios take a piece off a unit.

**Blocked on:** Mark's decision. It amends the Phase 6 rule, "geometry only from base drawings, a
unit or a union", and needs arc-level difference in `app/src/scenario/apply.ts`.

### Cache the cell topology too
**For:** the second open of the Generate panel. The decoded mesh and attributes come from IndexedDB
since Phase 7. The 1.4 MB cell topology is still fetched and validated each time, and is most of the
400 ms that remain.

### The language-family palette under deuteranopia
**For:** the Indigenous language-family layer (`FAMILY_COLOURS` in `app/src/atlas/style.ts`). It uses
the eight hues the region palette had before Phase 7. Under simulated deuteranopia their worst pair is
3.8 CIEDE2000 as drawn, a green and a pink. Every area is labelled, so no family depends on colour
alone, but neighbours can merge.

**Work:** apply the region palette's check (`app/src/splitter/colourVision.ts`) to the family fills
at their own opacities, and choose hues the same way. Or reuse the new region hues if they pass at
those opacities.
