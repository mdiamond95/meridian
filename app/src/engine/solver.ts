import type { SplitMethod } from '../schema/regionPack';
import { DEG, detCos, detExp } from './detmath';
import { centreKm, type MeshArrays, type ScopeGraph } from './graph';
import { mulberry32, type Prng } from './prng';

/**
 * The splitter engine (vision §3, plan Phase 3).
 *
 * Cost, lower is better, each term normalised so the weights are comparable:
 *   balance      Σ_k ((L_k − T) / T)² / N, L_k the region's load in the balance column, T = total / N
 *   compactness  cut edges / all edges (sea crossings excluded: a strait is not boundary)
 *   lens         within-region sum of squares of the standardised lens columns / total sum of squares
 *   snap         − cut edges lying on a snap layer / all snap edges (a bonus)
 *   contiguity   (soft only) extra pieces Σ_k (pieces_k − 1) / N
 *   limits       people outside [min, max] population per region / total population
 *   pins         keep-together cells not with their group's first cell / pinned cells, plus
 *                keep-apart pairs sharing a region / pairs
 *
 * Initialisers give a first split; refine() anneals over boundary cells. Contiguity is `hard`
 * (a move that would split a region is refused), `soft` (allowed, at a cost) or `off`.
 *
 * Determinism: every random draw is from mulberry32(seed); cells are visited in local order, which
 * is mesh order, which is H3 id order; ties break by index; annealing uses detExp. The one thing that
 * is not deterministic is `maxMs`, a safety cap on wall time: a run that hits it says so
 * (`stoppedBy: 'time'`) and is not reproducible.
 */

export type Contiguity = 'hard' | 'soft' | 'off';
export type BalanceColumn = 'cells' | 'area' | string;

export interface Weights {
  balance: number;
  compactness: number;
  lens: number;
  snap: number;
  contiguity: number;
  /** population limits penalty; 10 when limits are set and no weight is given */
  limits?: number;
  /** keep-together / keep-apart penalty; 10 when pins are set and no weight is given */
  pins?: number;
}

export interface Pins {
  /** each group's cells (mesh indices) should share one region */
  together: number[][];
  /** each group's cells (mesh indices) should all be in different regions */
  apart: number[][];
}

export interface Params {
  n: number;
  method: SplitMethod;
  /** random: Voronoi from random seeds, or random hierarchical cuts */
  random?: 'voronoi' | 'cuts';
  /** seeded: capital cells (mesh indices); without them, n seeds are drawn weighted by balance load */
  capitals?: number[];
  /** seeded: capitals as [lng, lat], each resolved to the nearest scope cell (used when `capitals` is empty) */
  capitalPoints?: [number, number][];
  /** population per region, as a penalty (the balance column is separate) */
  populationLimits?: { min?: number; max?: number };
  pins?: Pins;
  /** attrs column, or 'cells' / 'area'; null = no balance term */
  balance: BalanceColumn | null;
  /** attrs column → weight */
  lens: Record<string, number>;
  weights: Weights;
  contiguity: Contiguity;
  /** annealing moves; 0 = initialiser only */
  iterations: number;
  /** stop after this many moves without a new best cost */
  plateau: number;
  /** wall-time cap in ms (not deterministic; see above) */
  maxMs: number;
}

export const DEFAULT_WEIGHTS: Weights = { balance: 1, compactness: 0.2, lens: 0, snap: 0, contiguity: 1 };

export function defaultParams(n: number, method: SplitMethod): Params {
  const refines = method === 'lens' || method === 'balanced' || method === 'seeded';
  return {
    n,
    method,
    balance: 'population',
    lens: {},
    weights: { ...DEFAULT_WEIGHTS },
    contiguity: 'hard',
    iterations: refines ? 200_000 : 0,
    plateau: 50_000,
    maxMs: 30_000,
  };
}

export type Columns = Record<string, Float32Array | Int32Array>;

export interface SolveInput {
  mesh: MeshArrays;
  graph: ScopeGraph;
  columns: Columns;
  params: Params;
  seed: number;
  /** template: region id per mesh cell (-1 outside) */
  template?: Int32Array;
  /** 1 per graph edge (aligned with graph.targets) that lies on a snap layer */
  snapEdges?: Uint8Array;
}

export interface CostBreakdown {
  total: number;
  balance: number;
  compactness: number;
  lens: number;
  snap: number;
  contiguity: number;
  limits: number;
  pins: number;
}

export interface ConstraintReport {
  /** people above max plus people below min, summed over regions */
  populationOutsideLimits: number;
  /** keep-together cells not in their group's region */
  togetherViolations: number;
  /** keep-apart pairs sharing a region */
  apartViolations: number;
}

export interface RegionStats {
  id: number;
  cells: number;
  population: number;
  areaKm2: number;
  gdp: number | null;
  /** lens column → population-weighted mean (cell mean without population) */
  lensMeans: Record<string, number>;
  /** lens column → population-weighted variance */
  lensVariances: Record<string, number>;
  /** Polsby–Popper, 4πA/P², hex edges (coast included, sea crossings not) */
  compactness: number;
  /** connected pieces, counting sea crossings as connections */
  pieces: number;
}

export type StopReason = 'iterations' | 'plateau' | 'time' | 'cancelled' | 'none';

export interface SolveResult {
  /** region id per mesh cell, -1 outside the scope */
  assignment: Int32Array;
  regions: RegionStats[];
  cost: CostBreakdown;
  constraints: ConstraintReport;
  iterations: number;
  stoppedBy: StopReason;
}

export interface Progress {
  iteration: number;
  iterations: number;
  cost: number;
  best: number;
}

// --- helpers ----------------------------------------------------------------------------------

/** Binary min-heap of (k1, k2, cell), compared in that order. */
class Heap {
  private k1: number[] = [];
  private k2: number[] = [];
  private cell: number[] = [];

  get size() {
    return this.cell.length;
  }

  private less(i: number, j: number) {
    return (
      this.k1[i] < this.k1[j] ||
      (this.k1[i] === this.k1[j] &&
        (this.k2[i] < this.k2[j] || (this.k2[i] === this.k2[j] && this.cell[i] < this.cell[j])))
    );
  }

