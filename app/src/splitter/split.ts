import type { LoadedAtlas } from '../atlas/loadAtlas';
import { buildScopeGraph, scopeMask, type MeshArrays, type ScopeGraph } from '../engine/graph';
import {
  computeRegionStats,
  DEFAULT_WEIGHTS,
  defaultParams,
  solve,
  type Contiguity,
  type Params,
  type RegionStats,
  type SolveResult,
  type Weights,
} from '../engine/solver';
import type { Scope, SplitMethod } from '../schema/regionPack';
import type { Cma } from '../schema/places';
import type { SplitterData } from './data';
import { LENS_PRESETS, type LensPresetId } from './lenses';
import { snapEdges } from './snap';

/**
 * A split, described completely enough to reproduce it: what the Generate panel edits, what a pack's
 * meta records, what the share link carries. `prepareSplit` turns it into a solver input;
 * `finishSplit` turns the solver's result (plus any carved metros) into named regions.
 */
export interface SplitSpec {
  scope: Scope;
  /** atlas date for atlasUnit scopes; null = present day */
  date: string | null;
  method: SplitMethod;
  random?: 'voronoi' | 'cuts';
  n: number;
  seed: number;
  lensPreset: LensPresetId | null;
  /** lens column → weight; a preset fills this, sliders edit it */
  lens: Record<string, number>;
  /** 'population' | 'gdp_estimate' | 'area' | 'cells' | null */
  balance: string | null;
  contiguity: Contiguity;
  /** seeded: capitals as [lng, lat] */
  capitalPoints?: [number, number][];
  /** names for the capitals, in the same order; a seeded region takes its capital's name */
  capitalNames?: string[];
  minPopulation?: number;
  maxPopulation?: number;
  /** keep-together groups and keep-apart groups, as CSD uids */
  together: string[][];
  apart: string[][];
  carveCmas: { enabled: boolean; minPopulation: number };
  /** snap layer ids (src/splitter/snap.ts) */
  snap: string[];
  weights: Weights;
  iterations: number;
  /**
   * Names by a column (1.0.1): regions ranked by the population-weighted mean of `column`, highest
   * first, take `names` in order. acadie-2 names its more francophone region Acadie this way, and the
   * rule travels with the recipe, so a pack, a share link and a rerun all name it the same.
   */
  nameBy?: { column: string; names: string[] };
}

export function defaultSpec(): SplitSpec {
  const params = defaultParams(10, 'balanced');
  return {
    scope: { kind: 'canada' },
    date: null,
    method: 'balanced',
    n: 10,
    seed: 1,
    lensPreset: null,
    lens: {},
    balance: 'population',
    contiguity: 'hard',
    together: [],
    apart: [],
    carveCmas: { enabled: false, minPopulation: 1_000_000 },
    snap: [],
    weights: { ...DEFAULT_WEIGHTS },
    iterations: params.iterations,
  };
}

/** Apply a lens preset: its weights, and a lens weight in the cost if there was none. */
export function withLensPreset(spec: SplitSpec, preset: LensPresetId | null): SplitSpec {
  if (!preset) return { ...spec, lensPreset: null, lens: {} };
  const weights = spec.weights.lens > 0 ? spec.weights : { ...spec.weights, lens: 1 };
  return { ...spec, lensPreset: preset, lens: { ...LENS_PRESETS[preset].weights }, weights };
}

export interface ScopeContext {
  atlas?: LoadedAtlas;
  /** for region scopes: the pack assignment the region id refers to */
  packAssignment?: Int32Array;
  /** the imported snap layer's edge keys, when one is loaded */
  importedSnap?: ReadonlySet<number>;
}

export interface PreparedSplit {
  spec: SplitSpec;
  /** the whole scope, carved metros included */
  scopeMask: Uint8Array;
  scopeGraph: ScopeGraph;
  /** what the solver splits: the scope less carved metros */
  solveMask: Uint8Array;
  solveGraph: ScopeGraph;
  carved: Cma[];
  params: Params;
  snap: Uint8Array | undefined;
}

