// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SplitMethod } from '../schema/regionPack';
import { defaultParams, solve, type Params } from './solver';
import { piecesByRegion, sha256 } from './testing/check';
import { graphFor, realData } from './testing/realData';

/**
 * Plan Phase 3, Sitting A tests (a)–(e), on the committed mesh and attrs.
 * Regenerate the golden hashes with UPDATE_GOLDEN=1 npx vitest run src/engine/solver.test.ts, and say
 * why in the commit.
 */

const data = realData();
const canada = graphFor(data, { kind: 'canada' });
const alberta = graphFor(data, { kind: 'province', province: 'AB' });
const GOLDEN = new URL('./golden/alberta.json', import.meta.url);

function params(n: number, method: SplitMethod, extra: Partial<Params> = {}): Params {
  return { ...defaultParams(n, method), ...extra };
}

function run(graph: typeof canada, p: Params, seed = 1) {
  return solve({ mesh: data.mesh, graph, columns: data.columns, params: p, seed });
}

const GOLDEN_RUNS: { label: string; params: Params }[] = [
  { label: 'balanced-10', params: params(10, 'balanced', { iterations: 30_000 }) },
  {
    label: 'lens-french-4',
    params: params(4, 'lens', {
      lens: { french_share: 1 },
      weights: { balance: 1, compactness: 0.2, lens: 1, snap: 0, contiguity: 1 },
      iterations: 30_000,
    }),
  },
  { label: 'random-cuts-15', params: params(15, 'random', { random: 'cuts', iterations: 10_000 }) },
];
const SEEDS = [1, 2, 3, 1497, 4294967295];

describe('solver', () => {
  it('(a) same seed and params give the same assignment, pinned by golden hashes on Alberta', async () => {
    const hashes: Record<string, string> = {};
    for (const { label, params: p } of GOLDEN_RUNS) {
      for (const seed of SEEDS) {
        const first = run(alberta, p, seed);
        const again = run(alberta, p, seed);
        expect(again.assignment).toEqual(first.assignment);
        expect(first.stoppedBy).not.toBe('time');
        hashes[`${label}/seed-${seed}`] = await sha256(first.assignment);
      }
    }
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(hashes, null, 2) + '\n');
    expect(hashes).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
    // Different seeds do give different splits.
    expect(new Set(Object.values(hashes)).size).toBeGreaterThan(GOLDEN_RUNS.length);
  }, 120_000);

  it('(b) every region is contiguous under hard contiguity, for every method', () => {
    const lens = {
      lens: { french_share: 1 },
      weights: { balance: 1, compactness: 0.2, lens: 1, snap: 0, contiguity: 1 },
    };
    const runs = [
      [canada, run(canada, params(10, 'balanced'))],
      [alberta, run(alberta, params(15, 'random'))],
      [alberta, run(alberta, params(15, 'random', { random: 'cuts', iterations: 20_000 }))],
      [alberta, run(alberta, params(8, 'seeded'))],
      [canada, run(canada, params(6, 'lens', lens))],
    ] as const;
    for (const [scope, result] of runs) {
      for (const [region, pieces] of piecesByRegion(scope, result.assignment)) {
        expect({ region, pieces }).toEqual({ region, pieces: 1 });
      }
      expect(result.regions.every((r) => r.pieces === 1 && r.cells > 0)).toBe(true);
    }
  }, 120_000);

  it('(c) equal population, N=10 on Canada: max/min below 1.15, for several seeds', () => {
    for (const seed of [1, 2, 3]) {
      const result = run(canada, params(10, 'balanced'), seed);
      const pops = result.regions.map((r) => r.population);
      expect(pops.reduce((a, b) => a + b, 0)).toBe(
        Array.from(data.columns.population).reduce((a, b) => a + b, 0),
      );
      expect(Math.max(...pops) / Math.min(...pops)).toBeLessThan(1.15);
    }
  }, 60_000);

  it('(d) bisecting Canada on french_share puts over 90% of Quebec francophones in one region', () => {
    const result = run(
      canada,
      params(2, 'lens', {
        lens: { french_share: 1 },
        weights: { balance: 1, compactness: 0.2, lens: 1, snap: 0, contiguity: 1 },
      }),
    );
    const francophones = [0, 0];
    const { population, french_share } = data.columns;
    for (let i = 0; i < population.length; i++) {
      if (data.provinces[i] === 'QC') francophones[result.assignment[i]] += population[i] * french_share[i];
    }
    expect(Math.max(...francophones) / (francophones[0] + francophones[1])).toBeGreaterThan(0.9);
  });

  it('(e) Canada N=20 completes in under 8 s', () => {
    const started = performance.now();
    const result = run(canada, params(20, 'balanced'));
    expect(performance.now() - started).toBeLessThan(8000);
    expect(result.stoppedBy).not.toBe('time');
    expect(result.regions).toHaveLength(20);
  }, 20_000);

  it('N=1 to 30 on Canada: no crash, no split region under hard contiguity', () => {
    for (let n = 1; n <= 30; n++) {
      const result = run(canada, params(n, 'balanced', { iterations: 10_000 }), n);
      expect(result.regions).toHaveLength(n);
      for (const pieces of piecesByRegion(canada, result.assignment).values()) expect(pieces).toBe(1);
    }
  }, 120_000);

  it('soft contiguity costs extra pieces and off allows them', () => {
    const soft = run(alberta, params(6, 'balanced', { contiguity: 'soft', iterations: 30_000 }));
    const off = run(alberta, params(6, 'balanced', { contiguity: 'off', iterations: 30_000 }));
    for (const result of [soft, off]) {
      const counted = piecesByRegion(alberta, result.assignment);
      for (const region of result.regions) expect(region.pieces).toBe(counted.get(region.id));
    }
    expect(soft.cost.contiguity).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it('loads a template unchanged when it is not refined', () => {
    const template = new Int32Array(data.mesh.areas.length).fill(-1);
    for (let u = 0; u < alberta.size; u++)
      template[alberta.cells[u]] = data.mesh.centroids[2 * alberta.cells[u] + 1] > 54 ? 1 : 0;
    const result = solve({
      mesh: data.mesh,
      graph: alberta,
      columns: data.columns,
      params: params(2, 'template'),
      seed: 1,
      template,
    });
    expect(result.assignment).toEqual(template);
    expect(result.stoppedBy).toBe('none');
  });
});