  private swap(i: number, j: number) {
    [this.k1[i], this.k1[j]] = [this.k1[j], this.k1[i]];
    [this.k2[i], this.k2[j]] = [this.k2[j], this.k2[i]];
    [this.cell[i], this.cell[j]] = [this.cell[j], this.cell[i]];
  }

  push(k1: number, k2: number, cell: number) {
    this.k1.push(k1);
    this.k2.push(k2);
    this.cell.push(cell);
    let i = this.cell.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  peek(): [number, number, number] {
    return [this.k1[0], this.k2[0], this.cell[0]];
  }

  pop(): [number, number, number] {
    const top = this.peek();
    const last = this.cell.length - 1;
    this.swap(0, last);
    this.k1.pop();
    this.k2.pop();
    this.cell.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.cell.length && this.less(l, m)) m = l;
      if (r < this.cell.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/** Everything precomputed once per solve. */
interface Context {
  graph: ScopeGraph;
  mesh: MeshArrays;
  size: number;
  /** balance load per local cell */
  load: Float64Array;
  /** standardised, weight-scaled lens values, lensCount per cell */
  lens: Float64Array;
  lensCount: number;
  lensNames: string[];
  /** km per graph edge */
  edgeKm: Float64Array;
  snap: Uint8Array | null;
  /** planar coordinates (km) per local cell, for geometric axes */
  xy: Float64Array;
  /** population per local cell (0 without a population column) */
  population: Float64Array;
  limits: { min: number; max: number } | null;
  /** pin groups in local indices (cells outside the scope dropped; groups under 2 cells dropped) */
  together: number[][];
  apart: number[][];
  /** local cell → indices into together / apart */
  pinned: Map<number, { together: number[]; apart: number[] }>;
}

function buildContext(input: SolveInput): Context {
  const { graph, mesh, columns, params } = input;
  const size = graph.size;
  const load = new Float64Array(size);
  for (let u = 0; u < size; u++) {
    const m = graph.cells[u];
    if (params.balance === null || params.balance === 'cells') load[u] = 1;
    else if (params.balance === 'area') load[u] = mesh.areas[m];
    else {
      const column = columns[params.balance];
      if (!column) throw new Error(`balance column ${params.balance} is not loaded`);
      load[u] = column[m];
    }
  }

  const lensNames = Object.keys(params.lens)
    .filter((name) => params.lens[name] > 0)
    .sort();
  const lensCount = lensNames.length;
  const lens = new Float64Array(size * lensCount);
  lensNames.forEach((name, c) => {
    const column = columns[name];
    if (!column) throw new Error(`lens column ${name} is not loaded`);
    let sum = 0;
    let sumsq = 0;
    for (let u = 0; u < size; u++) {
      const x = column[graph.cells[u]];
      sum += x;
      sumsq += x * x;
    }
    const mean = sum / size;
    const variance = sumsq / size - mean * mean;
    const scale = variance > 0 ? Math.sqrt(params.lens[name] / variance) : 0;
    for (let u = 0; u < size; u++) lens[u * lensCount + c] = (column[graph.cells[u]] - mean) * scale;
  });

  const edgeKm = new Float64Array(graph.targets.length);
  const xy = new Float64Array(2 * size);
  let lat0 = 0;
  for (let u = 0; u < size; u++) lat0 += mesh.centroids[2 * graph.cells[u] + 1] / size;
  for (let u = 0; u < size; u++) {
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
      edgeKm[e] = centreKm(mesh.centroids, graph.cells[u], graph.cells[graph.targets[e]]);
    }
    const m = graph.cells[u];
    xy[2 * u] = mesh.centroids[2 * m] * 111.195;
    xy[2 * u + 1] = mesh.centroids[2 * m + 1] * 111.195;
  }
  // Longitude to km at the scope's mean latitude, so geometric axes are not stretched.
  const kx = cosDeg(lat0);
  for (let u = 0; u < size; u++) xy[2 * u] *= kx;

  const population = new Float64Array(size);
  const popColumn = columns.population;
  if (popColumn) for (let u = 0; u < size; u++) population[u] = popColumn[graph.cells[u]];
  const limitSpec = params.populationLimits;
  const limits =
    limitSpec && (limitSpec.min !== undefined || limitSpec.max !== undefined)
      ? { min: limitSpec.min ?? 0, max: limitSpec.max ?? Infinity }
      : null;
  const toLocal = (group: number[]) => [...new Set(group.map((m) => graph.local[m]).filter((u) => u >= 0))];
  const together = (params.pins?.together ?? []).map(toLocal).filter((g) => g.length > 1);
  const apart = (params.pins?.apart ?? []).map(toLocal).filter((g) => g.length > 1);
  const pinned = new Map<number, { together: number[]; apart: number[] }>();
  const entry = (u: number) => {
    let e = pinned.get(u);
    if (!e) pinned.set(u, (e = { together: [], apart: [] }));
    return e;
  };
  together.forEach((g, i) => g.forEach((u) => entry(u).together.push(i)));
  apart.forEach((g, i) => g.forEach((u) => entry(u).apart.push(i)));

  return {
    graph,
    mesh,
    size,
    load,
    lens,
    lensCount,
    lensNames,
    edgeKm,
    snap: input.snapEdges ?? null,
    xy,
    population,
    limits,
    together,
    apart,
    pinned,
  };
}

function cosDeg(deg: number) {
  return detCos(deg * DEG);
}

// --- growth -----------------------------------------------------------------------------------

type Priority = (
  region: number,
  from: number,
  to: number,
  fromKey2: number,
  edge: number,
) => [number, number];

/**
 * Grow regions from seeds over the graph, inside `within` (cells where within[u] === withinId).
 * balanced: the lightest region with a frontier takes its best frontier cell next; otherwise the
 * globally best frontier cell goes first (a Voronoi diagram in the priority's metric).
 * Cells no seed can reach join a neighbouring region afterwards.
 */
function grow(
  ctx: Context,
  seeds: number[],
  regionIds: number[],
  assignment: Int32Array,
  within: Int32Array | null,
  withinId: number,
  priority: Priority,
  shares: number[] | null,
) {
  const { graph } = ctx;
  const inside = (u: number) => within === null || within[u] === withinId;
  const heaps = seeds.map(() => new Heap());
  const loads = seeds.map(() => 0);
  const claimed = new Uint8Array(ctx.size);
  seeds.forEach((seed, r) => heaps[r].push(0, 0, seed));

  for (;;) {
    let r = -1;
    for (let k = 0; k < seeds.length; k++) {
      // Drop frontier cells another region already took.
      while (heaps[k].size && claimed[heaps[k].peek()[2]]) heaps[k].pop();
      if (!heaps[k].size) continue;
      if (r < 0) r = k;
      else if (shares ? loads[k] / shares[k] < loads[r] / shares[r] : compareTop(heaps[k], heaps[r]) < 0)
        r = k;
    }
    if (r < 0) break;
    const [, key2, u] = heaps[r].pop();
    claimed[u] = 1;
    assignment[u] = regionIds[r];
    loads[r] += ctx.load[u];
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
      const v = graph.targets[e];
      if (claimed[v] || !inside(v)) continue;
      const [k1, k2] = priority(r, u, v, key2, e);
      heaps[r].push(k1, k2, v);
    }
  }

  // Unreached cells (a disconnected piece of a region under soft or off contiguity).
  let pending = true;
  while (pending) {
    pending = false;
    for (let u = 0; u < ctx.size; u++) {
      if (!inside(u) || claimed[u]) continue;
      for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
        const v = graph.targets[e];
        if (claimed[v] && inside(v)) {
          assignment[u] = assignment[v];
          claimed[u] = 1;
          pending = true;
          break;
        }
      }
    }
  }
  for (let u = 0; u < ctx.size; u++) if (inside(u) && !claimed[u]) assignment[u] = regionIds[0];
}

