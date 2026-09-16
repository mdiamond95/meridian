import type { MultiPolygon, Polygon, Position } from 'geojson';
import type { LoadedAtlas } from '../atlas/loadAtlas';
import { resolveUnits } from '../atlas/resolve';
import type { ProvinceCode } from '../schema/mesh';
import type { Scope } from '../schema/regionPack';
import { DEG, detCos } from './detmath';

/**
 * The solver's graph: mesh neighbours restricted to a scope, as compact CSR arrays indexed by
 * *local* cell index (0..size-1, in mesh order, so iteration order is fixed by cell id).
 *
 * Sea crossings. The mesh has no edges over salt water, so Canada is 50 components and a scope
 * like Canada or Nunavut is several. Under hard contiguity an island could then only ever be a
 * region of its own. The graph joins components by their closest pair of cell centres, repeatedly
 * (Borůvka, ties by local index), and marks those edges as crossings: they make a region that spans
 * a strait contiguous, and they are not boundary length. Newfoundland joins Labrador or Cape Breton,
 * Vancouver Island the Lower Mainland, the Arctic islands one another.
 */

/** What the solver needs from the mesh; plain arrays so it can cross into a worker. */
export interface MeshArrays {
  /** CSR over mesh cells: neighbours of cell i are targets[offsets[i]..offsets[i+1]). */
  offsets: Int32Array;
  targets: Int32Array;
  /** [lng, lat] per cell, flattened. */
  centroids: Float64Array;
  /** km² per cell. */
  areas: Float64Array;
}

export interface ScopeGraph {
  size: number;
  /** local index → mesh index */
  cells: Int32Array;
  /** mesh index → local index, or -1 outside the scope */
  local: Int32Array;
  offsets: Int32Array;
  targets: Int32Array;
  /** 1 where the edge at the same position in `targets` is a sea crossing */
  crossing: Uint8Array;
  /** crossings added, for reporting */
  crossings: number;
}

export interface MeshLike {
  cells: { centroid: [number, number]; area: number; province: string; neighbours: number[] }[];
}

export function meshArrays(mesh: MeshLike): MeshArrays {
  const n = mesh.cells.length;
  const offsets = new Int32Array(n + 1);
  mesh.cells.forEach((cell, i) => (offsets[i + 1] = offsets[i] + cell.neighbours.length));
  const targets = new Int32Array(offsets[n]);
  const centroids = new Float64Array(2 * n);
  const areas = new Float64Array(n);
  mesh.cells.forEach((cell, i) => {
    targets.set(cell.neighbours, offsets[i]);
    centroids[2 * i] = cell.centroid[0];
    centroids[2 * i + 1] = cell.centroid[1];
    areas[i] = cell.area;
  });
  return { offsets, targets, centroids, areas };
}

// --- scope masks ------------------------------------------------------------------------------

export interface ScopeContext {
  /** Province per mesh cell, for province scopes. */
  provinces?: readonly string[];
  /** For atlasUnit scopes: the loaded atlas and the date to resolve at. */
  atlas?: LoadedAtlas;
  date?: string;
  /** For region scopes: the pack's assignment (mesh-indexed). */
  assignment?: Int32Array;
}

/** 1 for every mesh cell in the scope. Area scopes test each cell's centre. */
export function scopeMask(mesh: MeshArrays, scope: Scope, context: ScopeContext = {}): Uint8Array {
  const n = mesh.areas.length;
  const mask = new Uint8Array(n);
  switch (scope.kind) {
    case 'canada':
      mask.fill(1);
      break;
    case 'province': {
      if (!context.provinces) throw new Error('province scope needs the mesh provinces');
      const code: ProvinceCode = scope.province;
      for (let i = 0; i < n; i++) mask[i] = context.provinces[i] === code ? 1 : 0;
      break;
    }
    case 'atlasUnit': {
      const { atlas, date } = context;
      if (!atlas || !date) throw new Error('atlasUnit scope needs the atlas and a date');
      const unit = resolveUnits(atlas.atlas, date, ['dejure', 'defacto', 'disputed']).find(
        (u) => u.id === scope.unit,
      );
      const geometry = unit && atlas.geometries.get(unit.geometryRef);
      if (!geometry) throw new Error(`atlas unit ${scope.unit} does not exist on ${date}`);
      fillByGeometry(mesh, geometry, mask);
      break;
    }
    case 'region': {
      if (!context.assignment) throw new Error('region scope needs the pack assignment');
      for (let i = 0; i < n; i++) mask[i] = context.assignment[i] === scope.region ? 1 : 0;
      break;
    }
    case 'polygon':
      fillByGeometry(mesh, scope.geometry as Polygon | MultiPolygon, mask);
      break;
  }
  return mask;
}

