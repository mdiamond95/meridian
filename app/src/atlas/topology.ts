import type { MultiPolygon, Polygon, Position } from 'geojson';
import { ringsToMultiPolygon, signedArea } from '../export/geometry';
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
  return topologyTools(topology).decode;
}

/** Every ring of a polygon object, as arc refs. */
function objectRings(topology: Topology, key: string): Ring[] {
  const object = topology.objects[key];
  if (!object) throw new Error(`topology has no object ${key}`);
  if (object.type === 'Polygon') return object.arcs as Ring[];
  if (object.type === 'MultiPolygon') return (object.arcs as Ring[][]).flat();
  throw new Error(`topology object ${key} is a ${object.type}, not a polygon`);
}

/**
 * Decode objects, and merge several into one polygon with their shared borders dissolved (what
 * topojson-client's `merge` does): an arc used by exactly one ring of the set is on the outside; an arc
 * used twice is a border between two of them, and is dropped. The rest chain into rings end to end.
 */
export function topologyTools(topology: Topology) {
  const arcs = decodeArcs(topology);
  const decode = (key: string): Polygon | MultiPolygon => {
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
  const merge = (keys: readonly string[]): MultiPolygon => {
    const uses = new Map<number, number[]>();
    for (const key of keys) {
      for (const ring of objectRings(topology, key)) {
        for (const ref of ring) {
          const index = ref < 0 ? ~ref : ref;
          const list = uses.get(index);
          if (list) list.push(ref);
          else uses.set(index, [ref]);
        }
      }
    }
    const refs = [...uses.values()].filter((list) => list.length === 1).map((list) => list[0]);
    const points = (ref: number) => (ref < 0 ? arcs[~ref].slice().reverse() : arcs[ref]);
    const byStart = new Map<string, number[]>();
    refs.forEach((ref, i) => {
      const k = points(ref)[0].join(',');
      const list = byStart.get(k);
      if (list) list.push(i);
      else byStart.set(k, [i]);
    });
    const used = new Uint8Array(refs.length);
    const rings: Position[][] = [];
    for (let start = 0; start < refs.length; start++) {
      if (used[start]) continue;
      const ring: number[] = [];
      for (let current: number | undefined = start; current !== undefined;) {
        used[current] = 1;
        ring.push(refs[current]);
        const arc = points(refs[current]);
        current = (byStart.get(arc[arc.length - 1].join(',')) ?? []).find((i) => !used[i]);
      }
      const coords = ringCoordinates(ring, arcs);
      const [first, last] = [coords[0], coords[coords.length - 1]];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
      if (Math.abs(signedArea(coords)) > 1e-12) rings.push(coords);
    }
    return ringsToMultiPolygon(rings);
  };
  return { decode, merge };
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