function compareTop(a: Heap, b: Heap) {
  const [a1, a2, a3] = a.peek();
  const [b1, b2, b3] = b.peek();
  return a1 - b1 || a2 - b2 || a3 - b3;
}

const byDistance: (ctx: Context) => Priority = (ctx) => (_r, _from, _to, fromKey2, edge) => {
  const d = fromKey2 + ctx.edgeKm[edge];
  return [d, d];
};

// --- initialisers -----------------------------------------------------------------------------

/** Seeds weighted by balance load, without repeats (Efraimidis–Spirakis would need logs; this is
 * inverse-CDF sampling on the remaining load, which only needs + and ×). */
function weightedSeeds(ctx: Context, k: number, rng: Prng): number[] {
  const weights = Float64Array.from(ctx.load, (w) => Math.max(w, 0));
  let total = weights.reduce((a, b) => a + b, 0);
  const seeds: number[] = [];
  while (seeds.length < k) {
    if (total <= 0) {
      const u = rng.int(ctx.size);
      if (!seeds.includes(u)) seeds.push(u);
      continue;
    }
    let target = rng.next() * total;
    let chosen = ctx.size - 1;
    for (let u = 0; u < ctx.size; u++) {
      target -= weights[u];
      if (target < 0 && weights[u] > 0) {
        chosen = u;
        break;
      }
    }
    if (seeds.includes(chosen)) {
      total -= weights[chosen];
      weights[chosen] = 0;
      continue;
    }
    seeds.push(chosen);
    total -= weights[chosen];
    weights[chosen] = 0;
  }
  return seeds;
}

function uniformSeeds(ctx: Context, k: number, rng: Prng): number[] {
  const seeds: number[] = [];
  while (seeds.length < k) {
    const u = rng.int(ctx.size);
    if (!seeds.includes(u)) seeds.push(u);
  }
  return seeds;
}

function initSeeded(ctx: Context, seeds: number[], balanced: boolean): Int32Array {
  const assignment = new Int32Array(ctx.size).fill(-1);
  const ids = seeds.map((_, i) => i);
  grow(ctx, seeds, ids, assignment, null, 0, byDistance(ctx), balanced ? seeds.map(() => 1) : null);
  return assignment;
}

/** Projection of each cell of a region onto an axis: `axis` in km coordinates, or the first
 * principal component of the lens values ('lens') or of the cell centres ('geometry'). */
type Axis = [number, number] | 'lens' | 'geometry';

function projection(ctx: Context, members: number[], axis: Axis): Float64Array {
  const out = new Float64Array(members.length);
  if (Array.isArray(axis)) {
    members.forEach((u, i) => (out[i] = ctx.xy[2 * u] * axis[0] + ctx.xy[2 * u + 1] * axis[1]));
    return out;
  }
  const useLens = axis === 'lens' && ctx.lensCount > 0;
  const dims = useLens ? ctx.lensCount : 2;
  const value = (u: number, c: number) => (useLens ? ctx.lens[u * ctx.lensCount + c] : ctx.xy[2 * u + c]);
  const mean = new Float64Array(dims);
  for (const u of members) for (let c = 0; c < dims; c++) mean[c] += value(u, c) / members.length;
  // Power iteration on the covariance, from a fixed start; 40 rounds is plenty for a split.
  let vec = new Float64Array(dims).fill(1);
  for (let round = 0; round < 40; round++) {
    const next = new Float64Array(dims);
    for (const u of members) {
      let dot = 0;
      for (let c = 0; c < dims; c++) dot += (value(u, c) - mean[c]) * vec[c];
      for (let c = 0; c < dims; c++) next[c] += (value(u, c) - mean[c]) * dot;
    }
    let norm = 0;
    for (let c = 0; c < dims; c++) norm += next[c] * next[c];
    norm = Math.sqrt(norm);
    if (norm === 0) break;
    for (let c = 0; c < dims; c++) next[c] /= norm;
    vec = next;
  }
  members.forEach((u, i) => {
    let dot = 0;
    for (let c = 0; c < dims; c++) dot += (value(u, c) - mean[c]) * vec[c];
    out[i] = dot;
  });
  return out;
}

/** Split region `id` in two along a projection: seeds at its two ends, each side growing towards
 * the cells nearest its own end, the side furthest below its share of the load growing next. The new
 * part is region `newId`. */
