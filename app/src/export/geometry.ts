import type { MultiPolygon, Position } from 'geojson';
import { arcOwners, type CellTopology } from '../splitter/outline';

/**
 * Region geometry for export (plan Phase 5 §1): each region dissolved from the hex topology into a
 * GeoJSON MultiPolygon with its holes nested and wound by the right-hand rule, the lines dividing
 * neighbouring regions, and a TopoJSON that keeps the shared arcs shared.
 *
 * A region's boundary is the arcs its cells use once (outline.ts). On a hex mesh every vertex has
 * zero or two of them, so the arcs chain into simple rings; which are outer rings and which are holes
 * is decided by nesting, not by the order they were walked.
 */

/** Coordinates are rounded to 1e-6° (about 0.1 m): far finer than a 250 km² cell. */
const round = (x: number) => Math.round(x * 1e6) / 1e6;

function position(topo: CellTopology, p: number[]): Position {
  const t = topo.transform;
  if (!t) return [round(p[0]), round(p[1])];
  return [round(p[0] * t.scale[0] + t.translate[0]), round(p[1] * t.scale[1] + t.translate[1])];
}

const arcIndex = (ref: number) => (ref < 0 ? ~ref : ref);

function arcPoints(topo: CellTopology, ref: number): number[][] {
  const points = topo.arcs[arcIndex(ref)];
  return ref < 0 ? points.slice().reverse() : points;
}

/** Each region's boundary as closed rings of signed arc refs into topo.arcs. */
export function regionArcRings(topo: CellTopology, assignment: Int32Array): Map<number, number[][]> {
  // An arc the region uses once is on its boundary; twice (two of its cells, or one cell's ring
  // running out along a spike and back) it is interior.
  const uses = new Map<number, Map<number, number[]>>(); // region → arc → signed refs
  for (let cell = 0; cell < assignment.length; cell++) {
    const r = assignment[cell];
    if (r < 0) continue;
    let arcs = uses.get(r);
    if (!arcs) uses.set(r, (arcs = new Map()));
    for (const ref of topo.rings[cell]) {
      const list = arcs.get(arcIndex(ref));
      if (list) list.push(ref);
      else arcs.set(arcIndex(ref), [ref]);
    }
  }
  const boundary = new Map<number, number[]>();
  for (const [r, arcs] of uses) {
    boundary.set(
      r,
      [...arcs.values()].filter((refs) => refs.length === 1).map((refs) => refs[0]),
    );
  }
  const out = new Map<number, number[][]>();
  for (const [r, refs] of [...boundary].sort((a, b) => a[0] - b[0])) {
    if (!refs.length) continue;
    const byStart = new Map<string, number[]>();
    refs.forEach((ref, i) => {
      const key = arcPoints(topo, ref)[0].join(',');
      const list = byStart.get(key);
      if (list) list.push(i);
      else byStart.set(key, [i]);
    });
    const used = new Uint8Array(refs.length);
    const rings: number[][] = [];
    for (let start = 0; start < refs.length; start++) {
      if (used[start]) continue;
      const ring: number[] = [];
      for (let current: number | undefined = start; current !== undefined;) {
        used[current] = 1;
        ring.push(refs[current]);
        const points = arcPoints(topo, refs[current]);
        const end = points[points.length - 1].join(',');
        current = (byStart.get(end) ?? []).find((i) => !used[i]);
      }
      rings.push(ring);
    }
    // The cell topology has a few edges stored as two identical arcs, one per cell; walked, they make
    // zero-area spikes (A→B→C→B→A), which are not rings at all. A real ring holds at least one cell.
    out.set(
      r,
      rings.filter((ring) => Math.abs(signedArea(ringPositions(topo, ring))) > 1e-10),
    );
  }
  return out;
}

