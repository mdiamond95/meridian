// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { LoadedAtlas } from '../atlas/loadAtlas';
import { buildScopeGraph, components, inPolygon, meshArrays, scopeMask, type MeshLike } from './graph';
import { graphFor, realData } from './testing/realData';

/** Two strips of hexes-as-a-line: cells 0-2 at lat 50, cells 3-4 on an "island" 0.5° east. */
const MESH: MeshLike = {
  cells: [
    { centroid: [-114.0, 50], area: 250, province: 'AB', neighbours: [1] },
    { centroid: [-113.9, 50], area: 250, province: 'AB', neighbours: [0, 2] },
    { centroid: [-113.8, 50], area: 250, province: 'SK', neighbours: [1] },
    { centroid: [-113.3, 50], area: 250, province: 'SK', neighbours: [4] },
    { centroid: [-113.2, 50], area: 250, province: 'SK', neighbours: [3] },
  ],
};

describe('scope graph', () => {
  const mesh = meshArrays(MESH);

  it('builds CSR arrays restricted to the scope', () => {
    const mask = scopeMask(
      mesh,
      { kind: 'province', province: 'AB' },
      { provinces: MESH.cells.map((c) => c.province) },
    );
    const graph = buildScopeGraph(mesh, mask);
    expect(Array.from(graph.cells)).toEqual([0, 1]);
    expect(Array.from(graph.local)).toEqual([0, 1, -1, -1, -1]);
    expect(Array.from(graph.targets)).toEqual([1, 0]);
    expect(graph.crossings).toBe(0);
  });

  it('joins separate pieces with one sea crossing between their closest cells', () => {
    const graph = buildScopeGraph(mesh, new Uint8Array(5).fill(1));
    expect(graph.crossings).toBe(1);
    const crossing: [number, number][] = [];
    for (let u = 0; u < graph.size; u++) {
      for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
        if (graph.crossing[e]) crossing.push([u, graph.targets[e]]);
      }
    }
    expect(crossing).toEqual([
      [2, 3],
      [3, 2],
    ]);
  });

  it('selects cells by centre for polygons (holes excluded), regions and atlas units', () => {
    const square = [
      [-114.05, 49],
      [-113.85, 49],
      [-113.85, 51],
      [-114.05, 51],
      [-114.05, 49],
    ];
    const hole = [
      [-113.95, 49.9],
      [-113.85, 49.9],
      [-113.85, 50.1],
      [-113.95, 50.1],
      [-113.95, 49.9],
    ];
    expect(inPolygon([square], -114, 50)).toBe(true);
    expect(inPolygon([square, hole], -113.9, 50)).toBe(false);
    const polygon = scopeMask(mesh, {
      kind: 'polygon',
      geometry: { type: 'Polygon', coordinates: [square] },
    });
    expect(Array.from(polygon)).toEqual([1, 1, 0, 0, 0]);

    const region = scopeMask(
      mesh,
      { kind: 'region', pack: 'x', region: 2 },
      { assignment: Int32Array.from([1, 2, 2, -1, 2]) },
    );
    expect(Array.from(region)).toEqual([0, 1, 1, 0, 1]);

    const atlas = {
      atlas: {
        units: [
          { id: 'alberta', validFrom: '1905-09-01', validTo: null, truth: 'dejure', geometryRef: 'ab' },
        ],
      },
      geometries: new Map([['ab', { type: 'Polygon', coordinates: [square] }]]),
    } as unknown as LoadedAtlas;
    const unit = scopeMask(mesh, { kind: 'atlasUnit', unit: 'alberta' }, { atlas, date: '1950-01-01' });
    expect(Array.from(unit)).toEqual([1, 1, 0, 0, 0]);
    expect(() =>
      scopeMask(mesh, { kind: 'atlasUnit', unit: 'alberta' }, { atlas, date: '1900-01-01' }),
    ).toThrow(/does not exist/);
  });

  it('makes Canada one connected graph and leaves Alberta without crossings', () => {
    const data = realData();
    const canada = graphFor(data, { kind: 'canada' });
    const adjacency = Array.from({ length: canada.size }, (_, u) =>
      Array.from(canada.targets.subarray(canada.offsets[u], canada.offsets[u + 1])),
    );
    expect(Math.max(...components(adjacency))).toBe(0);
    expect(canada.crossings).toBe(49); // matches pipeline/indigenous.py's sea crossings
    expect(graphFor(data, { kind: 'province', province: 'AB' }).crossings).toBe(0);
  });
});