function splitRegion(
  ctx: Context,
  assignment: Int32Array,
  id: number,
  newId: number,
  axis: Axis,
  shares: [number, number] = [0.5, 0.5],
) {
  const members: number[] = [];
  for (let u = 0; u < ctx.size; u++) if (assignment[u] === id) members.push(u);
  if (members.length < 2) return false;
  const proj = projection(ctx, members, axis);
  const projOf = new Map<number, number>();
  members.forEach((u, i) => projOf.set(u, proj[i]));
  let lo = 0;
  let hi = 0;
  for (let i = 1; i < members.length; i++) {
    if (proj[i] < proj[lo]) lo = i;
    if (proj[i] > proj[hi]) hi = i;
  }
  if (lo === hi) hi = lo === 0 ? 1 : 0;
  const seedProj = [proj[lo], proj[hi]];
  const within = Int32Array.from(assignment);
  grow(
    ctx,
    [members[lo], members[hi]],
    [id, newId],
    assignment,
    within,
    id,
    (r, _from, to, fromKey2) => [Math.abs((projOf.get(to) ?? 0) - seedProj[r]), fromKey2 + 1],
    shares,
  );
  return true;
}

/** Lens bisection (vision §3.1): split the most heterogeneous region on the lens into equal halves
 * along its lens axis, until there are n. N and N+1 nest. Without a lens, the heaviest region is
 * split along its geometric axis. */
function initLens(ctx: Context, n: number): Int32Array {
  const assignment = new Int32Array(ctx.size);
  const L = ctx.lensCount;
  for (let count = 1; count < n; count++) {
    const score = new Float64Array(count);
    if (L) {
      const sums = new Float64Array(count * L);
      const sq = new Float64Array(count);
      const cnt = new Float64Array(count);
      for (let u = 0; u < ctx.size; u++) {
        const r = assignment[u];
        cnt[r]++;
        for (let c = 0; c < L; c++) {
          const x = ctx.lens[u * L + c];
          sums[r * L + c] += x;
          sq[r] += x * x;
        }
      }
      for (let r = 0; r < count; r++) {
        score[r] = sq[r];
        for (let c = 0; c < L; c++) score[r] -= (sums[r * L + c] * sums[r * L + c]) / cnt[r];
      }
    } else {
      for (let u = 0; u < ctx.size; u++) score[assignment[u]] += ctx.load[u];
    }
    let target = 0;
    for (let r = 1; r < count; r++) if (score[r] > score[target]) target = r;
    if (!splitRegion(ctx, assignment, target, count, L ? 'lens' : 'geometry')) break;
  }
  return assignment;
}

/** Quota bisection: a region that must become q regions splits into ⌊q/2⌋ and ⌈q/2⌉, with its load
 * shared in that ratio, along its geometric axis or a random one. Largest quota first, ties by id. */
function initQuota(ctx: Context, n: number, rng: Prng | null): Int32Array {
  const assignment = new Int32Array(ctx.size);
  const quota = [n];
  for (;;) {
    let target = -1;
    for (let r = 0; r < quota.length; r++)
      if (quota[r] > 1 && (target < 0 || quota[r] > quota[target])) target = r;
    if (target < 0) break;
    const q = quota[target];
    const left = Math.floor(q / 2);
    let axis: Axis = 'geometry';
    if (rng) {
      // A random direction from two uniforms; only + × ÷ and sqrt, so every engine agrees.
      const x = rng.next() - 0.5;
      const y = rng.next() - 0.5;
      const norm = Math.sqrt(x * x + y * y) || 1;
      axis = [x / norm, y / norm];
    }
    const newId = quota.length;
    if (!splitRegion(ctx, assignment, target, newId, axis, [left / q, (q - left) / q])) {
      quota[target] = 1;
      continue;
    }
    quota[target] = left;
    quota.push(q - left);
  }
  return assignment;
}

function initTemplate(ctx: Context, template: Int32Array): Int32Array {
  const assignment = new Int32Array(ctx.size);
  for (let u = 0; u < ctx.size; u++) assignment[u] = Math.max(0, template[ctx.graph.cells[u]]);
  return assignment;
}

/** The scope cell nearest each point (planar km at the point's latitude; ties by index), without repeats. */
function nearestLocalCells(ctx: Context, points: [number, number][]): number[] {
  const out: number[] = [];
  for (const [lng, lat] of points) {
    const kx = cosDeg(lat);
    let best = -1;
    let bestKm = Infinity;
    for (let u = 0; u < ctx.size; u++) {
      if (out.includes(u)) continue;
      const m = ctx.graph.cells[u];
      const dx = (ctx.mesh.centroids[2 * m] - lng) * kx;
      const dy = ctx.mesh.centroids[2 * m + 1] - lat;
      const km = dx * dx + dy * dy;
      if (km < bestKm) {
        bestKm = km;
        best = u;
      }
    }
    if (best >= 0) out.push(best);
  }
  return out;
}

export function initialise(ctx: Context, input: SolveInput, rng: Prng): Int32Array {
  const { params } = input;
  const n = Math.min(params.n, ctx.size);
  switch (params.method) {
    case 'lens':
      return initLens(ctx, n);
    case 'balanced':
      return initQuota(ctx, n, null);
    case 'seeded': {
      let capitals = (params.capitals ?? []).map((m) => ctx.graph.local[m]).filter((u) => u >= 0);
      if (!capitals.length && params.capitalPoints?.length)
        capitals = nearestLocalCells(ctx, params.capitalPoints);
      const seeds = capitals.length ? capitals.slice(0, n) : weightedSeeds(ctx, n, rng);
      // Without a balance column, growth is by distance alone: the land nearest each capital.
      return initSeeded(ctx, seeds, params.balance !== null);
    }
    case 'random':
      return params.random === 'cuts'
        ? initQuota(ctx, n, rng)
        : initSeeded(ctx, uniformSeeds(ctx, n, rng), false);
    case 'template':
      if (!input.template) throw new Error('template method needs a template assignment');
      return initTemplate(ctx, input.template);
  }
}

// --- state and cost ---------------------------------------------------------------------------

