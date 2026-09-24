import type { MeshArrays } from '../engine/graph';
import type { Topology } from '../schema/topojson';

/**
 * Regions dissolved from the hex topology (cells.v1.topojson.gz), in the app.
 *
 * Every cell is a ring of arcs shared with its neighbours. For a region, an arc used by two of its
 * cells is interior and drops out; the arcs used once are its boundary, and they chain end to start
 * into closed rings (outer edges and holes alike — drawn with the even–odd rule, the distinction is
 * not needed).
 */

export type LatLngRing = [number, number][];

export interface CellTopology {
  /** arc → the cells that use it; filled lazily by arcOwners */
  owners?: Map<number, number[]>;
  /** per arc: integer [x, y] points (delta-decoded, not transformed) */
  arcs: number[][][];
  /** per cell: signed arc refs of its ring */
  rings: number[][];
  transform: { scale: [number, number]; translate: [number, number] } | null;
}

export function cellTopology(topology: Topology): CellTopology {
  const object = topology.objects.cells as unknown as { geometries: { arcs: number[][] }[] };
  const t = topology.transform ?? null;
  const arcs = topology.arcs.map((arc) => {
    if (!t) return arc.map((p) => [p[0], p[1]]);
    let x = 0;
    let y = 0;
    return arc.map((p) => [(x += p[0]), (y += p[1])]);
  });
  return {
    arcs,
    rings: object.geometries.map((g) => g.arcs[0]),
    transform: t ? { scale: [t.scale[0], t.scale[1]], translate: [t.translate[0], t.translate[1]] } : null,
  };
}

/** Which cells use each arc (one or two): built once per topology, for boundary walks. */
export function arcOwners(topo: CellTopology): Map<number, number[]> {
  if (topo.owners) return topo.owners;
  const owners = new Map<number, number[]>();
  topo.rings.forEach((ring, cell) => {
    for (const ref of ring) {
      const arc = ref < 0 ? ~ref : ref;
      const list = owners.get(arc);
      if (list) list.push(cell);
      else owners.set(arc, [cell]);
    }
  });
  topo.owners = owners;
  return owners;
}

export interface BoundaryArc {
  arc: number;
  /** the region's cell on this arc */
  inside: number;
  /** the cell on the other side, or -1 outside the mesh */
  outside: number;
  /** [lat, lng] along the arc, in walking order */
  points: LatLngRing;
}

/**
 * A region's boundary as closed runs of arcs, each with the cells on either side, walked clockwise
 * and starting at the north-west corner (plan Phase 4, borders in words).
 */
export function regionBoundary(topo: CellTopology, assignment: Int32Array, region: number): BoundaryArc[][] {
  const owners = arcOwners(topo);
  const refs = new Map<number, number>(); // arc → the ref as the region walks it
  for (let cell = 0; cell < assignment.length; cell++) {
    if (assignment[cell] !== region) continue;
    for (const ref of topo.rings[cell]) {
      const arc = ref < 0 ? ~ref : ref;
      const both = owners.get(arc) ?? [];
      const other = both.find((c) => c !== cell) ?? -1;
      if (other >= 0 && assignment[other] === region) continue; // interior
      refs.set(arc, ref);
    }
  }
  const pieces: BoundaryArc[] = [];
  const byStart = new Map<string, number[]>();
  for (const [arc, ref] of refs) {
    const raw = ref < 0 ? topo.arcs[arc].slice().reverse() : topo.arcs[arc];
    const inside = (owners.get(arc) ?? []).find((c) => assignment[c] === region) ?? -1;
    const outside = (owners.get(arc) ?? []).find((c) => c !== inside) ?? -1;
    const key = `${raw[0][0]},${raw[0][1]}`;
    const list = byStart.get(key);
    if (list) list.push(pieces.length);
    else byStart.set(key, [pieces.length]);
    pieces.push({ arc, inside, outside, points: raw.map((p) => toLatLng(topo, p)) });
  }

  const used = new Uint8Array(pieces.length);
  const rings: BoundaryArc[][] = [];
  const raws = [...refs].map(([arc, ref]) => (ref < 0 ? topo.arcs[arc].slice().reverse() : topo.arcs[arc]));
  for (let start = 0; start < pieces.length; start++) {
    if (used[start]) continue;
    const ring: BoundaryArc[] = [];
    let current = start;
    for (;;) {
      used[current] = 1;
      ring.push(pieces[current]);
      const raw = raws[current];
      const end = raw[raw.length - 1];
      const next = (byStart.get(`${end[0]},${end[1]}`) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      current = next;
    }
    rings.push(orient(ring));
  }
  return rings;
}

/** Clockwise (negative shoelace in lng/lat), starting at the north-west arc. */
function orient(ring: BoundaryArc[]): BoundaryArc[] {
  const points = ring.flatMap((a) => a.points);
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j][1] - points[i][1]) * (points[j][0] + points[i][0]);
  }
  const walked =
    area > 0 ? ring : [...ring].reverse().map((a) => ({ ...a, points: [...a.points].reverse() }));
  let best = 0;
  walked.forEach((arc, i) => {
    const [lat, lng] = arc.points[0];
    const [bestLat, bestLng] = walked[best].points[0];
    if (lat > bestLat + 0.05 || (Math.abs(lat - bestLat) <= 0.05 && lng < bestLng)) best = i;
  });
  return [...walked.slice(best), ...walked.slice(0, best)];
}

