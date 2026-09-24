# OGC KML 2.2 schema (vendored for tests)

The KML export is validated against these files in Vitest (`src/export/kml.test.ts`), offline:

- `ogckml22.xsd` and `atom-author-link.xsd` — <https://schemas.opengis.net/kml/2.2.0/>, © 2008 Open
  Geospatial Consortium, distributed under the OGC software and document notice.
- `xAL.xsd` — <http://docs.oasis-open.org/election/external/xAL.xsd>, OASIS CIQ xAL 2.0.

One local change: `ogckml22.xsd` imports xAL from `xAL.xsd` beside it instead of the OASIS URL, so the
validator never fetches over the network. The files are otherwise as downloaded on 2026-09-24.
