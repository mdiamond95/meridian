import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { Topology } from '../schema/topojson';

/**
 * Decode polygon objects from a TopoJSON Topology (the atlas geometry written by mapshaper).
 *
 * Arcs are delta-encoded when the topology is quantized (`transform` present). A negative arc index
 * ~i means arc i reversed. Only Polygon and MultiPolygon objects occur in the atlas.
 */

type Ring = number[];

function decodeArcs(topology: Topology): Position[][] {
  const t = topology.transform;
  return topology.arcs.map((arc) => {
    if (!t) return arc.map((p) => [p[0], p[1]]);
    let x = 0;
    let y = 0;
    return arc.map((p) => {
      x += p[0];
      y += p[1];
      return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]];
    });
  });
}

function ringCoordinates(ring: Ring, arcs: Position[][]): Position[] {
  const coords: Position[] = [];
  ring.forEach((index, k) => {
    const arc = index < 0 ? arcs[~index].slice().reverse() : arcs[index];
    // Consecutive arcs share their joining point; keep it once.
    coords.push(...(k === 0 ? arc : arc.slice(1)));
  });
  return coords;
}

/** A decoder bound to one topology; arcs are decoded once and shared by every object. */
export function topologyDecoder(topology: Topology) {
  const arcs = decodeArcs(topology);
  return (key: string): Polygon | MultiPolygon => {
    const object = topology.objects[key];
    if (!object) throw new Error(`topology has no object ${key}`);
    if (object.type === 'Polygon') {
      return { type: 'Polygon', coordinates: (object.arcs as Ring[]).map((r) => ringCoordinates(r, arcs)) };
    }
    if (object.type === 'MultiPolygon') {
      return {
        type: 'MultiPolygon',
        coordinates: (object.arcs as Ring[][]).map((poly) => poly.map((r) => ringCoordinates(r, arcs))),
      };
    }
    throw new Error(`topology object ${key} is a ${object.type}, not a polygon`);
  };
}

/** [west, south, east, north] of a polygon geometry. */
export function bounds(geometry: Polygon | MultiPolygon): [number, number, number, number] {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const poly of polys) {
    for (const [x, y] of poly[0]) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  }
  return [w, s, e, n];
}