/** Rings per region id for a mesh-indexed assignment (cells with -1 are skipped). */
export function regionRings(topo: CellTopology, assignment: Int32Array): Map<number, LatLngRing[]> {
  const uses = new Map<number, Map<number, number>>(); // region → arc → signed ref (0 once used twice)
  const counts = new Map<number, Map<number, number>>();
  for (let cell = 0; cell < assignment.length; cell++) {
    const r = assignment[cell];
    if (r < 0) continue;
    let refs = uses.get(r);
    let count = counts.get(r);
    if (!refs || !count) {
      refs = new Map();
      count = new Map();
      uses.set(r, refs);
      counts.set(r, count);
    }
    for (const ref of topo.rings[cell]) {
      const arc = ref < 0 ? ~ref : ref;
      count.set(arc, (count.get(arc) ?? 0) + 1);
      refs.set(arc, ref);
    }
  }
  const out = new Map<number, LatLngRing[]>();
  for (const [r, refs] of uses) {
    const count = counts.get(r) as Map<number, number>;
    const byStart = new Map<string, number[]>();
    const pieces: number[][][] = [];
    for (const [arc, ref] of refs) {
      if (count.get(arc) !== 1) continue;
      const points = ref < 0 ? topo.arcs[arc].slice().reverse() : topo.arcs[arc];
      const key = `${points[0][0]},${points[0][1]}`;
      const list = byStart.get(key);
      if (list) list.push(pieces.length);
      else byStart.set(key, [pieces.length]);
      pieces.push(points);
    }
    const used = new Uint8Array(pieces.length);
    const rings: LatLngRing[] = [];
    for (let start = 0; start < pieces.length; start++) {
      if (used[start]) continue;
      const ring: number[][] = [];
      let current = start;
      for (;;) {
        used[current] = 1;
        const points = pieces[current];
        ring.push(...(ring.length ? points.slice(1) : points));
        const end = points[points.length - 1];
        const next = (byStart.get(`${end[0]},${end[1]}`) ?? []).find((i) => !used[i]);
        if (next === undefined) break;
        current = next;
      }
      rings.push(ring.map((p) => toLatLng(topo, p)));
    }
    out.set(r, rings);
  }
  return out;
}

function toLatLng(topo: CellTopology, p: number[]): [number, number] {
  const t = topo.transform;
  if (!t) return [p[1], p[0]];
  return [p[1] * t.scale[1] + t.translate[1], p[0] * t.scale[0] + t.translate[0]];
}

/** Nearest mesh cell centre to a point, within `maxDeg` degrees (a 1° grid, built once). */
export function cellLocator(mesh: MeshArrays) {
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number) => (x + 400) * 1000 + (y + 200);
  const n = mesh.areas.length;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(mesh.centroids[2 * i]), Math.floor(mesh.centroids[2 * i + 1]));
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  return (lng: number, lat: number, maxDeg = 0.25): number => {
    const gx = Math.floor(lng);
    const gy = Math.floor(lat);
    const kx = Math.cos((lat * Math.PI) / 180);
    let best = -1;
    let bestD = maxDeg * maxDeg;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of grid.get(key(gx + dx, gy + dy)) ?? []) {
          const ex = (mesh.centroids[2 * i] - lng) * kx;
          const ey = mesh.centroids[2 * i + 1] - lat;
          const d = ex * ex + ey * ey;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  };
}

/**
 * Region rings flattened into typed arrays, so the worker can transfer them to the main thread
 * without copying (release 1.0.1): cloning a Canada split's rings as nested arrays is some 100,000
 * small arrays to deserialize on the main thread.
 */
export interface EncodedRings {
  /** region id of each entry */
  regions: Int32Array;
  /** rings of entry i are ringStart[i]..ringStart[i + 1] */
  ringStart: Int32Array;
  /** points of ring j are pointStart[j]..pointStart[j + 1] */
  pointStart: Int32Array;
  /** [lat, lng] per point */
  coords: Float64Array;
}

export function encodeRings(rings: Map<number, LatLngRing[]>): EncodedRings {
  const entries = [...rings];
  const ringCount = entries.reduce((n, [, shape]) => n + shape.length, 0);
  const pointCount = entries.reduce((n, [, shape]) => n + shape.reduce((m, ring) => m + ring.length, 0), 0);
  const out: EncodedRings = {
    regions: new Int32Array(entries.length),
    ringStart: new Int32Array(entries.length + 1),
    pointStart: new Int32Array(ringCount + 1),
    coords: new Float64Array(pointCount * 2),
  };
  let ring = 0;
  let point = 0;
  entries.forEach(([region, shape], i) => {
    out.regions[i] = region;
    out.ringStart[i] = ring;
    for (const r of shape) {
      out.pointStart[ring++] = point;
      for (const [lat, lng] of r) {
        out.coords[2 * point] = lat;
        out.coords[2 * point + 1] = lng;
        point++;
      }
    }
  });
  out.ringStart[entries.length] = ring;
  out.pointStart[ringCount] = point;
  return out;
}

export function decodeRings(encoded: EncodedRings): Map<number, LatLngRing[]> {
  const out = new Map<number, LatLngRing[]>();
  const { regions, ringStart, pointStart, coords } = encoded;
  for (let i = 0; i < regions.length; i++) {
    const shape: LatLngRing[] = [];
    for (let j = ringStart[i]; j < ringStart[i + 1]; j++) {
      const ring: LatLngRing = new Array(pointStart[j + 1] - pointStart[j]);
      for (let p = pointStart[j], k = 0; p < pointStart[j + 1]; p++, k++)
        ring[k] = [coords[2 * p], coords[2 * p + 1]];
      shape.push(ring);
    }
    out.set(regions[i], shape);
  }
  return out;
}

export const ringBuffers = (r: EncodedRings): ArrayBuffer[] =>
  [r.regions, r.ringStart, r.pointStart, r.coords].map((a) => a.buffer as ArrayBuffer);
