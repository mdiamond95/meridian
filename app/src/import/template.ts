import { kml as kmlToGeoJSON } from '@tmcw/togeojson';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Position } from 'geojson';
import type { SplitterData } from '../splitter/data';
import type { CellTopology } from '../splitter/outline';

/**
 * GeoJSON or KML polygons brought into the splitter (plan Phase 5 §2), used one of three ways:
 *
 * - as a template: every cell goes to the polygon covering most of it, so a map drawn elsewhere
 *   becomes a split of the mesh;
 * - as a snap layer: mesh edges whose two cells fall in different polygons (or one in, one out);
 * - as a scope: the polygons' union, to split inside.
 */

export interface Template {
  /** one entry per region: its name and polygons */
  regions: { id: number; name: string; polygons: Position[][][] }[];
}

/**
 * A geometry's polygons: a Polygon, a MultiPolygon, or the polygons of a GeometryCollection (which is
 * how @tmcw/togeojson reads a KML MultiGeometry of several polygons).
 */
function polygonsOf(geometry: Geometry | null): Position[][][] {
  if (!geometry) return [];
  switch (geometry.type) {
    case 'Polygon':
      return [geometry.coordinates];
    case 'MultiPolygon':
      return geometry.coordinates;
    case 'GeometryCollection':
      return geometry.geometries.flatMap(polygonsOf);
    default:
      return [];
  }
}

/**
 * The polygons of a FeatureCollection, one region per feature. A feature's `regionId` (as Meridian
 * exports write) keeps its id when every feature has a distinct one; otherwise features are numbered
 * in order. Points and lines (capital pins, dividing lines) are ignored.
 */
export function templateFromGeoJSON(collection: FeatureCollection | Feature): Template {
  const features = (collection.type === 'FeatureCollection' ? collection.features : [collection])
    .map((feature) => ({ feature, polygons: polygonsOf(feature.geometry) }))
    .filter((f) => f.polygons.length > 0);
  if (!features.length) throw new Error('no polygons in the file');
  const ids = features.map((f) => Number(f.feature.properties?.regionId));
  const keepIds = ids.every((id) => Number.isInteger(id) && id >= 0) && new Set(ids).size === ids.length;
  return {
    regions: features.map(({ feature, polygons }, i) => ({
      id: keepIds ? ids[i] : i,
      name: String(feature.properties?.name ?? feature.properties?.Name ?? `Region ${i + 1}`),
      polygons,
    })),
  };
}

export function parseKML(text: string): FeatureCollection {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('the KML is not well-formed XML');
  return kmlToGeoJSON(doc) as FeatureCollection;
}

/** Parse an uploaded file's text as GeoJSON or KML (by content, not extension). */
export function parseGeoFile(text: string): FeatureCollection | Feature {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) return parseKML(text);
  const json = JSON.parse(text) as { type?: string };
  if (json.type === 'FeatureCollection' || json.type === 'Feature')
    return json as FeatureCollection | Feature;
  throw new Error('not GeoJSON: expected a FeatureCollection or a Feature');
}

function inPolygon(polygon: Position[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of polygon) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** A point locator over the template's polygons: the region id holding (x, y), or -1. */
export function templateLocator(template: Template) {
  const parts = template.regions.flatMap((region) =>
    region.polygons.map((polygon) => {
      const xs = polygon[0].map((p) => p[0]);
      const ys = polygon[0].map((p) => p[1]);
      return {
        id: region.id,
        polygon,
        box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      };
    }),
  );
  return (x: number, y: number): number => {
    for (const { id, polygon, box } of parts) {
      if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3] && inPolygon(polygon, x, y)) return id;
    }
    return -1;
  };
}

/** Sample points for a cell: its centre, and 60% of the way from it to each corner of its ring. */
function cellSamples(topo: CellTopology, data: SplitterData, cell: number): [number, number][] {
  const cx = data.arrays.centroids[2 * cell];
  const cy = data.arrays.centroids[2 * cell + 1];
  const samples: [number, number][] = [[cx, cy]];
  const t = topo.transform;
  const corners: number[][] = [];
  for (const ref of topo.rings[cell] ?? []) {
    const arc = topo.arcs[ref < 0 ? ~ref : ref];
    corners.push(ref < 0 ? arc[arc.length - 1] : arc[0]);
  }
  for (const p of corners) {
    const x = t ? p[0] * t.scale[0] + t.translate[0] : p[0];
    const y = t ? p[1] * t.scale[1] + t.translate[1] : p[1];
    samples.push([cx + 0.6 * (x - cx), cy + 0.6 * (y - cy)]);
  }
  return samples;
}

/**
 * Cells by majority overlap: a cell whose samples are mostly inside the template goes to the region
 * holding the most of them (ties to the lower id); a cell mostly outside stays out (-1).
 */
export function assignByTemplate(template: Template, data: SplitterData, topo: CellTopology): Int32Array {
  const locate = templateLocator(template);
  const n = data.cellIds.length;
  const out = new Int32Array(n).fill(-1);
  for (let cell = 0; cell < n; cell++) {
    const samples = cellSamples(topo, data, cell);
    const counts = new Map<number, number>();
    let inside = 0;
    for (const [x, y] of samples) {
      const id = locate(x, y);
      if (id < 0) continue;
      inside++;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (inside * 2 <= samples.length) continue;
    let best = -1;
    let bestCount = 0;
    for (const [id, count] of counts) {
      if (count > bestCount || (count === bestCount && id < best)) {
        best = id;
        bestCount = count;
      }
    }
    out[cell] = best;
  }
  return out;
}

/** Mesh edge keys (u * n + v, u < v) whose two cells the template puts on different sides. */
export function templateSnapEdges(assignment: Int32Array, data: SplitterData): Set<number> {
  const n = data.cellIds.length;
  const { offsets, targets } = data.arrays;
  const edges = new Set<number>();
  for (let u = 0; u < n; u++) {
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      const v = targets[e];
      if (u < v && assignment[u] !== assignment[v]) edges.add(u * n + v);
    }
  }
  return edges;
}

/** The template's polygons as one MultiPolygon, for a polygon scope (coordinates to 1e-4°). */
export function templateScope(template: Template): MultiPolygon {
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    type: 'MultiPolygon',
    coordinates: template.regions.flatMap((region) =>
      region.polygons.map((polygon) => polygon.map((ring) => ring.map((p) => [r(p[0]), r(p[1])]))),
    ),
  };
}