/** Cells for each group of CSDs: every cell of the CSD, or the cell holding its point if it has none. */
function pinCells(groups: string[][], data: SplitterData): number[][] {
  const cellsByCsd = new Map<string, number[]>();
  data.csds.forEach((csd, i) => {
    const list = cellsByCsd.get(csd);
    if (list) list.push(i);
    else cellsByCsd.set(csd, [i]);
  });
  return groups.map((group) =>
    group.flatMap(
      (csd) => cellsByCsd.get(csd) ?? (data.placeByCsd.has(csd) ? [data.placeByCsd.get(csd)?.cell ?? 0] : []),
    ),
  );
}

export function prepareSplit(spec: SplitSpec, data: SplitterData, context: ScopeContext = {}): PreparedSplit {
  return prepareFromScope(spec, scopeOf(spec, data, context), data, context.importedSnap);
}

/**
 * The cells in a spec's scope. This part needs the atlas (atlas scopes) or a parent pack (nested
 * splits), which only the main thread has; everything after it runs in the worker (prepareFromScope).
 */
export function scopeOf(
  spec: SplitSpec,
  data: Pick<SplitterData, 'arrays' | 'provinces'>,
  context: ScopeContext = {},
) {
  return scopeMask(data.arrays, spec.scope, {
    provinces: data.provinces,
    atlas: context.atlas,
    date: spec.date ?? undefined,
    assignment: context.packAssignment,
  });
}

/** Everything prepareSplit does once the scope is known: carving, graphs, pins, parameters, snapping. */
export function prepareFromScope(
  spec: SplitSpec,
  scope: Uint8Array,
  data: SplitterData,
  importedSnap?: ScopeContext['importedSnap'],
): PreparedSplit {
  const solveMask = Uint8Array.from(scope);
  const carved: Cma[] = [];
  if (spec.carveCmas.enabled) {
    for (const cma of data.cmas) {
      if (cma.population < spec.carveCmas.minPopulation) continue;
      const inside = cma.cells.filter((c) => scope[c]);
      if (inside.length !== cma.cells.length || inside.length === 0) continue;
      carved.push(cma);
      for (const c of inside) solveMask[c] = 0;
    }
  }
  const solveGraph = cachedScopeGraph(data.arrays, solveMask);
  const scopeGraph = carved.length ? cachedScopeGraph(data.arrays, scope) : solveGraph;

  // Pins: a keep-together group applies to cells still being split; a keep-apart group applies to
  // one anchor cell per CSD (a whole city cannot be apart from itself).
  const together = pinCells(spec.together, data).map((g) => g.filter((c) => solveMask[c]));
  const apartAnchors = spec.apart.map((group) =>
    group.map((csd) => data.placeByCsd.get(csd)?.cell ?? -1).filter((c) => c >= 0 && solveMask[c]),
  );

  const params: Params = {
    ...defaultParams(spec.n, spec.method),
    n: spec.n,
    method: spec.method,
    random: spec.random,
    balance: spec.balance,
    lens: spec.lens,
    weights: spec.weights,
    contiguity: spec.contiguity,
    iterations: spec.iterations,
    capitalPoints: spec.capitalPoints,
    populationLimits:
      spec.minPopulation !== undefined || spec.maxPopulation !== undefined
        ? { min: spec.minPopulation, max: spec.maxPopulation }
        : undefined,
    pins: together.length || apartAnchors.length ? { together, apart: apartAnchors } : undefined,
  };
  return {
    spec,
    scopeMask: scope,
    scopeGraph,
    solveMask,
    solveGraph,
    carved,
    params,
    snap: snapEdges(solveGraph, spec.snap, data, importedSnap),
  };
}

/**
 * A prepared split for an assignment that no spec reproduces — a template drawn elsewhere, or a pack
 * re-fitted from another mesh: the scope is simply the cells it assigns.
 */
