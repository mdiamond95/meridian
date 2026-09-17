// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildScopeGraph, meshArrays, scopeMask, type MeshLike } from '../engine/graph';
import type { Topology } from '../schema/topojson';
import { LENS_PRESETS, lensColumns, rank } from './lenses';
import { cellLocator, cellTopology, regionRings } from './outline';
import { regionColours } from './palette';
import { SNAP_LAYERS, snapEdges } from './snap';
import { defaultSpec, prepareSplit, runSplit, withLensPreset } from './split';
import { realSplitterData } from './testing/realSplitterData';

describe('lenses', () => {
  it('ranks within groups, ties by index', () => {
    expect(Array.from(rank([3, 1, 2, 1]))).toEqual([1, 0, Math.fround(2 / 3), Math.fround(1 / 3)]);
    expect(Array.from(rank([5, 1, 9, 2], ['a', 'a', 'b', 'b']))).toEqual([1, 0, 1, 0]);
  });

  it('every preset weights only columns that exist', () => {
    const data = realSplitterData();
    for (const [id, preset] of Object.entries(LENS_PRESETS)) {
      for (const column of Object.keys(preset.weights))
        expect({ id, column, exists: column in data.columns }).toEqual({ id, column, exists: true });
    }
    const index = data.columns.internal_colony_index;
    expect(Math.min(...index)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...index)).toBeLessThanOrEqual(1);
  });

  it('derives indicators from categorical ids', () => {
    const cols = lensColumns({
      columns: { treaty_code: Int32Array.from([1, 4, 0]), population: Int32Array.from([10, 0, 5]) },
      lookups: { treaty_code: { '0': 'none', '1': 'numbered', '4': 'unceded' } },
      provinces: ['AB', 'AB', 'SK'],
      areas: Float64Array.from([1, 1, 1]),
    });
    expect(Array.from(cols.treaty_1)).toEqual([1, 0, 0]);
    expect(Array.from(cols.treaty_4)).toEqual([0, 1, 0]);
    expect(cols.treaty_0).toBeUndefined();
  });
});

describe('snap layers', () => {
  it('marks partition edges, the divide and rivers, and skips unavailable layers', () => {
    const data = realSplitterData();
    const graph = buildScopeGraph(
      data.arrays,
      scopeMask(data.arrays, { kind: 'province', province: 'BC' }, { provinces: data.provinces }),
    );
    const count = (layers: string[]) => snapEdges(graph, layers, data)?.reduce((a, b) => a + b, 0) ?? 0;
    expect(snapEdges(graph, [], data)).toBeUndefined();
    expect(count(['township'])).toBe(0);
    expect(SNAP_LAYERS.find((l) => l.id === 'township')?.available).toBe(false);
    for (const layer of [
      'rivers',
      'basins',
      'continental_divide',
      'cd',
      'csd',
      'graticule',
      'ridings',
      'ecozones',
      'treaties',
    ]) {
      expect({ layer, some: count([layer]) > 0 }).toEqual({ layer, some: true });
    }
    expect(count(['cd', 'csd'])).toBeGreaterThanOrEqual(count(['csd']));
  });

  it('pulls boundaries onto a snap layer when the bonus is weighted', () => {
    const data = realSplitterData();
    const base = {
      ...defaultSpec(),
      scope: { kind: 'province', province: 'AB' } as const,
      n: 6,
      iterations: 40_000,
    };
    const plain = runSplit(base, data);
    const snapped = runSplit({ ...base, snap: ['cd'], weights: { ...base.weights, snap: 1 } }, data);
    const share = (r: ReturnType<typeof runSplit>, flags: Uint8Array) => {
      let cut = 0;
      let on = 0;
      const g = r.prepared.solveGraph;
      for (let u = 0; u < g.size; u++) {
        for (let e = g.offsets[u]; e < g.offsets[u + 1]; e++) {
          const v = g.targets[e];
          if (v < u || r.finished.assignment[g.cells[u]] === r.finished.assignment[g.cells[v]]) continue;
          cut++;
          on += flags[e];
        }
      }
      return on / cut;
    };
    const flags = snapEdges(plain.prepared.solveGraph, ['cd'], data) as Uint8Array;
    expect(share(snapped, flags)).toBeGreaterThan(share(plain, flags));
  }, 60_000);
});

