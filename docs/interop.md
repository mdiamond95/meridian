# Interop: sharing a split with other projects

How a Meridian split leaves this repo and comes back: the shared pack folder, the rules a consumer
follows, the RegionPack v1 contract, the rules for changing it, unit tables for consumers whose unit is
not a region (the federal ridings, for House of Cards), and a vanilla Leaflet page that draws a pack in
twenty lines (for the cities atlas and Birdseye).

## Where packs live

Shared packs are in the top-level **`packs/`** folder of this repo, one file per pack, named
**`<slug>.<meshVersion>.json`** (`alberta-15.v1.json`), or **`<slug>.<meshVersion>.<n>.json`**
(`alberta-15.v1.2.json`) for a regeneration on the same mesh. `packs/index.json` lists the current file
of each pack (`format: "meridian.packLibrary"`, each entry's `id`, `name`, `description` and `file`).

| Who | Fetches |
|---|---|
| The Meridian app | `packs/<file>` by relative URL (served from `packs/` in dev, copied into the build) |
| Other projects | `https://raw.githubusercontent.com/mdiamond95/meridian/<tag>/packs/<file>`, at a release tag such as `v1.0.1` |

`main` is the working copy and moves without notice; fetch from a release tag
([the releases](https://github.com/mdiamond95/meridian/tags), `v1.0.0` and later).

To draw a pack you also need the mesh it was made on. The cell polygons are
`data/build/cells.<meshVersion>.topojson.gz` (gzipped TopoJSON, object `cells`, one Polygon per mesh
cell in cell-index order), and the cells themselves (H3 ids, centroids, provinces) are
`data/build/mesh.<meshVersion>.json.gz`. Both are fetched from the same raw URLs.

## Consumer rules

What a project reading Meridian packs does. The snippets on this page follow them.

1. **Pin a release tag.** Fetch from `https://raw.githubusercontent.com/mdiamond95/meridian/<tag>/`,
   never `main`. A published pack never changes (versioning rule 7): a file you read at one tag is the
   same at every later tag, so moving the pin to a newer release cannot change a pack you already
   use. A regenerated pack arrives under a new name, which the newer `packs/index.json` lists.
2. **Read regions, not cells.** Use each region's polygon (dissolved from the mesh's cells, as the
   Leaflet page does), its `stats` and its `stats.score`. Do not store cell indexes or H3 ids, or key
   anything on them: they belong to one `meshVersion` and mean nothing on another. Key on the pack's
   file name and the region's `id`.
3. **Ignore fields you do not know.** New optional fields are added without a version bump
   (versioning rule 1).
4. **Check the format and version, and refuse otherwise.** `format` must be `"meridian.regionPack"`
   and `version` must be `1`. Anything else is not a pack this page describes: stop with an error
   rather than guess.

## The RegionPack v1 contract

A pack is JSON validated by `docs/schemas/regionPack.schema.json` (generated from
`app/src/schema/regionPack.ts`; the Zod schema is the source of truth).

| Field | Meaning |
|---|---|
| `format` | always `"meridian.regionPack"`; reject anything else before validating |
| `version` | the contract version, `1` |
| `meta.meshVersion` | the mesh the assignment indexes, e.g. `"v1"`; must match the cells you draw with |
| `meta.seed`, `meta.method`, `meta.params`, `meta.scope`, `meta.date` | the recipe: rerunning it on the same mesh gives the same assignment. `method: "template"` means the regions came from an imported map and there is no recipe |
| `meta.edited`, `meta.edits` | present once cells were painted by hand (H3 id, from, to, in order); an edited pack cannot be regenerated from its recipe |
| `meta.byteOrder` | `"le"`: every encoded column is little-endian |
| `assignment` | `{kind: "id", dtype: "int32", byteOrder: "le", length, data}`: `data` is base64 of `length` little-endian int32s, the region id of each mesh cell, `-1` outside the scope |
| `meta.id` | the pack's id: a preset's slug, or `split-` and a hash of the recipe and cells |
| `meta.parentPack`, `meta.parentRegionId` | present on a nested split: the `meta.id` of the pack it splits, and which region (its `scope` is `{kind: "region", pack, region}` with the same values) |
| `meta.premise` | present on a preset that argues something (1.0.1): why the split is made this way, in prose |
| `meta.params.nameBy` | present when regions are named by a column (1.0.1): `{column, names}`; regions ranked by the population-weighted mean of `column`, highest first, take `names` in order |
| `meta.scenario` | present when the split was made in an atlas scenario: the whole scenario (`docs/schemas/scenario.schema.json`), so an atlas scope resolves the same way anywhere |
| `regions[]` | `id` (the value used in `assignment`), `name`, `capital`, `stats` (`population`, `areaKm2`, `gdpCadMillions`, `cells`, `pieces`, `compactness`, `carved`, and the `score` object below), `dossier` |
| `regions[].dossier` | the region's dossier (`docs/schemas/regionPack.schema.json#/$defs/RegionDossier`). Templated sentences carry `placeholder: true` and open with ⟨draft⟩ |
| `setAnalysis` | power ranking, ratios, reconciliation, contiguity notes and federalism findings for the whole set |
| `children` | present on a tree: the packs splitting this pack's regions, nested the same way (a tree is one JSON, its root pack) |

GDP is an allocation, not a measurement: every GDP number travels with `gdpCaveat`, and consumers
that show GDP should show the caveat too.

### Scores for games

`regions[].stats.score` is the stable object a game reads (vision §8). Every field is measured from the
2021 mesh attributes, whatever the pack's atlas date, and is computed by `app/src/dossier/score.ts`.

| Field | Definition |
|---|---|
| `population` | People in the region, 2021 census. |
| `gdp` | GDP allocated to the region, CAD millions; an allocation, not a measurement, so `gdpCaveat` applies. |
| `resource_index` | Share of the region's labour force in NAICS 11 and 21 (agriculture, forestry, fishing and hunting; mining, quarrying, and oil and gas), 0–1. |
| `cohesion` | 1 − lens variance: each lens column scaled to 0–1 over the scope, its population-weighted variance inside the region averaged over the columns and multiplied by 4 (¼ is the most a 0–1 value can vary), subtracted from 1; the split's own lens, or the Economic preset's columns for a split made without one. |
| `exposure` | The dependency score: the labour-force share of the region's largest industry, 0–1. |

`meridian.getScores(packUrl)` reads them. It is plain JavaScript with no dependencies; paste it into the
game. It returns the root pack's regions: for a tree, walk `pack.children` the same way. The same
object reads unit tables (`getUnitTable`, `jurisdictionOn`; see "Unit tables" below).

<!-- getscores:start -->
```js
const meridian = {
  /** A region pack's scores: [{ id, name, population, gdp, resource_index, cohesion, exposure }]. */
  async getScores(packUrl) {
    const response = await fetch(packUrl);
    if (!response.ok) throw new Error(`${packUrl}: HTTP ${response.status}`);
    const pack = await response.json();
    if (pack.format !== 'meridian.regionPack') throw new Error(`${packUrl} is not a Meridian region pack`);
    if (pack.version !== 1) throw new Error(`RegionPack version ${pack.version}; this helper reads 1`);
    return pack.regions.map((region) => {
      if (!region.stats.score) throw new Error(`region ${region.id} has no score: made before v0.6`);
      return { id: region.id, name: region.name, ...region.stats.score };
    });
  },
  /** A unit table (see "Unit tables"), checked: { format, version, unit, meta, gdpCaveat, rows }. */
  async getUnitTable(tableUrl, unit) {
    const response = await fetch(tableUrl);
    if (!response.ok) throw new Error(`${tableUrl}: HTTP ${response.status}`);
    const gunzipped = response.body.pipeThrough(new DecompressionStream('gzip'));
    const table = await new Response(gunzipped).json();
    if (table.format !== 'meridian.unitTable') throw new Error(`${tableUrl} is not a Meridian unit table`);
    if (table.version !== 1) throw new Error(`UnitTable version ${table.version}; this helper reads 1`);
    if (table.unit !== unit) throw new Error(`${tableUrl} is a table of ${table.unit}, not ${unit}`);
    return table;
  },
  /** The jurisdiction a unit-table row was under on an ISO date (undefined before the first span). */
  jurisdictionOn(row, date) {
    return row.jurisdictions.find((span) => span.from <= date && (span.to === null || date < span.to));
  },
};
```
<!-- getscores:end -->

The House of Cards worked example, under "Unit tables" below, reads these scores from the
`dominion-1867-5` pack.

### Versioning rules

1. **Adding an optional field is not a version bump.** Consumers must ignore fields they do not know.
2. **Removing, renaming or re-typing a field bumps `version`** (to 2), and this page gains a migration
   note under "Migrations" saying how to read the old shape.
3. **A new mesh is a new `meshVersion`, never an edit to an old one.** Its artefacts get new names
   (`mesh.v2.json.gz`, `cells.v2.topojson.gz`), and the old mesh's files stay in `data/build/` so old
   packs can still be drawn and re-fitted.
4. **Pack file names carry the mesh version.** When the presets are rebuilt on a new mesh they are
   written as new files (`alberta-15.v2.json`) beside the old ones, and `index.json` lists the current
   mesh's files.
5. **A consumer checks `meshVersion` before drawing.** Drawing a pack with another mesh's cells puts
   regions in the wrong places without any error.
6. **Moving a pack to another mesh:** an unedited pack is regenerated from its recipe; any pack can be
   re-fitted by giving each new cell the region of the old mesh's nearest cell centre (the app offers
   both when it imports a pack from another mesh; `app/src/import/pack.ts`).
7. **Published packs and unit tables are immutable** (packs 1.0.2, unit tables 1.0.3). A file under
   `packs/` that was in a release keeps its content in every later release: it is never edited in
   place or deleted. A regeneration that comes
   out different on the same mesh is written beside it as `<slug>.<meshVersion>.<n>.json` (n = 2, 3, …)
   and `index.json` moves to it; `npm run presets -w app` does this
   (`app/src/import/packFiles.ts`). CI (`npm run packs:check -w app`) compares every file under
   `packs/` with the previous release tag, as canonical JSON so that reformatting is not a change, and
   fails on any pack changed or removed. `packs/index.json` is the listing, not a pack, and is exempt.
   The same holds for a unit table under `data/build/` (`ridings.v1.json.gz`, `hexes.r4.v1.json.gz`)
   and for the layer a table names in `meta.layer` (`layers/hexes.r4.v1.topojson.gz`): a rebuild that
   comes out different is written beside it as `<name>.<n>.json.gz` (n = 2, 3, …) and the released
   file stays. The same CI check decompresses every unit table at the previous release tag, and the
   layers they name, and fails on any changed or removed.

### Migrations

None yet: v1 is the only version. The Phase 6 fields (`meta.id`, `meta.parentPack`,
`meta.parentRegionId`, `meta.scenario`, `children`, `stats.score`) are optional additions under rule 1.
`stats` was a map of numbers and now also holds the `score` object: a consumer that treats every
`stats` value as a number should skip `score`.

Release 1.0.1 adds, still under rule 1: `meta.premise`, `meta.params.nameBy`, and a scope kind,
`{kind: "provinces", provinces: [...]}` (several provinces or territories as one scope; acadie-2 is
the Maritimes). A new scope kind widens a union rather than adding a field: a reader that validates
`meta.scope` against the 1.0.0 schema rejects such a pack, and should update to
`docs/schemas/regionPack.schema.json`. A reader that only draws the assignment is unaffected.

## Unit tables

Some consumers' unit is not a Meridian region. House of Cards plays on the 343 federal ridings of the
2023 Representation Order, and a region pack cannot carry them: only 215 ridings own a mesh cell, and
the other 128, mostly urban, are smaller than one. So Meridian publishes a table with one row per
riding, built by `pipeline/ridings.py` from the same census and boundary sources as the cells, never
from the cells. For a hex board it also publishes H3 resolution-4 hexagons (about 1,770 km², 45 km
across, roughly a county). Those are coarser than the mesh, so `pipeline/hexes.py` builds them from the
mesh cells, as a region pack does. Release 1.0.5 regenerates them with the large lakes as water, a
neighbour rule that reads straits as water, and settlement dates, and adds the city hexes: the mesh's
own resolution-5 cells (about 250 km², 17 km across) for the hexagons of 100,000 people or more
(`pipeline/hexboard.py`; "The 1.0.5 hex board", below).

| File | `unit` | Rows | From |
|---|---|---|---|
| `data/build/ridings.v1.json.gz` | `fed_2023`: federal electoral districts, 2023 Representation Order | 343, in FED number order | `v1.0.3` |
| `data/build/hexes.r4.v1.json.gz` | `h3_r4`: H3 resolution-4 hexagons that hold at least one mesh cell | 6,011, in H3 index order | `v1.0.4` |
| `data/build/layers/hexes.r4.v1.topojson.gz` | the `h3_r4` hexagons clipped to land, to draw | one geometry per row | `v1.0.4` |
| `data/build/hexes.r4.v1.2.json.gz` | `h3_r4`, regenerated: the hexagons with land, the large lakes being water, the 1.0.5 neighbour rule and settlement dates | 5,986, in H3 index order | `v1.0.5` |
| `data/build/layers/hexes.r4.v1.2.topojson.gz` | its hexagons clipped to land | one geometry per row | `v1.0.5` |
| `data/build/hexes.r5.v1.json.gz` | `h3_r5`: city hexes, the resolution-5 mesh cells with land of the hexagons of 100,000 people or more | 407, in H3 index order | `v1.0.5` |
| `data/build/layers/hexes.r5.v1.topojson.gz` | the city hexes clipped to land | one geometry per row | `v1.0.5` |

A unit table is gzipped JSON, validated by `docs/schemas/unitTable.schema.json` (generated from
`app/src/schema/unitTable.ts`; the Zod schema is the source of truth). Fetch it from the same raw URLs
as the mesh, at the release in the table or later, and decompress it yourself (`raw.githubusercontent.com` serves `.gz`
as plain bytes): `meridian.getUnitTable` in the helper above does both.

### Consumer rules for unit tables

The consumer rules above, as they apply to a table:

1. **Pin a release tag** (`v1.0.3` or later for the ridings, `v1.0.4` or later for the hexagons,
   `v1.0.5` or later for `hexes.r4.v1.2` and the city hexes), never `main`. A published table, and the layer it names, never changes (versioning rule 7).
2. **Key on `unit` and `id`.** A row is identified by the pair, `("fed_2023", 35075)` or
   `("h3_r4", "840e491ffffffff")`, not by its name (ridings are renamed by Act of Parliament) or its
   position. A new representation order is a new `unit` in a new file; it never reuses this one's ids.
   An `h3_r4` id is an H3 index, which names the same hexagon on the globe in every H3 library and
   every release: the ids are stable and can be stored. Which hexagons have rows follows the mesh, so
   a new mesh version could add or drop rows, in a new file.
3. **Ignore fields you do not know.** New optional fields are added without a version bump
   (versioning rule 1).
4. **Check `format`, `version` and `unit`, and refuse otherwise.** `format` must be
   `"meridian.unitTable"`, `version` must be `1`, and `unit` the geography you expect.

### The UnitTable v1 contract

`unit` decides the shape of the rows. Both shapes share `format`, `version`, `meta` (except as noted),
`gdpCaveat`, `lookups`, and in every row `population`, `areaKm2`, `score`, `shares`, `urbanClass`,
`industryDominant`, `places` and `jurisdictions`, with the meanings below.

**`fed_2023`, the ridings:**

| Field | Meaning |
|---|---|
| `format`, `version` | `"meridian.unitTable"`, `1` |
| `unit` | the geography: `"fed_2023"` |
| `meta` | `unitName`; `censusYear` (2021); `gdpMethod` (`allocation_v1`), `gdpReferenceYear` and `gdpPrices`; `atlasVersion` and `jurisdictionsFrom` (`1867-07-01`), the atlas the jurisdictions come from; `sources`, the attribution and licence of each input |
| `gdpCaveat` | GDP is an allocation, not a measurement; show it wherever you show GDP, as with packs |
| `lookups` | labels for `urbanClass` and `industryDominant`, the same as the mesh attributes' |
| `rows[].id`, `name`, `nameFr`, `province` | FED number, English and French names (Elections Canada), two-letter province or territory |
| `rows[].population` | people, 2021 census |
| `rows[].areaKm2` | land area: the Elections Canada polygon, which runs out to sea, clipped to the shoreline of the 2021 census subdivisions |
| `rows[].score` | `population`, `gdp`, `resource_index`, `exposure`, defined as in "Scores for games" (above) |
| `rows[].shares` | `english`, `french`, `indigenous_language`, `other_language` (mother tongue, multiple responses split equally), `indigenous_identity`, `immigrant`; 0–1 |
| `rows[].urbanClass` | 3 CMA, 2 small urban (CA), 1 rural, 0 remote: the class holding most of the riding's people, else rural or remote by density |
| `rows[].industryDominant` | the two-digit NAICS sector with the largest share of the riding's labour force |
| `rows[].places` | every place in `places.v1` (populated census subdivisions) whose point is in the riding, as `{csd, name, population}`, population descending. Each place is in exactly one riding; a CSD can be larger than its riding, so `population` is the whole CSD's |
| `rows[].neighbours` | ids of the ridings sharing a border arc with it in `data/build/layers/ridings.v1.topojson.gz`, ascending; symmetric |
| `rows[].jurisdictions` | `{from, to, unit, name, status, sovereign, share}` spans, contiguous from `1867-07-01`: `from` inclusive, `to` exclusive, `null` for the span in force today. `unit`, `name`, `status` and `sovereign` are the de jure atlas unit covering the largest share of the riding's land, measured as an area overlap with the unit's drawing, never a point test; `share` is that share, the smallest over the span. `fallback: true` marks a span where no unit overlaps the riding and the nearest was taken, with share 0 |

**`h3_r4`, the hexagons.** The same fields, except as follows.

| Field | Meaning |
|---|---|
| `meta` | also `h3Resolution` (4), `meshVersion` (`v1`, the mesh the rows were aggregated from), `layer` (the repository path of the clipped layer) and `landEdgeMetres` (1, see `neighbours`) |
| `gdpCaveat` | the same caveat, worded for mesh cells and hexagons |
| `lookups` | also `ecozone` (the attrs ecozones) and `csdType` (Statistics Canada's census subdivision types); `industryDominant` adds `0`, "no data" |
| `rows[].id` | the H3 index of the hexagon, as 15 lower-case hex digits; rows are in H3 index order, which is string order |
| `rows[].centroid` | `[lng, lat]`, the hexagon's H3 centre, to 5 decimals |
| `rows[].province` | the province or territory holding most of its land; a hexagon with no land takes the province of most of its mesh cells |
| `rows[].cells` | how many resolution-5 mesh cells it is the parent of (up to 7) |
| `rows[].population`, `score`, `shares`, `industryDominant` | summed or population-weighted over its mesh cells from the mesh attributes, exactly as a region pack aggregates cells: a hexagon scores what a region made of its cells would. A hexagon with nobody in it has every share 0 and `industryDominant` 0 |
| `rows[].areaKm2` | land area, measured as for the ridings: the hexagon clipped to the shoreline of the 2021 cartographic census subdivisions. **0 for 21 rows of open water** in Lakes Superior, Huron, Erie and Ontario, which the mesh holds because it counts the Atlas of Canada's inland water as land |
| `rows[].urbanClass` | the class (CMA 3, CA 2) holding most of the hexagon's people, cell by cell, else rural 1 or remote 0 by density over its land |
| `rows[].ecozone` | the ecozone covering the most of its mesh cells' area, key into `lookups.ecozone` |
| `rows[].places` | every `places.v1` place whose point H3 puts in the hexagon, as `{csd, name, population, csdType}`, population descending. `csdType` is the CSD's type code in the 2021 boundary file (`CY` city, `T` town, `VL` village, `IRI` Indian reserve, `NO` unorganized, `RDA` regional district electoral area, and so on), labelled in `lookups.csdType`, so a town can be told from a census label without reading the name. One place, whose point falls in a hexagon with no mesh cell, goes to the hexagon of its mesh cell |
| `rows[].neighbours` | `{id, kind}` for each hexagon in the table that shares an H3 edge with it, ascending by id; symmetric, with the same `kind` both ways. The rule is below |
| `rows[].jurisdictions` | as for the ridings, over the hexagon's land. A hexagon with no land overlaps no unit, so every span is the nearest unit with `fallback: true` |

**The neighbour rule** (`hexes.r4.v1`; the 1.0.5 files have their own, below). Two hexagons in the
table are neighbours when they share an edge of the H3 grid. The link's `kind` is `"land"` when at least `meta.landEdgeMetres` (1 m) of that common edge
lies on land, and `"water"` otherwise. The edge is H3's boundary between the two cells, as a straight
line between its vertices in Statistics Canada Lambert (EPSG:3347). Land is the 2021 cartographic
census subdivisions, the same land as `areaKm2`. In practice no edge carries between 0 and 1 m of
land: 424 links cross none and are water; 16,599 are land, 67 of them with under 1 km of land on an
edge about 25 km long. What the rule measures is the edge, not the journey: a hexagon over a strait
narrower than itself holds both shores. The Strait of Belle Isle is about 15 km wide, and the hexagons
over it hold both the island and Labrador, so their common edges lie on land and Newfoundland is
linked to Labrador by land. The same holds in seven places on the Northumberland Strait, against nine
water links between Prince Edward Island and the mainland, and in the Gulf Islands, which carry a land
link from Vancouver Island to the mainland. A game that needs a strait to be water should treat those
links as it chooses; the table records what lies on the edge. `hexes.r4.v1.2` (1.0.5) reads straits
as water.

**The clipped layer.** `data/build/layers/hexes.r4.v1.topojson.gz` has one object, `hexes`, with one
geometry per row in row order and the row's `id` as its only property. Each geometry is the hexagon's
land, the same land as `areaKm2`, simplified with mapshaper at about 500 m as the ridings layer is.
Neighbours share arcs, and an unclipped hexagon would paint the sea. The sea, Hudson Bay, the Great Lakes
and Lake of the Woods are water. Lakes that the cartographic census subdivisions include are land,
here as in `ridings.v1`: Lake Winnipeg, Lake Manitoba, Great Bear and Great Slave Lakes, Lake Athabasca,
Lake Nipigon and Lac Saint-Jean. The 21 open-water rows are null
geometries (`"type": null`). Draw it like the cells in the Leaflet page below, with
`topojson.feature(topology, topology.objects.hexes)`.

**Scores.** Each is defined as in "Scores for games". For the ridings they are measured on the riding rather than the region:
the 2021 census population; GDP allocated by `allocation_v1` (provincial GDP by industry shared by the
riding's share of the province's labour force in that industry); `resource_index`, the share of the
riding's labour force in NAICS 11 and 21; `exposure`, the share of its largest industry. They are
aggregated from dissemination areas and census subdivision profiles to the riding, each dissemination
area by its representative point, never through mesh cells: a CSD's population and labour force are
spread over the ridings its dissemination areas fall in, by their population.

For the hexagons they are the pack aggregation of the hexagon's cells; `resource_index` and `exposure`
weight the cells' industry shares by population, as packs do.

**No `cohesion`,** in either table. Cohesion is a variance over a region's sub-units with each lens column scaled over a
split's scope. A unit table has no split, no lens and no scope, and any choice of sub-unit and scale
would make a number that means something else under the same name, so the field is omitted rather
than redefined. A game that wants it can compute it over its own groupings of units.

**1.0.4 widens the contract.** `unit` was any snake_case string in the 1.0.3 schema, with one row
shape. It is now a union: `fed_2023` keeps that row shape unchanged, and `h3_r4` adds its own. A
reader that validates against the 1.0.3 `unitTable.schema.json` will reject a hex table and should
update to the current schema. A reader of `ridings.v1.json.gz` alone is unaffected.

**Jurisdictions are the atlas's, not the census's.** They come from the same atlas as the app's
timeline (`atlas.v1`), drawn to about 750 m with islands under 2 km² dropped, which is why a riding's
share is an area overlap and not a point test. Populations and scores are 2021's whatever the date.

### The 1.0.5 hex board

House of Cards tried `hexes.r4.v1` as a board and kept hexagons. Release 1.0.5 answers the trial in
two new tables, each with its layer, under the contract above:

- **`hexes.r4.v1.2`** (`h3_r4`) regenerates `hexes.r4.v1`, written beside it (versioning rule 7). Its
  big lakes are water. Its neighbour rule reads a strait as water. Its rows carry settlement dates.
  The ids are the same H3 indexes, so a consumer's stored ids carry over.
- **`hexes.r5.v1`** (`h3_r5`) holds the city hexes. One resolution-4 hexagon holds all of Toronto, so a
  board can split the crowded hexagons into the mesh's resolution-5 cells.

**`hexes.r4.v1.2`.** Every field means what it means in `hexes.r4.v1`, over the new land, except:

| Field | Meaning |
|---|---|
| `rows` | the hexagons with land, 5,986. The 25 of `hexes.r4.v1` left with none once the large lakes are water are not rows: the 21 open-water rows in the Great Lakes, and 4 in Great Slave Lake and Lake Winnipeg. Nobody lives in them, and population still sums to 36,991,981 |
| `meta` | also `neighbourRule` (`"principalLand"`), `landGapMetres` (600), `lakeMinKm2` (1000), `lakes` (below), `cityPopulation` (100000) and `datesWithheldFrom` (1950). `landEdgeMetres` is 1, as before. `sources` adds the Atlas of Canada waterbodies and islands and the Wikidata dates |
| `rows[].areaKm2` and the layer | land, less the large lakes |
| `rows[].landPoint` | `[lng, lat]`, a point on the hexagon's principal land (below): where to put a counter, and the land its links are read from |
| `rows[].neighbours` | `{id, kind}` for each hexagon in the table sharing an H3 edge with it, under the 1.0.5 rule below; symmetric, with the same `kind` both ways |
| `rows[].settledYear`, `settledPlace`, `settledSource` | "Settlement dates", below |
| `rows[].cityYear`, `cityPlace`, `citySource` | on rows of `meta.cityPopulation` (100,000) people or more only; "Settlement dates", below |

**The large lakes.** A large lake is a named, permanent waterbody of 1,000 km² or more in the Atlas of
Canada 1:1M (NRCan, Open Government Licence – Canada) that is not a river. All 57 are water in
`hexes.r4.v1.2` and the city hexes. The cartographic census subdivisions already leave out
13 of them, at a finer shoreline than the Atlas's, so those keep the CSDs' shore: Lakes Superior,
Michigan, Huron, Erie and Ontario, Georgian Bay, the North Channel, Lake of the Woods, Lake Melville,
Eskimo Lakes, Lake St. Clair, Lake Champlain and Rainy Lake. The other 44 lie inside the census
subdivisions, which count them as land. Those are taken out of the land, less the Atlas's islands
that lie mostly inside them: its lake polygons have no holes, and the islands are a layer of their
own. The test is whether the CSDs hold half of the lake's area or more; every lake is either under
40% held or wholly held. `meta.lakes` lists all 57 with `km2` (the whole lake),
`csdKm2` (how much of it the CSDs hold) and `landKm2` (what was taken out of the hexagons' land).

<!-- lakes:start -->
| Lake | km² | held by the CSDs, km² | taken out of the land, km² |
|---|---|---|---|
| Lake Superior / Lac Supérieur | 86,416 | 1,001 | — |
| Lake Michigan | 61,520 | 0.0 | — |
| Lake Huron / Lac Huron | 43,276 | 677 | — |
| Great Bear Lake / Grand lac de l'Ours | 29,402 | 29,402 | 28,898 |
| Lake Erie / Lac Érié | 27,378 | 63.4 | — |
| Great Slave Lake / Grand lac des Esclaves | 27,243 | 27,243 | 25,368 |
| Lake Winnipeg / Lac Winnipeg | 23,841 | 23,841 | 23,200 |
| Lake Ontario / Lac Ontario | 19,897 | 276 | — |
| Georgian Bay / Baie Georgienne | 14,894 | 888 | — |
| Lake Athabasca / Lac Athabasca | 7,504 | 7,504 | 7,403 |
| North Channel | 7,353 | 2,753 | — |
| Reindeer Lake | 6,420 | 6,420 | 5,270 |
| Smallwood Reservoir | 5,968 | 5,968 | 5,313 |
| Nettilling Lake | 5,373 | 5,373 | 4,845 |
| Lake Winnipegosis / Lac Winnipegosis | 5,270 | 5,270 | 5,053 |
| Réservoir de Caniapiscau | 4,913 | 4,913 | 4,315 |
| Lake Nipigon / Lac Nipigon | 4,841 | 4,841 | 4,434 |
| Lake Manitoba / Lac Manitoba | 4,578 | 4,578 | 4,554 |
| Lake of the Woods / Lac des Bois | 4,382 | 878 | — |
| Réservoir Manicouagan | 3,837 | 3,837 | 1,723 |
| Réservoir Robert-Bourassa | 3,686 | 3,686 | 3,014 |
| Dubawnt Lake | 3,598 | 3,598 | 3,399 |
| Amadjuak Lake | 2,921 | 2,921 | 2,870 |
| Réservoir La Grande 3 | 2,742 | 2,742 | 2,415 |
| Cedar Lake | 2,532 | 2,532 | 2,432 |
| Lake Melville | 2,457 | 104 | — |
| Lac Mistassini | 2,283 | 2,283 | 2,127 |
| Southern Indian Lake | 2,270 | 2,270 | 1,973 |
| Wollaston Lake | 2,128 | 2,128 | 1,750 |
| Eskimo Lakes | 1,852 | 281 | — |
| Nueltin Lake | 1,851 | 1,851 | 1,658 |
| Baker Lake | 1,788 | 1,788 | 1,682 |
| Réservoir Gouin | 1,758 | 1,758 | 1,408 |
| Lac Seul | 1,729 | 1,729 | 1,434 |
| Lac la Martre | 1,687 | 1,687 | 1,604 |
| Williston Lake | 1,579 | 1,579 | 1,579 |
| Playgreen Lake | 1,483 | 1,483 | 1,422 |
| Cree Lake | 1,412 | 1,412 | 1,179 |
| Lac la Ronge | 1,388 | 1,388 | 1,301 |
| Yathkyed Lake | 1,361 | 1,361 | 1,249 |
| Lac Wiyâshâkimî | 1,348 | 1,348 | 1,235 |
| Kasba Lake | 1,306 | 1,306 | 1,267 |
| Lake St. Clair / Lac Sainte-Claire | 1,291 | 27.6 | — |
| Lake Claire | 1,279 | 1,279 | 1,267 |
| Réservoir Laforge 1 | 1,251 | 1,251 | 1,098 |
| Island Lake | 1,170 | 1,170 | 997 |
| Lac Bienville | 1,169 | 1,169 | 974 |
| Gods Lake | 1,097 | 1,097 | 1,011 |
| Lake Champlain / Lac Champlain | 1,095 | 0.6 | — |
| Lesser Slave Lake | 1,089 | 1,089 | 1,088 |
| Contwoyto Lake | 1,061 | 1,061 | 1,034 |
| Lac Saint-Jean | 1,048 | 1,048 | 1,047 |
| Rainy Lake / Lac à la Pluie | 1,016 | 270 | — |
| MacKay Lake | 1,012 | 1,012 | 926 |
| Réservoir Opinaca | 1,011 | 1,011 | 899 |
| Napaktulik Lake | 1,011 | 1,011 | 961 |
| Aberdeen Lake | 1,009 | 1,009 | 1,006 |
<!-- lakes:end -->

**The neighbour rule (1.0.5).** Two hexagons in the table are neighbours when they share an edge of
the H3 grid. The link's `kind` is `"land"` when their principal lands meet along at least
`meta.landEdgeMetres` (1 m) of that edge, and `"water"` otherwise. Exactly:

1. *Land* is the 2021 cartographic census subdivisions less the large lakes, as `areaKm2` measures it.
2. *Closed land* fills water narrower than `meta.landGapMetres`, 600 m. It is a morphological closing
   by 300 m: the land grown by 300 m, then shrunk by 300 m. Land parted by less than 600 m of water
   is joined; land parted by more is not.
3. A *landmass* is a connected piece of closed land, read in the hexagon and the six hexagons around
   it.
4. A hexagon's *principal land* is its part of the landmass holding the most of its land. The
   hexagon stands for that landmass, and `landPoint` is on it. The hexagon's other land, such as the
   far shore of a strait, is drawn and counted in `areaKm2` and the scores, but carries no link.
5. Two hexagons' principal lands meet where both reach their common H3 edge, read as `hexes.r4.v1`
   reads the edge (a straight line between its vertices in EPSG:3347).

The rule looks inside the hexagon. A hexagon holding both shores of the Strait of Belle Isle stands
for one of them, so it does not join Newfoundland to Labrador. Reading the landmass in the six
hexagons around keeps one shore whole where a hexagon's edge cuts an isthmus. Prince Edward Island at
Summerside is one landmass even though the land joining it runs through the next hexagon.

**Why 600 m and not 2 km.** The brief asked for "about 2 km" and named cases. The named cases fix the
gap more tightly than that. The widest water on the shortest way from Vancouver Island to the mainland
is 709 m, at Seymour Narrows and the Discovery Islands. The widest water on Manitoulin's way to the
mainland by Little Current is 471 m. Any gap above 709 m joins Vancouver Island to the mainland, and
any below 471 m parts Manitoulin from it. 600 m lies between the two. It also parts Québec City from
Lévis (622 m at the Québec Bridge), so the St Lawrence is water from there down. Montréal and Laval
reach both shores across at most 166 m. Cape Breton's causeway is land in the census subdivisions.
These widths are measured on the land of rule 1.

`hexes.r4.v1.2` has 15,984 land and 944 water links, where `hexes.r4.v1` had 16,599 and 424. Of the
links in both tables, 596 changed kind: 594 from land to water, most of them in the Arctic
archipelago and on the BC coast, and 2 from water to land, where closed land now crosses an edge
`hexes.r4.v1` read as water. Another 95 went with the rows that have no land. The list is in
`docs/log/2026-10-09-links.md`.

**`hexes.r5.v1`, the city hexes** (`h3_r5`). The rows are the mesh's resolution-5 cells with land,
for every resolution-4 hexagon of `meta.cityPopulation` (100,000) people or more. That is 62
parents and 407 cells. A parent's cells are all there, thinly peopled ones too. The
8 cells with no land are not rows; they are in Lake Ontario and nobody lives in them.
Which parents to split is the consumer's choice: split any of them, or none.

| Field | Meaning |
|---|---|
| `meta` | as for `hexes.r4.v1.2`, with `h3Resolution` 5, `layer` and `parentTable` (`data/build/hexes.r4.v1.2.json.gz`); no `lakes` (the same lakes) and no dates |
| `rows[].id` | the H3 index of the cell, 15 lower-case hex digits; rows in H3 index order |
| `rows[].parent` | its resolution-4 parent, a row of `meta.parentTable` |
| `rows[].centroid`, `province`, `areaKm2`, `landPoint`, `ecozone`, `jurisdictions` | as for the resolution-4 rows, over the cell. `areaKm2` can round to 0 for a sliver of shore |
| `rows[].population`, `score`, `shares`, `urbanClass`, `industryDominant` | the cell's own mesh attributes, which a parent sums: a parent's population is its cells' |
| `rows[].places` | the parent's places, each in the city hex holding its point. A place where the parent's cells do not reach goes to the nearest of them. A parent's places are exactly its city hexes' |
| `rows[].neighbours` | `{id, parent, kind}` for every mesh cell sharing an H3 edge with it, in the table or not, ascending by id. `kind` follows the 1.0.5 rule at resolution 5; a cell with no land is a water link. Symmetric between rows |

**A board with some parents split.** Draw a split parent from its city hexes and the others from
`hexes.r4.v1.2`. Link two city hexes by their own neighbour entry. Link a city hex to an unsplit
parent by the entry for a cell of that parent: use its `kind`, and where several cells of one parent
border the city hex, take land if any entry is land. Two unsplit parents link as in `hexes.r4.v1.2`.
One caveat: an H3 parent and its seven children do not have the same outline. The children's union is
a jagged hexagon that pokes out of the parent on three sides and leaves notches on the other three,
by about 7% of the parent's area each way (140 km² for Toronto's parent). Along a split parent's
border with an unsplit one, the two drawings overlap there and leave small gaps. A consumer that
needs the outlines to agree everywhere can draw every parent from its mesh cells: the cells'
outlines, unclipped, are `cells.v1.topojson.gz`, and their H3 ids are in `mesh.v1.json.gz`.

**Settlement dates.** Every places.v1 place is looked up in Wikidata by its Statistics Canada
geographic code (P3012, read from every non-deprecated statement). The query is
`pipeline/csd_dates.rq`; the result is pinned by hash like the pipeline's other Wikidata source; the
rules are `pipeline/settled.py`. Nothing is estimated.

1. A place's *dates* are the inceptions (P571) of its item, and its "instance of" (P31) statements
   that have a start time (P580) and whose class is a city or town. A class counts when it is a
   subclass of city (Q515), town (Q3957) or city or town (Q7930989) in Wikidata itself. The same dates
   of every *predecessor on record* count too: an item the place's item replaces (P1365), or one
   naming it as what replaced it (P1366). A date less precise than a year is not used.
2. A place's settled date is the earliest of them. Its city date is the earliest city one, a subclass
   of Q515 only. "Provincial or territorial capital city" is a subclass of city in Wikidata, but its
   start is the day a place became a capital, so it is not used.
3. **Amalgamations.** Wikidata's inception of a Canadian municipality is the date of its present
   corporation. For a merged one that is the merger: Halifax Regional Municipality's status dates
   from 1996 and Chatham-Kent from 1998. An earlier predecessor on record wins by being earlier:
   Saguenay (2002) is dated by La Baie (1838). Where the data cannot tell a merger from a founding,
   the place has no date:
   - **the earliest date is 1950 or later** (`meta.datesWithheldFrom`). From then on, mergers
     (Chatham-Kent 1998, Cape Breton 1995, Clarington 1974, Mississauga 1968) and new towns
     (Thompson 1956, Elliot Lake 1955) carry the same kind of inception, and nothing in the data
     tells them apart;
   - **a predecessor is on record but none of them is dated**: the place's own date may be the merger.
4. A row's `settledYear` is the earliest settled date of its places. `settledPlace` is that place
   (`{csd, name}`; on the same date, the more populous place). `settledSource` is the statement:
   `{item, label, property, class?, date, predecessorOf?}`. `property` is `P571` or `P31`, `date` is
   as precise as Wikidata gives it, and `predecessorOf` names the place's own item when the statement
   is a predecessor's. All three are null when no place in the row is dated.
5. On rows of 100,000 people or more, `cityYear` is the city date of the row's principal place, its
   most populous one; `cityPlace` and `citySource` are as above. `cityYear` is null when the row has
   no place, or its principal place has no city date.

The dates are Wikidata's, statements and errors alike. Windsor, Ontario is "city since 1749" there,
which is the French settlement, not the 1892 charter. Coverage: 298 of the 439 rows of 5,000 people
or more have a `settledYear` (68%), and 7 of the 62 rows of 100,000 or more a `cityYear`. The list
Mark reads before any consumer uses the dates is in `docs/log/2026-10-09.md`. A null is a null, not
"unsettled": a consumer that needs a year for every hexagon has to decide what an undated one means.

**1.0.5 widens the contract again.** The new `h3_r4` fields are optional (versioning rule 1), and
`hexes.r4.v1` validates unchanged. `h3_r5` is a third member of the union on `unit`. The exported
schema is closed (`additionalProperties: false`), so a reader that validates against the 1.0.4
`unitTable.schema.json` rejects both 1.0.5 tables and should update. A reader of `ridings.v1` or
`hexes.r4.v1` alone is unaffected.

### Worked example: House of Cards

The entry point for the House of Cards game: the 343 ridings, and which jurisdiction each one was
under on 1 July 1867. Pinned to a release tag (consumer rule 1); `getUnitTable` checks the format,
version and unit (rule 4); the rows are grouped by the fields the example needs, and keyed on
`(unit, id)` when a game stores them (rules 2 and 3).

<!-- hoc-ridings:start -->
```js
const BASE = 'https://raw.githubusercontent.com/mdiamond95/meridian/v1.0.3/';
const ridings = await meridian.getUnitTable(BASE + 'data/build/ridings.v1.json.gz', 'fed_2023');
const groups = new Map();
for (const row of ridings.rows) {
  const { name, sovereign } = meridian.jurisdictionOn(row, '1867-07-01');
  const group = groups.get(name) ?? { name, sovereign, ridings: 0, population: 0 };
  group.ridings += 1;
  group.population += row.population;
  groups.set(name, group);
}
const in1867 = [...groups.values()].sort((a, b) => b.ridings - a.ridings || a.name.localeCompare(b.name));
```
<!-- hoc-ridings:end -->

<!-- hoc-ridings-1867:start -->
| jurisdiction | sovereign | ridings | population |
|---|---|---|---|
| Ontario | Canada | 118 | 13,899,186 |
| Quebec | Canada | 77 | 8,412,746 |
| Rupert's Land | Hudson's Bay Company | 66 | 6,608,842 |
| British Columbia | Britain | 43 | 5,000,879 |
| Nova Scotia | Canada | 11 | 969,383 |
| New Brunswick | Canada | 10 | 775,610 |
| North-Western Territory | Britain | 7 | 650,251 |
| Newfoundland | Britain | 6 | 483,895 |
| Prince Edward Island | Britain | 4 | 154,331 |
| British Arctic Islands | Britain | 1 | 36,858 |
<!-- hoc-ridings-1867:end -->

216 ridings were in the Dominion that day. Ontario has 118 of today's 122: Kenora—Kiiwetinoong,
Kapuskasing—Timmins—Mushkegowuk and the two Thunder Bay ridings lie mostly north or west of the height
of land, in Rupert's Land. Abitibi—Baie-James—Nunavik—Eeyou is Rupert's Land too, and so is Labrador:
in 1867 Newfoundland held only a coastal strip. Populations are 2021's over 1867's land.

**The 1867 Dominion as regions.** The same day as a region pack: Canada as the atlas has it on 1 July
1867 (Ontario, Quebec, Nova Scotia and New Brunswick), taken as one scope, split into five regions
balanced by population, and the scores read back. A pack is the same at every tag (versioning rule 7),
so it is read here at the same tag as the table.

**The split.** The recipe, as the pack's `meta` records it:

<!-- hoc-recipe:start -->
```json
{
  "scope": { "kind": "atlasSovereign", "sovereign": "Canada" },
  "date": "1867-07-01",
  "method": "balanced",
  "n": 5,
  "seed": 1867
}
```
<!-- hoc-recipe:end -->

`atlasSovereign` takes every de jure atlas unit under that sovereign on `date`. Three ways to run it:
in the app, set the timeline to 1867, open **Generate**, choose the scope "A country in the atlas at the
current date" → Canada, the balanced method, 5 regions and seed 1867, and run; open the share link
`#pack=dominion-1867-5`; or run `npm run presets -w app`, which writes it as
`packs/dominion-1867-5.v1.json` (the committed copy). Populations are today's over 1867's land: the mesh
carries the 2021 census, not the 1871 one.

**The scores.** Pinned to a release tag (consumer rule 1); `getScores` above checks the format and
version (rule 4) and reads only the regions' scores (rules 2 and 3).

<!-- hoc-fetch:start -->
```js
const BASE = 'https://raw.githubusercontent.com/mdiamond95/meridian/v1.0.3/';
const scores = await meridian.getScores(BASE + 'packs/dominion-1867-5.v1.json');
```
<!-- hoc-fetch:end -->

<!-- hoc-scores:start -->
| id | name | population | gdp | resource_index | cohesion | exposure |
|---|---|---|---|---|---|---|
| 0 | Great Lakes | 4656377 | 339150 | 0.011 | 0.959 | 0.114 |
| 1 | Ottawa | 4728844 | 323484 | 0.016 | 0.940 | 0.125 |
| 2 | Boreal Shield | 4727998 | 287511 | 0.012 | 0.985 | 0.136 |
| 3 | Thames | 4709164 | 331565 | 0.030 | 0.961 | 0.119 |
| 4 | Rivière Péribonka | 4688581 | 255000 | 0.040 | 0.969 | 0.153 |
<!-- hoc-scores:end -->

`app/src/interop.test.ts` runs every snippet in this example as written on the committed files and
checks they return these tables, that the recipe above is the preset's, and that every URL on this page
is pinned to a release tag that has the file.

## A pack in a vanilla Leaflet page

Twenty lines, no build step. It fetches a pack and the cells of the mesh it names, decodes the
assignment, and dissolves each region's cells with `topojson.merge` (TopoJSON arcs are shared, so the
merge is exact). It follows the consumer rules: a pinned tag, a format and version check, and only
regions' polygons and names kept. The Playwright test `app/tests/smoke/interop.spec.ts` runs this
snippet as written.

<!-- leaflet-snippet:start -->
```html
<!doctype html><meta charset="utf-8"><title>Meridian pack</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js"></script>
<div id="map" style="position:absolute;inset:0"></div>
<script type="module">
const BASE = 'https://raw.githubusercontent.com/mdiamond95/meridian/v1.0.1/';
const pack = await (await fetch(BASE + 'packs/alberta-15.v1.json')).json();
if (pack.format !== 'meridian.regionPack' || pack.version !== 1) throw new Error('not a RegionPack v1');
const gz = await fetch(BASE + `data/build/cells.${pack.meta.meshVersion}.topojson.gz`);
const cells = await new Response(gz.body.pipeThrough(new DecompressionStream('gzip'))).json();
const bytes = Uint8Array.from(atob(pack.assignment.data), (c) => c.charCodeAt(0));
const assignment = new Int32Array(bytes.buffer); // little-endian, one region id per cell
const map = L.map('map');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
const layers = pack.regions.map((region) => L.geoJSON(
  topojson.merge(cells, cells.objects.cells.geometries.filter((_, i) => assignment[i] === region.id)),
  { style: { weight: 1, color: '#333', fillOpacity: 0.4 } }).bindTooltip(region.name).addTo(map));
map.fitBounds(L.featureGroup(layers).getBounds());
</script>
```
<!-- leaflet-snippet:end -->

`raw.githubusercontent.com` serves `.gz` files as plain bytes, which is why the snippet decompresses
with `DecompressionStream` rather than relying on `Content-Encoding`.

## Other formats the app exports

From the **Files** tab (`app/src/export/`):

| Format | What it holds |
|---|---|
| Region pack (`.json`) | the contract above |
| GeoJSON | one Feature per region: a MultiPolygon (right-hand rule, holes nested) with `regionId`, `name`, `capital`, `population`, `areaKm2`, headline dossier fields, and the whole `dossier` |
| TopoJSON | the same regions as one topology (object `regions`) sharing border arcs, same properties |
| KML 2.2 | valid against the OGC schema; a folder per region (its polygon and capital pin) and a folder of dividing lines, the layout used for the Alberta map in Google My Maps |
| SVG, PNG | regions, labels, legend, scale bar, date stamp and attribution |
| Markdown | the set analysis and every dossier, in the Region panel's order, ⟨draft⟩ marks kept |

GeoJSON and KML come back in through the same tab: as a split (each cell to the polygon covering
most of it), as a snap layer, or as the scope of the next split.
