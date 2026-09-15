import { describe, expect, it } from 'vitest';
import type { Topology } from '../schema/topojson';
import { bounds, topologyDecoder } from './topology';

// Two unit squares sharing the edge x = 1, quantized with scale 1 and delta-encoded arcs:
// arc 0 is the shared edge (1,0)→(1,1); arcs 1 and 2 are the outer runs of each square.
const TOPOLOGY: Topology = {
  type: 'Topology',
  transform: { scale: [1, 1], translate: [0, 0] },
  arcs: [
    [
      [1, 0],
      [0, 1],
    ],
    [
      [1, 1],
      [-1, 0],
      [0, -1],
      [1, 0],
    ],
    [
      [1, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
    ],
  ],
  objects: {
    west: { type: 'Polygon', arcs: [[0, 1]] },
    east: { type: 'Polygon', arcs: [[2, -1]] },
    both: { type: 'MultiPolygon', arcs: [[[0, 1]], [[2, -1]]] },
    point: { type: 'Point', coordinates: [0, 0] },
  },
};

describe('topologyDecoder', () => {
  const decode = topologyDecoder(TOPOLOGY);

  it('delta-decodes arcs and joins them without repeating shared points', () => {
    expect(decode('west')).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
          [1, 0],
        ],
      ],
    });
  });

  it('reverses negative arc indices, so neighbours share one edge', () => {
    const east = decode('east');
    expect(east.coordinates[0]).toEqual([
      [1, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 0],
    ]);
    expect(bounds(decode('both'))).toEqual([0, 0, 2, 1]);
  });

  it('applies the quantization transform', () => {
    const scaled = topologyDecoder({ ...TOPOLOGY, transform: { scale: [0.5, 2], translate: [-100, 40] } });
    expect(bounds(scaled('west'))).toEqual([-100, 40, -99.5, 42]);
  });

  it('rejects missing and non-polygon objects', () => {
    expect(() => decode('nowhere')).toThrow(/no object/);
    expect(() => decode('point')).toThrow(/not a polygon/);
  });
});