class State {
  readonly k: number;
  readonly assignment: Int32Array;
  readonly count: Float64Array;
  readonly load: Float64Array;
  readonly lensSum: Float64Array;
  readonly lensSq: Float64Array;
  readonly regionPopulation: Float64Array;
  readonly totalPopulation: number;
  readonly pinnedCells: number;
  readonly apartPairs: number;
  readonly pieces: Int32Array;
  readonly target: number;
  readonly sst: number;
  cut = 0;
  cutSnap = 0;
  readonly edges: number;
  readonly snapEdges: number;
  private readonly boundary: number[] = [];
  private readonly position: Int32Array;
  private readonly mark: Int32Array;
  private readonly owner: Int32Array;
  private stamp = 0;

  constructor(
    readonly ctx: Context,
    assignment: Int32Array,
    readonly weights: Weights,
    readonly contiguity: Contiguity,
  ) {
    const { graph, size, lensCount } = ctx;
    this.assignment = assignment;
    this.k = Math.max(...assignment) + 1;
    this.count = new Float64Array(this.k);
    this.load = new Float64Array(this.k);
    this.lensSum = new Float64Array(this.k * lensCount);
    this.lensSq = new Float64Array(this.k);
    this.regionPopulation = new Float64Array(this.k);
    let totalPopulation = 0;
    let totalLoad = 0;
    const sum = new Float64Array(lensCount);
    let sq = 0;
    for (let u = 0; u < size; u++) {
      const r = assignment[u];
      this.count[r]++;
      this.load[r] += ctx.load[u];
      totalLoad += ctx.load[u];
      this.regionPopulation[r] += ctx.population[u];
      totalPopulation += ctx.population[u];
      for (let c = 0; c < lensCount; c++) {
        const x = ctx.lens[u * lensCount + c];
        this.lensSum[r * lensCount + c] += x;
        this.lensSq[r] += x * x;
        sum[c] += x;
        sq += x * x;
      }
    }
    for (let c = 0; c < lensCount; c++) sq -= (sum[c] * sum[c]) / size;
    this.sst = sq;
    this.target = totalLoad / this.k;
    this.totalPopulation = totalPopulation;
    this.pinnedCells = ctx.together.reduce((n, g) => n + g.length, 0);
    this.apartPairs = ctx.apart.reduce((n, g) => n + (g.length * (g.length - 1)) / 2, 0);

    let edges = 0;
    let snapEdges = 0;
    for (let u = 0; u < size; u++) {
      for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
        const v = graph.targets[e];
        if (v < u || graph.crossing[e]) continue;
        edges++;
        const onSnap = ctx.snap?.[e] ? 1 : 0;
        snapEdges += onSnap;
        if (assignment[u] !== assignment[v]) {
          this.cut++;
          this.cutSnap += onSnap;
        }
      }
    }
    this.edges = Math.max(edges, 1);
    this.snapEdges = Math.max(snapEdges, 1);

