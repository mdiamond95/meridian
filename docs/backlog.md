# Backlog

Work that is wanted but not scheduled. Each entry says what it is for, what it needs, and what
blocks it. Phases and their gates are in docs/plan.md; decisions already taken are in
docs/decisions.md.

## 1.1 headline

### Scenario overlays may use the same boundary primitives as base events
**For:** scenarios that can hold their counterfactual all the way to today.
- A scenario's geometry can only reuse drawings from the base atlas: a unit as it stood on a date,
  or a union of several (Phase 6 decision).
- Base events build theirs from boundary primitives, in the expression language of
  `pipeline/atlas/events.yaml`:
  - named shapes (`shape:`), modern provinces (`modern:`), drainage regions (`drainage:`);
  - `union`, `minus` and `intersect`;
  - earlier drawings (`was:`, `unit:`), lines, and `mainland`.
- Scenarios should be able to use the same language. They would still draw no line of their own
  invention: every edge would come from a primitive the base cites.

**First test case: No 1912 extensions, to today.** The scenario now reverts to the record:
- for Quebec in 1927, because no base drawing is the 1927 Quebec without the land the 1912 Act gave
  it;
- for Manitoba and Ontario in 1999, because no base drawing is Keewatin south of 60°N on its own.

With primitives, both become expressions over lines the base already cites: the 1912 Acts' limits,
the 60th parallel, and Nunavut's modern boundary. The test is that the
scenario:
- resolves cleanly at every event date;
- keeps Manitoba, Ontario and Quebec at their pre-1912 extent today;
- assigns the land north of them to the territories;
- skips no base event.

**Work:**
- Evaluate scenario geometry through the same expression evaluator as the atlas build. That is
  Python today, run at build time, so the options are:
  - compile scenarios in the pipeline, as the base is;
  - or port the evaluator's operators to TypeScript on the TopoJSON arcs. `apply.ts` already has
    `merge` there.
- Extend `docs/schemas/scenario.schema.json`.
- Rewrite `docs/scenarios/no-1912-extensions.yaml`'s later events.

**Supersedes** the earlier `minus` entry: `minus` is one of these primitives.

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

### Share the splitter data between the page and the worker
**For:** memory on an iPad. Since 1.0.1 the worker loads its own copy of the splitter data and the
cell topology, so the page can stay unblocked. The renderer holds about 180 MB more than in 1.0.0
(about 870 MB under iPad emulation, `docs/perf.md`).

**Work:** decode once, in the worker, and transfer the typed arrays the page needs (centroids,
columns for painting and stats) rather than decoding the same files on both sides. The page keeps
little else: the gazetteer and the ring cache. Transferring detaches the worker's copy, so either
the page keeps only what it needs and the worker the rest, or the worker hands out copies it makes
off the main thread.

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