function fillByGeometry(mesh: MeshArrays, geometry: Polygon | MultiPolygon, mask: Uint8Array) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const boxes = polygons.map(bbox);
  for (let i = 0; i < mask.length; i++) {
    const x = mesh.centroids[2 * i];
    const y = mesh.centroids[2 * i + 1];
    mask[i] = polygons.some((rings, p) => inBox(boxes[p], x, y) && inPolygon(rings, x, y)) ? 1 : 0;
  }
}

function bbox(rings: Position[][]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of rings[0]) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

function inBox(b: [number, number, number, number], x: number, y: number) {
  return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
}

/** Even–odd ray casting over the outer ring and its holes. */
export function inPolygon(rings: Position[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// --- the graph --------------------------------------------------------------------------------

const KM_PER_DEG = 111.195;

/** Planar km between two cell centres (equirectangular at their mean latitude; deterministic). */
export function centreKm(centroids: Float64Array, a: number, b: number): number {
  const dx =
    (centroids[2 * a] - centroids[2 * b]) * detCos(((centroids[2 * a + 1] + centroids[2 * b + 1]) / 2) * DEG);
  const dy = centroids[2 * a + 1] - centroids[2 * b + 1];
  return Math.sqrt(dx * dx + dy * dy) * KM_PER_DEG;
}

export function buildScopeGraph(mesh: MeshArrays, mask: Uint8Array): ScopeGraph {
  const n = mask.length;
  const local = new Int32Array(n).fill(-1);
  const cellList: number[] = [];
  for (let i = 0; i < n; i++) if (mask[i]) local[i] = cellList.push(i) - 1;
  const size = cellList.length;
  const cells = Int32Array.from(cellList);

  const adjacency: number[][] = Array.from({ length: size }, () => []);
  for (let u = 0; u < size; u++) {
    const m = cells[u];
    for (let e = mesh.offsets[m]; e < mesh.offsets[m + 1]; e++) {
      const v = local[mesh.targets[e]];
      if (v >= 0) adjacency[u].push(v);
    }
  }
  const crossingPairs = seaCrossings(adjacency, cells, mesh.centroids);
  const crossingSet = new Set<number>();
  for (const [u, v] of crossingPairs) {
    adjacency[u].push(v);
    adjacency[v].push(u);
    crossingSet.add(u * size + v).add(v * size + u);
  }

  const offsets = new Int32Array(size + 1);
  for (let u = 0; u < size; u++) {
    adjacency[u].sort((a, b) => a - b);
    offsets[u + 1] = offsets[u] + adjacency[u].length;
  }
  const targets = new Int32Array(offsets[size]);
  const crossing = new Uint8Array(offsets[size]);
  for (let u = 0; u < size; u++) {
    adjacency[u].forEach((v, k) => {
      targets[offsets[u] + k] = v;
      crossing[offsets[u] + k] = crossingSet.has(u * size + v) ? 1 : 0;
    });
  }
  return { size, cells, local, offsets, targets, crossing, crossings: crossingPairs.length };
}

/** Component label per node, numbered by lowest node. */
export function components(adjacency: number[][]): Int32Array {
  const label = new Int32Array(adjacency.length).fill(-1);
  let count = 0;
  for (let start = 0; start < adjacency.length; start++) {
    if (label[start] >= 0) continue;
    label[start] = count;
    const stack = [start];
    while (stack.length) {
      const u = stack.pop() as number; // the loop checks length
      for (const v of adjacency[u]) {
        if (label[v] < 0) {
          label[v] = count;
          stack.push(v);
        }
      }
    }
    count++;
  }
  return label;
}

/**
 * Edges joining every component into one. Each round, every component but the largest finds its
 * closest pair of centres to a cell outside it; edges are added in (km, u, v) order when they join
 * two groups. Only edge cells (fewer than six neighbours) are searched: the closest approach between
 * two pieces of a hex tiling is always between edge cells. A 1° grid over edge cells keeps each
 * search local, and distances use each query cell's own cos(latitude), computed once.
 */
function seaCrossings(adjacency: number[][], cells: Int32Array, centroids: Float64Array): [number, number][] {
  const size = cells.length;
  if (size < 2) return [];
  const label = components(adjacency);
  const groupCount = label.reduce((a, b) => Math.max(a, b), 0) + 1;
  if (groupCount === 1) return [];

  const parent = Array.from({ length: groupCount }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };

  const lng = (u: number) => centroids[2 * cells[u]];
  const lat = (u: number) => centroids[2 * cells[u] + 1];
  const edgeCells: number[] = [];
  for (let u = 0; u < size; u++) if (adjacency[u].length < 6) edgeCells.push(u);
  const kmPerLng = new Float64Array(size);
  for (const u of edgeCells) kmPerLng[u] = KM_PER_DEG * detCos(lat(u) * DEG);

  const grid = new Map<number, number[]>();
  const key = (gx: number, gy: number) => (gx + 400) * 1000 + (gy + 200);
  for (const u of edgeCells) {
    const k = key(Math.floor(lng(u)), Math.floor(lat(u)));
    const list = grid.get(k);
    if (list) list.push(u);
    else grid.set(k, [u]);
  }
  // The shortest possible degree of longitude on the mesh (83°N), bounded with cos 84°.
  const minKmPerDeg = KM_PER_DEG * detCos(84 * DEG);

  const edges: [number, number][] = [];
  for (;;) {
    const group = Int32Array.from(label, (c) => find(c));
    const sizes = new Map<number, number>();
    group.forEach((g) => sizes.set(g, (sizes.get(g) ?? 0) + 1));
    if (sizes.size === 1) break;
    let largest = -1;
    for (const [g, n] of sizes) {
      const current = largest < 0 ? -1 : (sizes.get(largest) ?? -1);
      if (largest < 0 || n > current || (n === current && g < largest)) largest = g;
    }

    const best = new Map<number, [number, number, number]>();
    for (const u of edgeCells) {
      const g = group[u];
      if (g === largest) continue;
      const gx = Math.floor(lng(u));
      const gy = Math.floor(lat(u));
      const known = best.get(g);
      let found: [number, number] | null = known ? [-1, known[0]] : null;
      for (let ring = 0; ring < 120; ring++) {
        if (found && (ring - 1) * minKmPerDeg > found[1]) break;
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
            for (const v of grid.get(key(gx + dx, gy + dy)) ?? []) {
              if (group[v] === g) continue;
              const x = (lng(u) - lng(v)) * kmPerLng[u];
              const y = (lat(u) - lat(v)) * KM_PER_DEG;
              const km = Math.sqrt(x * x + y * y);
              const candidate: [number, number, number] = [km, Math.min(u, v), Math.max(u, v)];
              const current = best.get(g);
              if (!current || compareEdge(candidate, current) < 0) best.set(g, candidate);
              if (!found || km < found[1]) found = [v, km];
            }
          }
        }
      }
    }
    const ordered = [...best.values()].sort(compareEdge);
    let joined = false;
    for (const [, u, v] of ordered) {
      const a = find(label[u]);
      const b = find(label[v]);
      if (a === b) continue;
      parent[Math.max(a, b)] = Math.min(a, b);
      edges.push([u, v]);
      joined = true;
    }
    if (!joined) break;
  }
  return edges;
}

function compareEdge(a: [number, number, number], b: [number, number, number]) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