    this.position = new Int32Array(size).fill(-1);
    this.mark = new Int32Array(size);
    this.owner = new Int32Array(size);
    for (let u = 0; u < size; u++) this.updateBoundary(u);
    this.pieces = new Int32Array(this.k);
    for (let r = 0; r < this.k; r++) this.pieces[r] = this.countPieces(r);
  }

  get boundaryCells() {
    return this.boundary;
  }

  isBoundary(u: number) {
    const { graph } = this.ctx;
    const r = this.assignment[u];
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++)
      if (this.assignment[graph.targets[e]] !== r) return true;
    return false;
  }

  updateBoundary(u: number) {
    const on = this.isBoundary(u);
    const at = this.position[u];
    if (on && at < 0) {
      this.position[u] = this.boundary.length;
      this.boundary.push(u);
    } else if (!on && at >= 0) {
      const last = this.boundary.pop() as number; // u is in it, so it is not empty
      if (last !== u) {
        this.boundary[at] = last;
        this.position[last] = at;
      }
      this.position[u] = -1;
    }
  }

  countPieces(r: number): number {
    const { graph, size } = this.ctx;
    this.stamp++;
    let pieces = 0;
    for (let s = 0; s < size; s++) {
      if (this.assignment[s] !== r || this.mark[s] === this.stamp) continue;
      pieces++;
      this.mark[s] = this.stamp;
      const stack = [s];
      while (stack.length) {
        const u = stack.pop() as number; // the loop checks length
        for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
          const v = graph.targets[e];
          if (this.assignment[v] === r && this.mark[v] !== this.stamp) {
            this.mark[v] = this.stamp;
            stack.push(v);
          }
        }
      }
    }
    return pieces;
  }

  terms(): CostBreakdown {
    const { k, target } = this;
    let balance = 0;
    if (target > 0) {
      for (let r = 0; r < k; r++) {
        const dev = (this.load[r] - target) / target;
        balance += dev * dev;
      }
    }
    balance /= k;
    let within = 0;
    const L = this.ctx.lensCount;
    for (let r = 0; r < k; r++) {
      if (!this.count[r]) continue;
      let s = this.lensSq[r];
      for (let c = 0; c < L; c++) s -= (this.lensSum[r * L + c] * this.lensSum[r * L + c]) / this.count[r];
      within += s;
    }
    const lens = this.sst > 0 ? within / this.sst : 0;
    const compactness = this.cut / this.edges;
    const snap = this.ctx.snap ? -this.cutSnap / this.snapEdges : 0;
    let extra = 0;
    for (let r = 0; r < k; r++) extra += Math.max(0, this.pieces[r] - 1);
    const contiguity = this.contiguity === 'soft' ? extra / k : 0;
    const report = this.constraintReport();
    const limits =
      this.ctx.limits && this.totalPopulation > 0 ? report.populationOutsideLimits / this.totalPopulation : 0;
    const pins =
      (this.pinnedCells ? report.togetherViolations / this.pinnedCells : 0) +
      (this.apartPairs ? report.apartViolations / this.apartPairs : 0);
    const w = this.weights;
    const total =
      w.balance * balance +
      w.compactness * compactness +
      w.lens * lens +
      w.snap * snap +
      w.contiguity * contiguity +
      (w.limits ?? 10) * limits +
      (w.pins ?? 10) * pins;
    return { total, balance, compactness, lens, snap, contiguity, limits, pins };
  }

  outside(population: number): number {
    const limits = this.ctx.limits;
    if (!limits) return 0;
    return Math.max(0, population - limits.max) + Math.max(0, limits.min - population);
  }

  /** Keep-together violations of a group, with cell `u` counted in region `r`. */
  togetherViolations(group: number[], u = -1, r = -1): number {
    const regionOf = (c: number) => (c === u ? r : this.assignment[c]);
    const anchor = regionOf(group[0]);
    let n = 0;
    for (let i = 1; i < group.length; i++) if (regionOf(group[i]) !== anchor) n++;
    return n;
  }

  /** Keep-apart pairs of a group sharing a region, with cell `u` counted in region `r`. */
  apartViolations(group: number[], u = -1, r = -1): number {
    const regionOf = (c: number) => (c === u ? r : this.assignment[c]);
    let n = 0;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) if (regionOf(group[i]) === regionOf(group[j])) n++;
    }
    return n;
  }

  constraintReport(): ConstraintReport {
    let populationOutsideLimits = 0;
    for (let r = 0; r < this.k; r++) populationOutsideLimits += this.outside(this.regionPopulation[r]);
    let togetherViolations = 0;
    for (const g of this.ctx.together) togetherViolations += this.togetherViolations(g);
    let apartViolations = 0;
    for (const g of this.ctx.apart) apartViolations += this.apartViolations(g);
    return { populationOutsideLimits, togetherViolations, apartViolations };
  }

  /**
   * How many separate pieces `u`'s neighbours in region r fall into with u left out: as u leaves r,
   * its piece splits into that many; as u joins r, that many pieces merge.
   *
   * Neighbours adjacent to one another are one group without any search. Otherwise one breadth-first
   * front starts from each group and the fronts advance a cell at a time in turn; fronts that meet
   * merge. The search ends when one group is left, or (with `stopAtSplit`) as soon as a front runs
   * out while others remain, which proves a split. Either way it costs about twice the smaller side,
   * not the whole region.
   */
  neighbourGroups(u: number, r: number, stopAtSplit = false): number {
    const { graph } = this.ctx;
    const nbrs: number[] = [];
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
      const v = graph.targets[e];
      if (this.assignment[v] === r && v !== u) nbrs.push(v);
    }
    if (nbrs.length <= 1) return nbrs.length;

    // Local groups: neighbours joined through one another.
    const parent = nbrs.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    for (let i = 0; i < nbrs.length; i++) {
      for (let j = i + 1; j < nbrs.length; j++) {
        if (this.adjacent(nbrs[i], nbrs[j])) parent[Math.max(find(i), find(j))] = Math.min(find(i), find(j));
      }
    }
    const roots = new Map<number, number>();
    nbrs.forEach((_, i) => {
      const root = find(i);
      if (!roots.has(root)) roots.set(root, roots.size);
    });
    let groups = roots.size;
    if (groups === 1) return 1;

    // Interleaved fronts, one per local group.
    const G = groups;
    const front = Array.from({ length: G }, () => [] as number[]);
    const head = new Array<number>(G).fill(0);
    const owner = new Array<number>(G).fill(0).map((_, g) => g);
    const findOwner = (g: number): number => {
      while (owner[g] !== g) g = owner[g] = owner[owner[g]];
      return g;
    };
    this.stamp++;
    const stamp = this.stamp;
    this.mark[u] = stamp;
    this.owner[u] = -1;
    nbrs.forEach((v, i) => {
      const g = roots.get(find(i)) ?? 0;
      this.mark[v] = stamp;
      this.owner[v] = g;
      front[g].push(v);
    });
    const live = (root: number) => {
      for (let g = 0; g < G; g++) if (findOwner(g) === root && head[g] < front[g].length) return true;
      return false;
    };
    for (;;) {
      let advanced = false;
      for (let g = 0; g < G && groups > 1; g++) {
        if (head[g] >= front[g].length) continue;
        advanced = true;
        const a = front[g][head[g]++];
        for (let e = graph.offsets[a]; e < graph.offsets[a + 1]; e++) {
          const b = graph.targets[e];
          if (this.assignment[b] !== r) continue;
          if (this.mark[b] !== stamp) {
            this.mark[b] = stamp;
            this.owner[b] = g;
            front[g].push(b);
          } else if (this.owner[b] >= 0) {
            const x = findOwner(this.owner[b]);
            const y = findOwner(g);
            if (x !== y) {
              owner[Math.max(x, y)] = Math.min(x, y);
              groups--;
            }
          }
        }
        if (stopAtSplit && head[g] >= front[g].length && !live(findOwner(g))) return 2;
      }
      if (groups === 1 || !advanced) return groups;
    }
  }

  private adjacent(a: number, b: number) {
    const { graph } = this.ctx;
    for (let e = graph.offsets[a]; e < graph.offsets[a + 1]; e++) if (graph.targets[e] === b) return true;
    return false;
  }

  /** Cost change of moving u to region b, or null if the move is not allowed. */
  delta(u: number, b: number): { delta: number; piecesA: number; piecesB: number } | null {
    const { ctx, weights, k, target } = this;
    const a = this.assignment[u];
    if (a === b || this.count[a] <= 1) return null;

    let piecesA = 0;
    let piecesB = 0;
    if (this.contiguity !== 'off') {
      const groupsA = this.neighbourGroups(u, a, this.contiguity === 'hard');
      // Leaving a: its piece splits into as many pieces as u's neighbours fall into (0 → u was a piece).
      piecesA = groupsA === 0 ? -1 : groupsA - 1;
      if (this.contiguity === 'hard' && piecesA > 0) return null;
      if (this.contiguity === 'soft') {
        const groupsB = this.neighbourGroups(u, b);
        piecesB = groupsB === 0 ? 1 : 1 - groupsB;
      }
    }

    let d = 0;
    if (weights.balance && target > 0) {
      const w = ctx.load[u];
      const la = this.load[a];
      const lb = this.load[b];
      const sq = (x: number) => x * x; // not **, which engines may approximate
      d +=
        (weights.balance * (sq(la - w - target) - sq(la - target) + sq(lb + w - target) - sq(lb - target))) /
        (target * target * k);
    }
    if (weights.lens && ctx.lensCount && this.sst > 0) {
      const L = ctx.lensCount;
      let before = 0;
      let after = 0;
      for (let c = 0; c < L; c++) {
        const x = ctx.lens[u * L + c];
        const sa = this.lensSum[a * L + c];
        const sb = this.lensSum[b * L + c];
        before += (sa * sa) / this.count[a] + (sb * sb) / this.count[b];
        after += ((sa - x) * (sa - x)) / (this.count[a] - 1) + ((sb + x) * (sb + x)) / (this.count[b] + 1);
      }
      // within = Σ_r (sq_r − Σ_c sum_rc² / count_r). u's x² leaves a and enters b, so the sq terms
      // cancel and only the sum²/count terms change.
      d += (weights.lens * (before - after)) / this.sst;
    }
    if (weights.compactness || weights.snap) {
      const { graph } = ctx;
      let inA = 0;
      let inB = 0;
      let snapA = 0;
      let snapB = 0;
      for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
        if (graph.crossing[e]) continue;
        const r = this.assignment[graph.targets[e]];
        const onSnap = ctx.snap?.[e] ? 1 : 0;
        if (r === a) {
          inA++;
          snapA += onSnap;
        } else if (r === b) {
          inB++;
          snapB += onSnap;
        }
      }
      d += (weights.compactness * (inA - inB)) / this.edges;
      if (ctx.snap) d -= (weights.snap * (snapA - snapB)) / this.snapEdges;
    }
    if (ctx.limits && this.totalPopulation > 0) {
      const p = ctx.population[u];
      const pa = this.regionPopulation[a];
      const pb = this.regionPopulation[b];
      const change = this.outside(pa - p) + this.outside(pb + p) - this.outside(pa) - this.outside(pb);
      d += ((weights.limits ?? 10) * change) / this.totalPopulation;
    }
    const pins = ctx.pinned.get(u);
    if (pins) {
      let change = 0;
      if (this.pinnedCells) {
        let t = 0;
        for (const i of pins.together) {
          const g = ctx.together[i];
          t += this.togetherViolations(g, u, b) - this.togetherViolations(g);
        }
        change += t / this.pinnedCells;
      }
      if (this.apartPairs) {
        let t = 0;
        for (const i of pins.apart) {
          const g = ctx.apart[i];
          t += this.apartViolations(g, u, b) - this.apartViolations(g);
        }
        change += t / this.apartPairs;
      }
      d += (weights.pins ?? 10) * change;
    }
    if (this.contiguity === 'soft') {
      const extraBefore = Math.max(0, this.pieces[a] - 1) + Math.max(0, this.pieces[b] - 1);
      const extraAfter =
        Math.max(0, this.pieces[a] + piecesA - 1) + Math.max(0, this.pieces[b] + piecesB - 1);
      d += (weights.contiguity * (extraAfter - extraBefore)) / k;
    }
    return { delta: d, piecesA, piecesB };
  }

  apply(u: number, b: number, piecesA: number, piecesB: number) {
    const { ctx } = this;
    const { graph, lensCount: L } = ctx;
    const a = this.assignment[u];
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
      if (graph.crossing[e]) continue;
      const r = this.assignment[graph.targets[e]];
      const onSnap = ctx.snap?.[e] ? 1 : 0;
      if (r === a) {
        this.cut++;
        this.cutSnap += onSnap;
      } else if (r === b) {
        this.cut--;
        this.cutSnap -= onSnap;
      }
    }
    this.assignment[u] = b;
    this.count[a]--;
    this.count[b]++;
    this.load[a] -= ctx.load[u];
    this.load[b] += ctx.load[u];
    this.regionPopulation[a] -= ctx.population[u];
    this.regionPopulation[b] += ctx.population[u];
    for (let c = 0; c < L; c++) {
      const x = ctx.lens[u * L + c];
      this.lensSum[a * L + c] -= x;
      this.lensSum[b * L + c] += x;
      this.lensSq[a] -= x * x;
      this.lensSq[b] += x * x;
    }
    this.pieces[a] += piecesA;
    this.pieces[b] += piecesB;
    this.updateBoundary(u);
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) this.updateBoundary(graph.targets[e]);
  }
}

