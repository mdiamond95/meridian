# Meridian

**A map of Canada you can redraw.** Meridian shows how the country's borders changed from the Hudson's
Bay Company charter of 1670 to today. It lets you split Canada, or any province, or Canada as it stood
in any year, into new regions by population, economy, language, geography or chance. Then it describes
each region it made.

**Live:** https://mdiamond95.github.io/meridian/ — built for an iPad, and works offline after the first
visit.

## What it can do

- **Historical atlas.** Drag the timeline, or use the arrow keys, to see the country's first-order
  borders on any date since 1670.
  - Every change is cited to the statute or order that made it.
  - Three truth layers: what the law said, what was actually controlled, and what was claimed or
    disputed (hatched).
  - Before the atlas begins: Indigenous language families, and a contact frontier showing when
    Europeans first reached each area.
- **The splitter.** Choose an area and a number of regions, and the engine assigns 38,432 small
  hexagons of land to regions under your rules.
  - The area can be Canada, a province, a historical unit, a region you already made, or a shape you
    draw.
  - The rules: balance by population, cut along the sharpest differences in a chosen "lens", grow
    from capitals, or chance.
  - Pin cities together or apart, and snap borders to rivers, watersheds, treaties or ridings.
  - Paint cells by hand afterwards: the judgement is yours.
  - Presets to start from: Alberta in 15, Canada in 26 and in 14, the Dominion of 1867 in five, and
    Acadie and the Maritimes, the three Maritime provinces split on French mother tongue.
- **Dossiers.** Every region gets:
  - a name, a capital, its population and area, and an estimated GDP;
  - its industries, and its borders described in words;
  - its language and treaty profile.

  The whole set gets a power ranking and a federalism panel: what it would break in the Senate, the
  amending formula, equalization, Quebec's asymmetry and territorial status. Compare any two splits,
  or a split against actual Canada.
- **Scenarios.** Change a year and carry the change forward:
  - Newfoundland stays out in 1949;
  - Alberta and Saskatchewan are one province called Buffalo;
  - the 1912 extensions never happen;
  - the Maritimes unite.

  Split any region again, as deep as you like.
- **Take it with you.** Export a split as a region pack (JSON), GeoJSON, TopoJSON, KML for Google My
  Maps, SVG, PNG, or Markdown dossiers. Import GeoJSON and KML.
  - Share links reproduce a split exactly.
  - Other projects read the packs through a documented contract ([docs/interop.md](docs/interop.md)).

Every source and licence is listed in the app (Layers → Licences and sources) and in
[docs/data-sources.md](docs/data-sources.md).

## Three commands

From the repo root (in a Codespace everything is already installed):

```sh
npm test          # unit tests (Vitest)
npm run build     # typecheck and build the app to app/dist
npm run smoke     # Playwright loads the built site and checks it works (build first)
```

`npm run dev` runs the app locally. The data pipeline rebuilds every map artefact from public sources
byte for byte (`make download`, `make build`, `make verify`; see
[pipeline/README.md](pipeline/README.md)). Also available: `npm run lint`,
`npm run frame-time -w app` (performance, [docs/perf.md](docs/perf.md)),
`npm run determinism -w app` (the same split in three browsers), and `make test`.

## Honest limits

- Sub-provincial GDP is an allocation, never a measurement; the tool labels it so everywhere.
- Pre-1871 population is estimate and interpolation; pre-1600 is Indigenous population estimates with wide bands.
- Indigenous territory polygons are approximations of relationships that were not polygonal; the atlas says so on the layer itself.
- "Accurate borders for every year" is achievable for first-order units; it is not achievable for sub-provincial districts before roughly 1880 without a research project of its own. Scope districts to the events we can source.
- The engine will produce ugly regions where the data is thin (the North). The lens method's judgement — what a region would call itself — is not automatable; the manual override exists because of that.

## More

- [CHANGELOG.md](CHANGELOG.md): what each release added.
- [docs/vision.md](docs/vision.md): the full design.
- [docs/plan.md](docs/plan.md): the phases.
- [docs/decisions.md](docs/decisions.md): why things are the way they are.

## Layout

```
app/          Vite + React 18 + TypeScript app; contracts in app/src/schema
pipeline/     Python 3.12 data pipeline (uv); artefacts.yaml is the build plan
data/raw/     downloads, gitignored
data/build/   versioned build artefacts, committed
docs/         vision, plan, decisions, data sources, exported JSON Schemas
```

## Basemap key

Pages uses CARTO Positron, which needs a free key from <https://carto.com/basemaps/apikey>.
Set it as the repository **variable** `CARTO_BASEMAPS_KEY` (Settings → Secrets and variables
→ Actions → Variables). The Pages workflow fails without it. Local builds and CI without a
key fall back to OpenStreetMap standard tiles and log a console warning. To use CARTO
locally, run `CARTO_BASEMAPS_KEY=... npm run build`, or put the line in `app/.env.local`.

## Licence

Code: MIT. Data: per source, see [docs/data-sources.md](docs/data-sources.md).
