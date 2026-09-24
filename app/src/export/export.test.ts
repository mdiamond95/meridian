// @vitest-environment node
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { hint } from '@mapbox/geojsonhint';
import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import type { FeatureCollection } from 'geojson';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import { DOMParser, type Document, type Element } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { validateXML } from 'xmllint-wasm';
import { mulberry32 } from '../engine/prng';
import { checkPack, refitAssignment } from '../import/pack';
import { assignByTemplate, templateFromGeoJSON } from '../import/template';
import { TopologySchema } from '../schema/topojson';
import { cellTopology } from '../splitter/outline';
import { decodePack } from '../splitter/pack';
import { REGION_HUES } from '../splitter/palette';
import { realSplitterData } from '../splitter/testing/realSplitterData';
import { exportInput, packExportSource } from './build';
import { regionsGeoJSON, regionsKML, regionsSVG, regionsTopoJSON } from './formats';

/**
 * Phase 5 interop, on the shipped presets and the committed mesh: every export passes its format's
 * validator and comes back in as the same cells, and a pack re-fits onto another mesh version.
 */

const data = realSplitterData();
const topo = cellTopology(
  TopologySchema.parse(
    JSON.parse(
      gunzipSync(readFileSync(new URL('../../../data/build/cells.v1.topojson.gz', import.meta.url))).toString(
        'utf8',
      ),
    ),
  ),
);
const readPack = (id: string) =>
  decodePack(JSON.parse(readFileSync(new URL(`../../../packs/${id}.v1.json`, import.meta.url), 'utf8')));
const inputFor = (id: string) =>
  exportInput(packExportSource(readPack(id), id, REGION_HUES), data, topo, '2026-09-24');

const KML_SCHEMA = new URL('./testing/kml22/', import.meta.url);
const schemaFile = (fileName: string) => ({
  fileName,
  contents: readFileSync(new URL(fileName, KML_SCHEMA), 'utf8'),
});