// --- refinement -------------------------------------------------------------------------------

const PROGRESS_EVERY = 5_000;
/**
 * Starting temperature as a fraction of the mean size of a sample of legal moves. Swept on Canada
 * by population (docs/decisions.md): 0.5 and 0.1 stay hot so long the run plateaus unbalanced
 * (N=20 max/min 2.7 and 2.3); 0.02 reaches 1.01 at N=10 and 1.04 at N=20 in 200k moves.
 */
const T0_SCALE = 0.02;

/**
 * Simulated annealing over boundary cells. A generator: it yields progress every few thousand moves
 * so a worker can post it and notice a cancel between chunks.
 */
function* refine(
  state: State,
  params: Params,
  rng: Prng,
  ran: { moves: number },
): Generator<Progress, StopReason, boolean | undefined> {
  if (params.iterations <= 0 || state.k < 2) return 'none';
  const graph = state.ctx.graph;
  const started = Date.now();

  // Starting temperature: T0_SCALE × the mean size of a sample of legal moves, so the schedule adapts
  // to the weights and the scope. Cooling is linear to a thousandth of it.

  let sample = 0;
  let seen = 0;
  for (let i = 0; i < 400 && state.boundaryCells.length; i++) {
    const move = proposal(state, graph, rng);
    if (!move) continue;
    const result = state.delta(move[0], move[1]);
    if (result) {
      sample += Math.abs(result.delta);
      seen++;
    }
  }
  const t0 = seen ? (sample / seen) * T0_SCALE : 1e-6;
  const t1 = t0 * 1e-3;

  let cost = state.terms().total;
  let best = cost;
  let lastBest = 0;
  for (let i = 0; i < params.iterations; i++) {
    ran.moves = i;
    if (i % PROGRESS_EVERY === 0 && i > 0) {
      const cancel = yield { iteration: i, iterations: params.iterations, cost, best };
      if (cancel) return 'cancelled';
      if (Date.now() - started > params.maxMs) return 'time';
      // Hot moves wander above the best on purpose; a plateau only means something once cool.
      if (2 * i > params.iterations && i - lastBest > params.plateau) return 'plateau';
    }
    const move = proposal(state, graph, rng);
    if (!move) continue;
    const result = state.delta(move[0], move[1]);
    const u01 = rng.next();
    if (!result) continue;
    const temperature = t0 + ((t1 - t0) * i) / params.iterations;
    if (result.delta <= 0 || u01 < detExp(-result.delta / temperature)) {
      state.apply(move[0], move[1], result.piecesA, result.piecesB);
      cost += result.delta;
      if (cost < best - 1e-12) {
        best = cost;
        lastBest = i;
      }
    }
  }
  ran.moves = params.iterations;
  return 'iterations';
}

