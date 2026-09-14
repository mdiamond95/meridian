# Meridian

A boundary generator for Canada. It treats every way of carving up the country as one
operation: assign mesh cells to regions under rules, then describe what you made. See
[docs/vision.md](docs/vision.md) and [docs/plan.md](docs/plan.md).

**Live:** https://mdiamond95.github.io/meridian/

Status: Phase 0, the scaffold. The map shell deploys; there is no data yet.

## Commands

From the repo root (in a Codespace everything is already installed):

```sh
npm test          # unit tests (Vitest)
npm run build     # typecheck and build the app to app/dist
npm run smoke     # Playwright loads the built site and checks the map renders (build first)
```

The pipeline has one command so far:

```sh
make dry-run      # validate pipeline/artefacts.yaml and print the artefact plan; downloads nothing
```

Also available: `npm run dev`, `npm run lint`, `npm run schemas` (re-export
`docs/schemas/*.json` after changing `app/src/schema`), and `make lint` / `make test` for
the pipeline.

## Layout

```
app/          Vite + React 18 + TypeScript app; contracts in app/src/schema
pipeline/     Python 3.12 data pipeline (uv); artefacts.yaml is the build plan
data/raw/     downloads, gitignored
data/build/   versioned build artefacts, committed
docs/         vision, plan, decisions, data sources, exported JSON Schemas
```

## Basemap key

CARTO watermarks Positron tiles requested without a key. Get a free key at
<https://carto.com/basemaps/apikey>, then add it as the repository **variable**
`CARTO_BASEMAPS_KEY` (Settings → Secrets and variables → Actions → Variables) and re-run
the Pages workflow. For local builds, put `VITE_CARTO_KEY=...` in `app/.env.local`.

## Licence

Code: MIT. Data: per source, see [docs/data-sources.md](docs/data-sources.md).