describe('constraints', () => {
  const data = realSplitterData();
  const alberta = {
    ...defaultSpec(),
    scope: { kind: 'province', province: 'AB' } as const,
    n: 4,
    iterations: 60_000,
  };
  const csdOf = (name: string) =>
    data.places.find((p) => p.name === name && p.province === '48')?.csd as string;

  it('keeps pinned places together and apart', () => {
    const calgary = csdOf('Calgary');
    const edmonton = csdOf('Edmonton');
    const redDeer = csdOf('Red Deer');
    const { finished, result } = runSplit(
      { ...alberta, together: [[redDeer, calgary]], apart: [[calgary, edmonton]] },
      data,
    );
    const regionOf = (csd: string) => finished.assignment[data.placeByCsd.get(csd)?.cell ?? -1];
    expect(regionOf(redDeer)).toBe(regionOf(calgary));
    expect(regionOf(calgary)).not.toBe(regionOf(edmonton));
    expect(result.constraints.togetherViolations).toBe(0);
    expect(result.constraints.apartViolations).toBe(0);
  }, 60_000);

  it('holds regions to population limits it can meet', () => {
    const { finished, result } = runSplit(
      {
        ...alberta,
        balance: null,
        weights: { ...alberta.weights, balance: 0 },
        minPopulation: 500_000,
        maxPopulation: 1_600_000,
      },
      data,
    );
    expect(result.constraints.populationOutsideLimits).toBe(0);
    for (const r of finished.regions) expect(r.population).toBeGreaterThanOrEqual(500_000);
  }, 60_000);

  it('carves metros first and names them', () => {
    const { prepared, finished } = runSplit(
      { ...defaultSpec(), n: 5, iterations: 20_000, carveCmas: { enabled: true, minPopulation: 2_000_000 } },
      data,
    );
    expect(prepared.carved.map((c) => c.name).sort()).toEqual(['Montréal', 'Toronto', 'Vancouver']);
    expect(finished.regions).toHaveLength(8);
    expect(
      finished.regions
        .filter((r) => r.carved)
        .map((r) => r.name)
        .sort(),
    ).toEqual(['Montréal', 'Toronto', 'Vancouver']);
    const toronto = data.cmas.find((c) => c.name === 'Toronto');
    const id = finished.regions.find((r) => r.name === 'Toronto')?.id;
    expect(toronto?.cells.every((c) => finished.assignment[c] === id)).toBe(true);
  }, 60_000);

  it('applies a lens preset with a lens weight', () => {
    const spec = withLensPreset(defaultSpec(), 'linguistic');
    expect(spec.lens.french_share).toBe(1);
    expect(spec.weights.lens).toBe(1);
    expect(withLensPreset(spec, null).lens).toEqual({});
    expect(prepareSplit(spec, data).params.lens).toEqual(spec.lens);
  });
});

describe('outlines and colours', () => {
  // Two unit squares side by side sharing arc 1, which each square walks in the opposite direction.
  const topology = {
    type: 'Topology',
    arcs: [
      [
        [1, 0],
        [0, 0],
        [0, 1],
        [1, 1],
      ],
      [
        [1, 1],
        [1, 0],
      ],
      [
        [1, 1],
        [2, 1],
        [2, 0],
        [1, 0],
      ],
    ],
    objects: {
      cells: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', arcs: [[0, 1]] },
          { type: 'Polygon', arcs: [[2, ~1]] },
        ],
      },
    },
  } as unknown as Topology;

  it('drops shared arcs inside a region and closes the boundary into rings', () => {
    const topo = cellTopology(topology);
    const one = regionRings(topo, Int32Array.from([0, 0])).get(0);
    expect(one).toHaveLength(1);
    expect(one?.[0]).toHaveLength(7); // six corners walked, closed back to the start
    expect(one?.[0][0]).toEqual(one?.[0][6]);
    const two = regionRings(topo, Int32Array.from([0, 1]));
    expect(two.get(0)?.[0]).toHaveLength(5);
    expect(two.get(1)?.[0]).toHaveLength(5);
    expect(regionRings(topo, Int32Array.from([-1, 1])).has(0)).toBe(false);
  });

  it('finds the cell under a point', () => {
    const data = realSplitterData();
    const locate = cellLocator(data.arrays);
    const calgary = data.places.find((p) => p.name === 'Calgary');
    expect(locate(calgary?.lng ?? 0, calgary?.lat ?? 0)).toBe(calgary?.cell);
    expect(locate(0, 0)).toBe(-1);
  });

  it('gives neighbouring regions different colours when eight hues allow', () => {
    const tiny: MeshLike = {
      cells: [
        { centroid: [0, 0], area: 1, province: 'AB', neighbours: [1] },
        { centroid: [0.1, 0], area: 1, province: 'AB', neighbours: [0, 2] },
        { centroid: [0.2, 0], area: 1, province: 'AB', neighbours: [1] },
      ],
    };
    const arrays = meshArrays(tiny);
    const graph = buildScopeGraph(arrays, new Uint8Array(3).fill(1));
    const colours = regionColours(graph, Int32Array.from([0, 1, 2]), 3);
    expect(colours[0]).not.toBe(colours[1]);
    expect(colours[1]).not.toBe(colours[2]);
    expect(regionColours(graph, Int32Array.from([0, 1, 2]), 3)).toEqual(colours);
  });
});