/** A random boundary cell and a random neighbouring region to move it to. */
function proposal(state: State, graph: ScopeGraph, rng: Prng): [number, number] | null {
  const boundary = state.boundaryCells;
  if (!boundary.length) return null;
  const u = boundary[rng.int(boundary.length)];
  const own = state.assignment[u];
  const options: number[] = [];
  for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
    const r = state.assignment[graph.targets[e]];
    if (r !== own && !options.includes(r)) options.push(r);
  }
  if (!options.length) return null;
  return [u, options[rng.int(options.length)]];
}

// --- stats ------------------------------------------------------------------------------------

/**
 * Per-region stats for any mesh-indexed assignment over a scope graph: the solver's result, or an
 * assignment after manual painting. Regions are 0..k-1; pieces are counted here, over the graph.
 */
export function computeRegionStats(
  mesh: MeshArrays,
  graph: ScopeGraph,
  columns: Columns,
  lensNames: string[],
  assignment: Int32Array,
  k: number,
): RegionStats[] {
  const population = columns.population;
  const gdp = columns.gdp_estimate;
  const names = [...lensNames].sort();
  const regions: RegionStats[] = Array.from({ length: k }, (_, id) => ({
    id,
    cells: 0,
    population: 0,
    areaKm2: 0,
    gdp: gdp ? 0 : null,
    lensMeans: {},
    lensVariances: {},
    compactness: 0,
    pieces: 0,
  }));
  const weightSum = new Float64Array(k);
  const perimeter = new Float64Array(k);
  const lensSum = names.map(() => new Float64Array(k));
  const lensSq = names.map(() => new Float64Array(k));
  const regionOf = (u: number) => assignment[graph.cells[u]];
  for (let u = 0; u < graph.size; u++) {
    const m = graph.cells[u];
    const r = regionOf(u);
    if (r < 0 || r >= k) continue;
    const region = regions[r];
    region.cells++;
    region.areaKm2 += mesh.areas[m];
    if (population) region.population += population[m];
    if (gdp && region.gdp !== null) region.gdp += gdp[m];
    const w = population ? population[m] : 1;
    weightSum[r] += w;
    names.forEach((name, c) => {
      const x = columns[name]?.[m] ?? 0;
      lensSum[c][r] += w * x;
      lensSq[c][r] += w * x * x;
    });
    // Hex side from area: A = (3√3/2)s², so s = √(2A / 3√3).
    const side = Math.sqrt((2 * mesh.areas[m]) / (3 * 1.7320508075688772));
    let same = 0;
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
      if (!graph.crossing[e] && regionOf(graph.targets[e]) === r) same++;
    }
    perimeter[r] += Math.max(0, 6 - same) * side;
  }
  const seen = new Uint8Array(graph.size);
  for (let s = 0; s < graph.size; s++) {
    const r = regionOf(s);
    if (seen[s] || r < 0 || r >= k) continue;
    regions[r].pieces++;
    seen[s] = 1;
    const stack = [s];
    while (stack.length) {
      const u = stack.pop() as number; // the loop checks length
      for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
        const v = graph.targets[e];
        if (!seen[v] && regionOf(v) === r) {
          seen[v] = 1;
          stack.push(v);
        }
      }
    }
  }
  for (const region of regions) {
    const r = region.id;
    names.forEach((name, c) => {
      const mean = weightSum[r] > 0 ? lensSum[c][r] / weightSum[r] : 0;
      region.lensMeans[name] = mean;
      region.lensVariances[name] =
        weightSum[r] > 0 ? Math.max(0, lensSq[c][r] / weightSum[r] - mean * mean) : 0;
    });
    region.compactness =
      perimeter[r] > 0 ? (4 * 3.141592653589793 * region.areaKm2) / (perimeter[r] * perimeter[r]) : 0;
  }
  return regions;
}

// --- entry points -----------------------------------------------------------------------------

/**
 * The whole solve as a generator of progress. Drive it with next(cancel?) until done; the return
 * value is the result.
 */
export function* solveSteps(input: SolveInput): Generator<Progress, SolveResult, boolean | undefined> {
  const { graph, params } = input;
  if (graph.size === 0) throw new Error('the scope has no cells');
  if (!Number.isInteger(params.n) || params.n < 1) throw new Error('n must be a positive integer');
  const rng = mulberry32(input.seed);
  const ctx = buildContext(input);
  const local = initialise(ctx, input, rng);
  const state = new State(ctx, local, params.weights, params.contiguity);
  const ran = { moves: 0 };
  const stoppedBy = yield* refine(state, params, rng, ran);

  const assignment = new Int32Array(input.mesh.areas.length).fill(-1);
  for (let u = 0; u < graph.size; u++) assignment[graph.cells[u]] = state.assignment[u];
  // Pieces are exact counts at the end, whatever the refinement tracked.
  for (let r = 0; r < state.k; r++) state.pieces[r] = state.countPieces(r);
  return {
    assignment,
    regions: computeRegionStats(
      input.mesh,
      graph,
      input.columns,
      Object.keys(params.lens),
      assignment,
      state.k,
    ),
    cost: state.terms(),
    constraints: state.constraintReport(),
    iterations: ran.moves,
    stoppedBy,
  };
}

/** Run a solve to completion on this thread. */
export function solve(input: SolveInput, onProgress?: (p: Progress) => void): SolveResult {
  const steps = solveSteps(input);
  for (;;) {
    const step = steps.next(false);
    if (step.done) return step.value;
    onProgress?.(step.value);
  }
}