export function preparedFromAssignment(
  spec: SplitSpec,
  assignment: Int32Array,
  data: SplitterData,
): PreparedSplit {
  const mask = Uint8Array.from(assignment, (r) => (r >= 0 ? 1 : 0));
  const graph = cachedScopeGraph(data.arrays, mask);
  return {
    spec,
    scopeMask: mask,
    scopeGraph: graph,
    solveMask: mask,
    solveGraph: graph,
    carved: [],
    params: { ...defaultParams(spec.n, spec.method), n: spec.n, method: spec.method },
    snap: undefined,
  };
}

export interface NamedRegion extends RegionStats {
  name: string;
  capital: string | null;
  /** carved metro, not a solver region */
  carved: boolean;
}

export interface FinishedSplit {
  /** region id per mesh cell, -1 outside the scope */
  assignment: Int32Array;
  regions: NamedRegion[];
}

/** Merge carved metros into the solver's assignment (ids after the solver's) and name every region. */
export function finishSplit(
  prepared: PreparedSplit,
  result: Pick<SolveResult, 'assignment' | 'regions'>,
  data: SplitterData,
): FinishedSplit {
  const assignment = Int32Array.from(result.assignment);
  const k = result.regions.length;
  prepared.carved.forEach((cma, i) => {
    for (const c of cma.cells) assignment[c] = k + i;
  });
  return { assignment, regions: nameRegions(prepared, assignment, k + prepared.carved.length, data) };
}

/** The names a spec's `nameBy` rule gives, by region id; empty without a rule. */
export function ruleNames(
  spec: Pick<SplitSpec, 'nameBy'>,
  data: Pick<SplitterData, 'columns'>,
  assignment: Int32Array,
  k: number,
): Record<number, string> {
  const rule = spec.nameBy;
  const column = rule && data.columns[rule.column];
  if (!rule || !column) return {};
  const population = data.columns.population;
  const weight = new Float64Array(k);
  const sum = new Float64Array(k);
  for (let cell = 0; cell < assignment.length; cell++) {
    const r = assignment[cell];
    if (r < 0 || r >= k) continue;
    const w = population ? population[cell] : 1;
    weight[r] += w;
    sum[r] += w * column[cell];
  }
  const ranked = Array.from({ length: k }, (_, r) => r).sort(
    (a, b) => sum[b] / (weight[b] || 1) - sum[a] / (weight[a] || 1) || a - b,
  );
  const out: Record<number, string> = {};
  ranked.forEach((r, i) => {
    if (rule.names[i]) out[r] = rule.names[i];
  });
  return out;
}

