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
   The same holds for a unit table under `data/build/` (`ridings.v1.json.gz`): a rebuild that comes
   out different is written beside it as `ridings.v1.<n>.json.gz` (n = 2, 3, …) and the released file
   stays; the same CI check decompresses every unit table at the previous release tag and fails on any
   changed or removed.

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
from the cells.

| File | `unit` | Rows |
|---|---|---|
| `data/build/ridings.v1.json.gz` | `fed_2023`: federal electoral districts, 2023 Representation Order | 343, in FED number order |

A unit table is gzipped JSON, validated by `docs/schemas/unitTable.schema.json` (generated from
`app/src/schema/unitTable.ts`; the Zod schema is the source of truth). Fetch it from the same raw URLs
as the mesh, at `v1.0.3` or later, and decompress it yourself (`raw.githubusercontent.com` serves `.gz`
as plain bytes): `meridian.getUnitTable` in the helper above does both.

### Consumer rules for unit tables

The consumer rules above, as they apply to a table:

1. **Pin a release tag** (`v1.0.3` or later), never `main`. A published table never changes
   (versioning rule 7).
2. **Key on `unit` and `id`.** A row is identified by the pair, `("fed_2023", 35075)`, not by its
   name (ridings are renamed by Act of Parliament) or its position. A new representation order is a
   new `unit` in a new file; it never reuses this one's ids.
3. **Ignore fields you do not know.** New optional fields are added without a version bump
   (versioning rule 1).
4. **Check `format`, `version` and `unit`, and refuse otherwise.** `format` must be
   `"meridian.unitTable"`, `version` must be `1`, and `unit` the geography you expect.

### The UnitTable v1 contract

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

**Scores.** Each is defined as in "Scores for games", measured on the riding rather than the region:
the 2021 census population; GDP allocated by `allocation_v1` (provincial GDP by industry shared by the
riding's share of the province's labour force in that industry); `resource_index`, the share of the
riding's labour force in NAICS 11 and 21; `exposure`, the share of its largest industry. They are
aggregated from dissemination areas and census subdivision profiles to the riding, each dissemination
area by its representative point, never through mesh cells: a CSD's population and labour force are
spread over the ridings its dissemination areas fall in, by their population.

**No `cohesion`.** Cohesion is a variance over a region's sub-units with each lens column scaled over a
split's scope. A riding table has no split, no lens and no scope, and any choice of sub-unit and scale
would make a number that means something else under the same name, so the field is omitted rather
than redefined. A game that wants it can compute it over its own groupings of ridings.

**Jurisdictions are the atlas's, not the census's.** They come from the same atlas as the app's
timeline (`atlas.v1`), drawn to about 750 m with islands under 2 km² dropped, which is why a riding's
share is an area overlap and not a point test. Populations and scores are 2021's whatever the date.

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
