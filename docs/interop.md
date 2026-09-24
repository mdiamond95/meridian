# Interop: sharing a split with other projects

How a Meridian split leaves this repo and comes back: the shared pack folder, the RegionPack v1
contract, the rules for changing it, and a vanilla Leaflet page that draws a pack in twenty lines (for
the cities atlas and Birdseye).

## Where packs live

Shared packs are in the top-level **`packs/`** folder of this repo, one file per pack, named
**`<slug>.<meshVersion>.json`** (`alberta-15.v1.json`). `packs/index.json` lists them
(`format: "meridian.packLibrary"`, each entry's `id`, `name`, `description` and `file`).

| Who | Fetches |
|---|---|
| The Meridian app | `packs/<file>` by relative URL (served from `packs/` in dev, copied into the build) |
| Other projects, following changes | `https://raw.githubusercontent.com/mdiamond95/meridian/main/packs/<file>` |
| Other projects, pinned | `https://raw.githubusercontent.com/mdiamond95/meridian/<tag>/packs/<file>`, e.g. tag `v0.5-interop` |

To draw a pack you also need the mesh it was made on. The cell polygons are
`data/build/cells.<meshVersion>.topojson.gz` (gzipped TopoJSON, object `cells`, one Polygon per mesh
cell in cell-index order), and the cells themselves (H3 ids, centroids, provinces) are
`data/build/mesh.<meshVersion>.json.gz`. Both are fetched from the same raw URLs.

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
game. It returns the root pack's regions: for a tree, walk `pack.children` the same way.

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
};
```
<!-- getscores:end -->

### Worked example: House of Cards

The entry point for the House of Cards game: Canada as the atlas has it on 1 July 1867 (Ontario,
Quebec, Nova Scotia and New Brunswick), taken as one scope, split into five regions balanced by
population, and the scores read back.

**1. The split.** The recipe, as the pack's `meta` records it:

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

**2. The scores.**

```js
const BASE = 'https://raw.githubusercontent.com/mdiamond95/meridian/v0.6-scenarios/';
const scores = await meridian.getScores(BASE + 'packs/dominion-1867-5.v1.json');
```

<!-- hoc-scores:start -->
| id | name | population | gdp | resource_index | cohesion | exposure |
|---|---|---|---|---|---|---|
| 0 | Great Lakes | 4656377 | 339150 | 0.011 | 0.959 | 0.114 |
| 1 | Ottawa | 4728844 | 323484 | 0.016 | 0.940 | 0.125 |
| 2 | Boreal Shield | 4727998 | 287511 | 0.012 | 0.985 | 0.136 |
| 3 | Thames | 4709164 | 331565 | 0.030 | 0.961 | 0.119 |
| 4 | Rivière Péribonka | 4688581 | 255000 | 0.040 | 0.969 | 0.153 |
<!-- hoc-scores:end -->

`app/src/interop.test.ts` runs the helper above as written on the committed pack and checks it
returns this table, and that the recipe above is the preset's.

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

### Migrations

None yet: v1 is the only version. The Phase 6 fields (`meta.id`, `meta.parentPack`,
`meta.parentRegionId`, `meta.scenario`, `children`, `stats.score`) are optional additions under rule 1.
`stats` was a map of numbers and now also holds the `score` object: a consumer that treats every
`stats` value as a number should skip `score`.

## A pack in a vanilla Leaflet page

Twenty lines, no build step. It fetches a pack and the cells of the mesh it names, decodes the
assignment, and dissolves each region's cells with `topojson.merge` (TopoJSON arcs are shared, so the
merge is exact). The Playwright test `app/tests/smoke/interop.spec.ts` runs this snippet as written.

<!-- leaflet-snippet:start -->
```html
<!doctype html><meta charset="utf-8"><title>Meridian pack</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js"></script>
<div id="map" style="position:absolute;inset:0"></div>
<script type="module">
const BASE = 'https://raw.githubusercontent.com/mdiamond95/meridian/main/';
const pack = await (await fetch(BASE + 'packs/alberta-15.v1.json')).json();
const gz = await fetch(BASE + `data/build/cells.${pack.meta.meshVersion}.topojson.gz`);
const cells = await new Response(gz.body.pipeThrough(new DecompressionStream('gzip'))).json();
const bytes = Uint8Array.from(atob(pack.assignment.data), (c) => c.charCodeAt(0));
const assignment = new Int32Array(bytes.buffer); // little-endian, one region id per cell
const map = L.map('map');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);
const cellGeoms = cells.objects.cells.geometries;
const layers = pack.regions.map((region) => L.geoJSON(
  topojson.merge(cells, cellGeoms.filter((_, i) => assignment[i] === region.id)),
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