/** Stats and names for any assignment over the prepared scope (after painting, too). */
export function nameRegions(
  prepared: PreparedSplit,
  assignment: Int32Array,
  k: number,
  data: SplitterData,
): NamedRegion[] {
  const stats = computeRegionStats(
    data.arrays,
    prepared.scopeGraph,
    data.columns,
    Object.keys(prepared.spec.lens),
    assignment,
    k,
  );
  const solverRegions = k - prepared.carved.length;
  // Each region is named after the census subdivision with the most people inside it (cell
  // populations summed by CSD; ties by CSD uid). A city split between regions names the one holding
  // more of it, whichever cell its representative point is in.
  const population = data.columns.population;
  const byRegion = new Map<number, Map<string, number>>();
  for (let u = 0; u < prepared.scopeGraph.size; u++) {
    const cell = prepared.scopeGraph.cells[u];
    const r = assignment[cell];
    if (r < 0) continue;
    let counts = byRegion.get(r);
    if (!counts) byRegion.set(r, (counts = new Map()));
    const csd = data.csds[cell];
    counts.set(csd, (counts.get(csd) ?? 0) + (population ? population[cell] : 0));
  }
  // Names are unique: regions choose in order of their largest CSD population (ties by region id),
  // each taking its most populous CSD not already taken, so a city split three ways names one region
  // and its neighbours take their next-largest places.
  const ranked = [...byRegion].map(([r, counts]) => ({
    r,
    candidates: [...counts]
      .filter(([csd, people]) => people > 0 && data.placeByCsd.has(csd))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
  }));
  ranked.sort((a, b) => (b.candidates[0]?.[1] ?? 0) - (a.candidates[0]?.[1] ?? 0) || a.r - b.r);
  const taken = new Set<string>();
  const best = new Map<number, { name: string }>();
  for (const { r, candidates } of ranked) {
    const pick = candidates.find(([csd]) => !taken.has(data.placeByCsd.get(csd)?.name ?? csd));
    const place = pick && data.placeByCsd.get(pick[0]);
    if (place) {
      taken.add(place.name);
      best.set(r, { name: place.name });
      continue;
    }
    // Every place in the region already names another (a region inside one city): number it.
    const largest = candidates[0] && data.placeByCsd.get(candidates[0][0]);
    if (largest) {
      let k = 2;
      while (taken.has(`${largest.name} (${k})`)) k++;
      taken.add(`${largest.name} (${k})`);
      best.set(r, { name: `${largest.name} (${k})` });
    }
  }
  const ruled = ruleNames(prepared.spec, data, assignment, solverRegions);
  return stats.map((region) => {
    const carved = region.id >= solverRegions;
    const place = best.get(region.id);
    // Seeded regions keep their seed order, so a named capital names its region.
    const capital =
      !carved && prepared.spec.method === 'seeded' ? prepared.spec.capitalNames?.[region.id] : undefined;
    const name = carved
      ? prepared.carved[region.id - solverRegions].name
      : (ruled[region.id] ?? capital ?? place?.name ?? `Region ${region.id + 1}`);
    return { ...region, name, capital: capital ?? place?.name ?? null, carved };
  });
}

/** Prepare, solve on this thread and finish: for presets, tests and small scopes. */
export function runSplit(spec: SplitSpec, data: SplitterData, context: ScopeContext = {}) {
  const prepared = prepareSplit(spec, data, context);
  const result = solve({
    mesh: data.arrays,
    graph: prepared.solveGraph,
    columns: data.columns,
    params: prepared.params,
    seed: spec.seed,
    snapEdges: prepared.snap,
  });
  return { prepared, result, finished: finishSplit(prepared, result, data) };
}

/**
 * Scope graphs of the last few masks, per mesh. Building one for all of Canada costs about 300 ms on
 * the main thread (most of it finding the sea crossings), and a user re-running the same scope with
 * another N or seed should not pay it again (docs/perf.md). Graphs are read-only once built.
 */
const graphCache = new WeakMap<MeshArrays, Map<string, ScopeGraph>>();
const GRAPH_CACHE_SIZE = 4;

function maskKey(mask: Uint8Array): string {
  // FNV-1a over the bytes, plus the count of cells in scope: a collision would need both to agree.
  let hash = 0x811c9dc5;
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    hash = Math.imul(hash ^ mask[i], 0x01000193);
    count += mask[i] ? 1 : 0;
  }
  return `${mask.length}:${count}:${(hash >>> 0).toString(16)}`;
}

export function cachedScopeGraph(arrays: MeshArrays, mask: Uint8Array): ScopeGraph {
  let graphs = graphCache.get(arrays);
  if (!graphs) graphCache.set(arrays, (graphs = new Map()));
  const key = maskKey(mask);
  const hit = graphs.get(key);
  if (hit) {
    // Most recently used last, so the oldest is the one dropped.
    graphs.delete(key);
    graphs.set(key, hit);
    return hit;
  }
  const graph = buildScopeGraph(arrays, mask);
  graphs.set(key, graph);
  if (graphs.size > GRAPH_CACHE_SIZE) graphs.delete(graphs.keys().next().value as string);
  return graph;
}
