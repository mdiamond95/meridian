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
