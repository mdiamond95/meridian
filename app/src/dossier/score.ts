import type { RegionDossier } from '../schema/dossier';
import type { RegionScore } from '../schema/regionPack';
import type { SplitterData } from '../splitter/data';
import { LENS_PRESETS } from '../splitter/lenses';
import type { PreparedSplit } from '../splitter/split';
import type { RegionAggregate } from './stats';

/**
 * Game hooks (vision §8, plan Phase 6 §5): a stable `score` per region, for a game reading the pack.
 * Every field has a one-line definition in docs/interop.md; keep the two in step.
 *
 *   population      people (2021 census)
 *   gdp             allocated GDP, CAD millions (an allocation: the dossier's gdpCaveat applies)
 *   resource_index  labour-force share in NAICS 11 (agriculture, forestry, fishing, hunting) and 21
 *                   (mining, quarrying, oil and gas)
 *   cohesion        1 − lens variance: each lens column scaled to 0–1 over the scope, its
 *                   population-weighted variance inside the region averaged over the columns, times 4
 *                   (the largest variance a 0–1 value can have is ¼), subtracted from 1
 *   exposure        the dependency score: the labour-force share of the region's largest industry
 *
 * The lens is the split's own; a split made without one (balanced, seeded, random) is scored on the
 * Economic preset's columns, so every pack has a cohesion.
 */

const EXTRACTIVE = ['11', '21'];
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export interface ScoreInput {
  data: SplitterData;
  prepared: PreparedSplit;
  assignment: Int32Array;
  aggregates: RegionAggregate[];
  dossiers: RegionDossier[];
}

/** The columns cohesion is measured on. */
export function cohesionColumns(prepared: PreparedSplit, data: SplitterData): string[] {
  const own = Object.entries(prepared.spec.lens)
    .filter(([name, weight]) => weight > 0 && data.columns[name])
    .map(([name]) => name);
  const columns = own.length
    ? own
    : Object.keys(LENS_PRESETS.economic.weights).filter((n) => data.columns[n]);
  return columns.sort();
}

export function regionScores(input: ScoreInput): RegionScore[] {
  const { data, prepared, assignment, aggregates, dossiers } = input;
  const k = aggregates.length;
  const cells = prepared.scopeGraph.cells;
  const population = data.columns.population;
  const names = cohesionColumns(prepared, data);

  const variance = new Float64Array(k);
  for (const name of names) {
    const column = data.columns[name];
    let lo = Infinity;
    let hi = -Infinity;
    for (const cell of cells) {
      const x = column[cell];
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    const span = hi > lo ? hi - lo : 1;
    const w = new Float64Array(k);
    const sum = new Float64Array(k);
    const sq = new Float64Array(k);
    for (const cell of cells) {
      const r = assignment[cell];
      if (r < 0 || r >= k) continue;
      // People, not hexagons; an empty region falls back to one per cell.
      const weight = aggregates[r].population > 0 ? (population?.[cell] ?? 0) : 1;
      const x = (column[cell] - lo) / span;
      w[r] += weight;
      sum[r] += weight * x;
      sq[r] += weight * x * x;
    }
    for (let r = 0; r < k; r++) {
      if (w[r] <= 0) continue;
      const mean = sum[r] / w[r];
      variance[r] += Math.max(0, sq[r] / w[r] - mean * mean);
    }
  }

  return aggregates.map((aggregate, r) => ({
    population: Math.round(aggregate.population),
    gdp: Math.round(aggregate.gdpCadMillions ?? 0),
    resource_index: round3(EXTRACTIVE.reduce((sum, code) => sum + (aggregate.industries.get(code) ?? 0), 0)),
    cohesion: round3(Math.min(1, Math.max(0, 1 - (4 * variance[r]) / Math.max(1, names.length)))),
    exposure: round3(dossiers[r]?.dependencyScore ?? 0),
  }));
}