describe.each(['alberta-15', 'canada-26'])('%s exports', { timeout: 60_000 }, (id) => {
  const pack = readPack(id);
  const input = inputFor(id);

  it('GeoJSON passes geojsonhint, right-hand rule included, one feature per region', () => {
    const geojson = regionsGeoJSON(input);
    expect(hint(JSON.stringify(geojson))).toEqual([]);
    expect(geojson.features.map((f) => f.properties?.name)).toEqual(pack.regions.map((r) => r.name));
    for (const f of geojson.features) {
      expect(f.properties?.dossier?.name).toBe(f.properties?.name);
      expect(f.properties?.gdpCaveat).toMatch(/estimate/);
    }
  });

  it('GeoJSON and TopoJSON come back in as the same cells', () => {
    const geojson = JSON.parse(JSON.stringify(regionsGeoJSON(input))) as FeatureCollection;
    expect(assignByTemplate(templateFromGeoJSON(geojson), data, topo)).toEqual(pack.assignment);

    const topology = JSON.parse(JSON.stringify(regionsTopoJSON(input))) as Topology;
    const decoded = feature(topology, topology.objects.regions) as FeatureCollection;
    expect(assignByTemplate(templateFromGeoJSON(decoded), data, topo)).toEqual(pack.assignment);
    // A border is one arc used by both regions, so there are fewer arcs than references to them.
    const regions = topology.objects.regions as unknown as { geometries: { arcs: number[][][] }[] };
    const refs = regions.geometries.flatMap((g) => g.arcs.flat(2)).length;
    expect(topology.arcs.length).toBeLessThan(refs);
  });

  it('the pack round-trips through its file unchanged', () => {
    const check = checkPack(JSON.parse(JSON.stringify(input.pack)), data.meshVersion);
    expect(check.kind).toBe('same-mesh');
    expect(check.pack.assignment).toEqual(pack.assignment);
    expect(check.pack.regions).toEqual(pack.regions);
  });

  it('KML validates against the OGC 2.2 schema and re-parses to the same cells', async () => {
    const kml = regionsKML(input);
    const result = await validateXML({
      xml: [{ fileName: `${id}.kml`, contents: kml }],
      schema: [schemaFile('ogckml22.xsd')],
      preload: [schemaFile('atom-author-link.xsd'), schemaFile('xAL.xsd')],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.valid).toBe(true);

    const doc = new DOMParser().parseFromString(kml, 'application/xml');
    // One folder per region, and one for the dividing lines.
    expect(doc.getElementsByTagName('Folder')).toHaveLength(pack.regions.length + 1);
    const parsed = kmlToGeoJSON(doc as unknown as globalThis.Document) as FeatureCollection;
    // Region placemarks carry a regionId; capital pins add role=capital; dividing lines neither.
    const polygons = parsed.features.filter(
      (f) => f.properties?.regionId !== undefined && f.properties?.role === undefined,
    );
    expect(polygons.map((f) => f.properties?.name)).toEqual(pack.regions.map((r) => r.name));
    expect(parsed.features.filter((f) => f.geometry?.type === 'Point').length).toBeGreaterThan(0);
    expect(assignByTemplate(templateFromGeoJSON(parsed), data, topo)).toEqual(pack.assignment);
  }, 60_000);

  it('SVG is well-formed and carries labels, legend, scale bar, date stamp and attribution', () => {
    const svg = regionsSVG(input);
    const doc = new DOMParser({
      onError: (level, msg) => {
        throw new Error(`${level}: ${msg}`);
      },
    }).parseFromString(svg, 'image/svg+xml');
    const group = (id: string) => byId(doc, id);
    expect(childrenNamed(group('regions'), 'path')).toHaveLength(pack.regions.length);
    const labels = childrenNamed(group('labels'), 'text').map((t) => t.textContent);
    expect(labels).toEqual(pack.regions.map((r) => r.name));
    expect(childrenNamed(group('legend'), 'rect')).toHaveLength(pack.regions.length);
    expect(childrenNamed(group('scale-bar'), 'text')[0].textContent).toMatch(/^\d[\d,]* km$/);
    expect(group('date-stamp').textContent).toContain('Made 2026-09-24');
    expect(group('attribution').textContent).toContain('Open Government Licence – Canada');
  });
});

function byId(doc: Document, id: string): Element {
  const found = Array.from(doc.getElementsByTagName('*')).find((el) => el.getAttribute('id') === id);
  if (!found) throw new Error(`no #${id}`);
  return found;
}

function childrenNamed(el: Element, tag: string): Element[] {
  return Array.from(el.getElementsByTagName(tag));
}

describe('re-fit across mesh versions', () => {
  it('alberta-15 re-fitted onto a synthetic v2 mesh keeps over 98% of its people in the same region', () => {
    const pack = readPack('alberta-15');
    const n = data.cellIds.length;
    const { centroids } = data.arrays;
    const population = data.columns.population;
    const rng = mulberry32(20260924);
    const random = () => rng.next();

    // v2: drop 1% of cells, add 1% (each between two neighbouring cells), nudge every kept centre by
    // up to 2 km, and order the cells differently, so nothing can be matched by index.
    const dropped = new Set<number>();
    while (dropped.size < Math.round(n / 100)) dropped.add(Math.floor(random() * n));
    const v2: { from: number; lng: number; lat: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (dropped.has(i)) continue;
      const kx = Math.cos((centroids[2 * i + 1] * Math.PI) / 180);
      v2.push({
        from: i,
        lng: centroids[2 * i] + ((random() - 0.5) * 4) / (111.2 * kx),
        lat: centroids[2 * i + 1] + ((random() - 0.5) * 4) / 111.2,
      });
    }
    const { offsets, targets } = data.arrays;
    for (let added = 0; added < Math.round(n / 100);) {
      const a = Math.floor(random() * n);
      if (offsets[a + 1] === offsets[a]) continue;
      const b = targets[offsets[a] + Math.floor(random() * (offsets[a + 1] - offsets[a]))];
      v2.push({
        from: -1,
        lng: (centroids[2 * a] + centroids[2 * b]) / 2,
        lat: (centroids[2 * a + 1] + centroids[2 * b + 1]) / 2,
      });
      added++;
    }
    v2.sort((p, q) => p.lat - q.lat || p.lng - q.lng);
    const newCentroids = Float64Array.from(v2.flatMap((c) => [c.lng, c.lat]));

    const refit = refitAssignment(centroids, pack.assignment, newCentroids);

    let total = 0;
    let same = 0;
    for (let i = 0; i < n; i++) if (pack.assignment[i] >= 0) total += population[i];
    v2.forEach((cell, j) => {
      if (cell.from >= 0 && pack.assignment[cell.from] >= 0 && refit[j] === pack.assignment[cell.from]) {
        same += population[cell.from];
      }
    });
    expect(total).toBeGreaterThan(4_000_000);
    expect(same / total).toBeGreaterThan(0.98);
    // Every region survives the move.
    expect(new Set(refit.filter((r) => r >= 0)).size).toBe(pack.regions.length);
  });
});