/** A ring of arc refs as closed [lng, lat] positions. */
function ringPositions(topo: CellTopology, ring: number[]): Position[] {
  const points: number[][] = [];
  for (const ref of ring) {
    const arc = arcPoints(topo, ref);
    points.push(...(points.length ? arc.slice(1) : arc));
  }
  const out = points.map((p) => position(topo, p));
  const [first, last] = [out[0], out[out.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) out.push([...first]);
  return out;
}

/** Twice the signed area in lng/lat: positive when counter-clockwise. */
export function signedArea(ring: Position[]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return area;
}

export function inRing(ring: Position[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

interface Nested {
  /** index of each ring's outer ring (itself for an outer ring) */
  parent: number[];
  /** true where the ring is an outer ring */
  outer: boolean[];
}

/**
 * Which rings are holes, and in which outer ring. A ring's depth is how many other rings contain it
 * (tested at the midpoint of its first edge, which no other ring of the region can pass through, as
 * rings share no edges); even depth is an outer ring, odd a hole in the innermost ring around it.
 */
function nest(rings: Position[][]): Nested {
  const boxes = rings.map((ring) => {
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const areas = rings.map((ring) => Math.abs(signedArea(ring)));
  const containers = rings.map((ring, i) => {
    const x = (ring[0][0] + ring[1][0]) / 2;
    const y = (ring[0][1] + ring[1][1]) / 2;
    return rings
      .map((_, j) => j)
      .filter((j) => {
        if (j === i) return false;
        const [x0, y0, x1, y1] = boxes[j];
        return x >= x0 && x <= x1 && y >= y0 && y <= y1 && inRing(rings[j], x, y);
      });
  });
  const outer = containers.map((c) => c.length % 2 === 0);
  const parent = containers.map((c, i) => {
    if (outer[i]) return i;
    const depth = c.length - 1;
    const candidates = c.filter((j) => containers[j].length === depth);
    return candidates.sort((a, b) => areas[a] - areas[b])[0];
  });
  return { parent, outer };
}

/** Outer rings counter-clockwise, holes clockwise (RFC 7946 §3.1.6). */
function wind(ring: Position[], ccw: boolean): Position[] {
  return signedArea(ring) > 0 === ccw ? ring : ring.slice().reverse();
}

export function regionMultiPolygons(topo: CellTopology, assignment: Int32Array): Map<number, MultiPolygon> {
  const out = new Map<number, MultiPolygon>();
  for (const [r, arcRings] of regionArcRings(topo, assignment)) {
    const rings = arcRings.map((ring) => ringPositions(topo, ring));
    const { parent, outer } = nest(rings);
    const polygons = new Map<number, Position[][]>();
    rings.forEach((ring, i) => {
      if (outer[i]) polygons.set(i, [wind(ring, true)]);
    });
    rings.forEach((ring, i) => {
      if (!outer[i]) polygons.get(parent[i])?.push(wind(ring, false));
    });
    out.set(r, { type: 'MultiPolygon', coordinates: [...polygons.values()] });
  }
  return out;
}

export interface DividingLine {
  /** the two regions, a < b */
  regions: [number, number];
  lines: Position[][];
}

/** The lines between neighbouring regions, one entry per pair, arcs chained end to end. */
export function dividingLines(topo: CellTopology, assignment: Int32Array): DividingLine[] {
  const pairs = new Map<string, { regions: [number, number]; arcs: number[][][] }>();
  for (const [arc, cells] of arcOwners(topo)) {
    if (cells.length !== 2) continue;
    const [a, b] = cells.map((c) => assignment[c]);
    if (a < 0 || b < 0 || a === b) continue;
    const regions: [number, number] = a < b ? [a, b] : [b, a];
    const key = regions.join(',');
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, (pair = { regions, arcs: [] }));
    pair.arcs.push(topo.arcs[arc]);
  }
  return [...pairs.values()]
    .sort((x, y) => x.regions[0] - y.regions[0] || x.regions[1] - y.regions[1])
    .map(({ regions, arcs }) => ({
      regions,
      lines: chain(arcs).map((line) => line.map((p) => position(topo, p))),
    }));
}

/** Join arcs that meet end to end into as few lines as possible (either direction). */
function chain(arcs: number[][][]): number[][][] {
  const key = (p: number[]) => p.join(',');
  const ends = new Map<string, number[]>();
  arcs.forEach((arc, i) => {
    for (const p of [arc[0], arc[arc.length - 1]]) {
      const list = ends.get(key(p));
      if (list) list.push(i);
      else ends.set(key(p), [i]);
    }
  });
  const used = new Uint8Array(arcs.length);
  const next = (p: number[]) => (ends.get(key(p)) ?? []).find((i) => !used[i]);
  const lines: number[][][] = [];
  for (let start = 0; start < arcs.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    let line = arcs[start].slice();
    for (let i = next(line[line.length - 1]); i !== undefined; i = next(line[line.length - 1])) {
      used[i] = 1;
      const arc = key(arcs[i][0]) === key(line[line.length - 1]) ? arcs[i] : arcs[i].slice().reverse();
      line = line.concat(arc.slice(1));
    }
    for (let i = next(line[0]); i !== undefined; i = next(line[0])) {
      used[i] = 1;
      const arc = key(arcs[i][arcs[i].length - 1]) === key(line[0]) ? arcs[i] : arcs[i].slice().reverse();
      line = arc.slice(0, -1).concat(line);
    }
    lines.push(line);
  }
  return lines;
}

export interface RegionTopology {
  type: 'Topology';
  transform?: { scale: [number, number]; translate: [number, number] };
  objects: {
    regions: {
      type: 'GeometryCollection';
      geometries: { type: 'MultiPolygon'; id: number; properties: object; arcs: number[][][] }[];
    };
  };
  arcs: number[][][];
}

/**
 * The regions as one TopoJSON topology: the boundary arcs of the hex topology, re-indexed and
 * delta-encoded under the same quantization, so a border between two regions is one arc used by
 * both. Rings are nested and wound as in the GeoJSON.
 */
export function regionTopology(
  topo: CellTopology,
  assignment: Int32Array,
  properties: (region: number) => object,
): RegionTopology {
  const index = new Map<number, number>();
  const arcs: number[][][] = [];
  const remap = (ref: number) => {
    const arc = arcIndex(ref);
    let i = index.get(arc);
    if (i === undefined) {
      i = arcs.length;
      index.set(arc, i);
      arcs.push(topo.arcs[arc]);
    }
    return ref < 0 ? ~i : i;
  };
  const geometries = [...regionArcRings(topo, assignment)].map(([r, arcRings]) => {
    const rings = arcRings.map((ring) => ringPositions(topo, ring));
    const { parent, outer } = nest(rings);
    const windRefs = (i: number, ccw: boolean) =>
      signedArea(rings[i]) > 0 === ccw
        ? arcRings[i]
        : arcRings[i]
            .slice()
            .reverse()
            .map((ref) => ~ref);
    const polygons = new Map<number, number[][]>();
    arcRings.forEach((_, i) => {
      if (outer[i]) polygons.set(i, [windRefs(i, true)]);
    });
    arcRings.forEach((_, i) => {
      if (!outer[i]) polygons.get(parent[i])?.push(windRefs(i, false));
    });
    return {
      type: 'MultiPolygon' as const,
      id: r,
      properties: properties(r),
      arcs: [...polygons.values()].map((polygon) => polygon.map((ring) => ring.map(remap))),
    };
  });
  const encoded = topo.transform
    ? arcs.map((arc) => arc.map((p, i) => (i ? [p[0] - arc[i - 1][0], p[1] - arc[i - 1][1]] : [p[0], p[1]])))
    : arcs;
  return {
    type: 'Topology',
    ...(topo.transform ? { transform: topo.transform } : {}),
    objects: { regions: { type: 'GeometryCollection', geometries } },
    arcs: encoded,
  };
}
