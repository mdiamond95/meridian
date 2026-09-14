import { describe, expect, it } from 'vitest';
import { decodeColumn, encodeColumn } from './columns';
import { AtlasFileSchema, type AtlasFile } from './atlas';
import { MeshFileSchema, type MeshFileWire } from './mesh';
import { RegionPackSchema, type RegionPackWire } from './regionPack';

describe('column codec', () => {
  it('round-trips float32 and int32 bit-exactly', () => {
    const floats = new Float32Array([0, -1.5, 3.4028234663852886e38, Number.NaN, 1e-45]);
    const ints = new Int32Array([0, -1, 2147483647, -2147483648]);
    expect(decodeColumn(encodeColumn(floats))).toEqual(floats);
    expect(decodeColumn(encodeColumn(ints))).toEqual(ints);
  });

  it('encodes little-endian so Python numpy "<f4"/"<i4" bytes match', () => {
    // int32 1 → bytes 01 00 00 00 → base64 AQAAAA==
    expect(encodeColumn(new Int32Array([1])).data).toBe('AQAAAA==');
  });

  it('rejects a byte length that disagrees with length', () => {
    expect(() => decodeColumn({ dtype: 'int32', length: 2, data: 'AQAAAA==' })).toThrow();
  });
});

const cell = (id: string, neighbours: number[]) => ({
  id,
  centroid: [-113.49, 53.54] as [number, number],
  area: 252.9,
  province: 'AB' as const,
  cd: '4811',
  csd: '4811061',
  neighbours,
});

const mesh: MeshFileWire = {
  format: 'meridian.mesh',
  version: 'v1',
  h3Resolution: 5,
  cells: [cell('85126e5bfffffff', [1]), cell('85126e5ffffffff', [0])],
  columns: { population: encodeColumn(new Float32Array([1200, 34])) },
};

describe('MeshFile', () => {
  it('accepts a valid mesh', () => {
    expect(MeshFileSchema.safeParse(mesh).success).toBe(true);
  });

  it('rejects a column whose length differs from the cell count', () => {
    const bad = { ...mesh, columns: { population: encodeColumn(new Float32Array([1])) } };
    expect(MeshFileSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects unsorted cells and out-of-range neighbours', () => {
    expect(MeshFileSchema.safeParse({ ...mesh, cells: [...mesh.cells].reverse() }).success).toBe(false);
    expect(MeshFileSchema.safeParse({ ...mesh, cells: [cell('85126e5bfffffff', [5])] }).success).toBe(false);
  });
});

describe('AtlasFile', () => {
  const atlas: AtlasFile = {
    format: 'meridian.atlas',
    version: 'v1',
    events: [
      {
        date: '1905-09-01',
        title: 'Alberta and Saskatchewan',
        note: 'Two provinces are carved from the North-West Territories. Their northern limit is 60°N.',
        changes: [{ unit: 'alberta', kind: 'create' }],
      },
    ],
    units: [
      {
        id: 'alberta',
        name: 'Alberta',
        status: 'province',
        sovereign: 'Canada',
        capital: 'Edmonton',
        validFrom: '1905-09-01',
        validTo: null,
        truth: 'dejure',
        geometryRef: 'alberta_1905',
      },
    ],
  };

  it('accepts a valid atlas, including pre-1500 dates', () => {
    expect(AtlasFileSchema.safeParse(atlas).success).toBe(true);
    const early = { ...atlas, units: [{ ...atlas.units[0], validFrom: '1000-01-01' }] };
    expect(AtlasFileSchema.safeParse(early).success).toBe(true);
  });

  it('rejects an unknown truth layer and an inverted validity range', () => {
    expect(
      AtlasFileSchema.safeParse({ ...atlas, units: [{ ...atlas.units[0], truth: 'claimed' }] }).success,
    ).toBe(false);
    const inverted = { ...atlas, units: [{ ...atlas.units[0], validTo: '1900-01-01' }] };
    expect(AtlasFileSchema.safeParse(inverted).success).toBe(false);
  });
});

describe('RegionPack', () => {
  const pack: RegionPackWire = {
    format: 'meridian.regionPack',
    version: 1,
    meta: {
      seed: 42,
      method: 'balanced',
      params: { n: 2 },
      meshVersion: 'v1',
      scope: { kind: 'province', province: 'AB' },
      date: null,
    },
    assignment: encodeColumn(new Int32Array([0, 1])),
    regions: [
      { id: 0, name: 'North', capital: 'Edmonton', stats: { population: 1200 }, dossier: {} },
      { id: 1, name: 'South', capital: 'Calgary', stats: { population: 34 }, dossier: {} },
    ],
    setAnalysis: {},
  };

  it('accepts a valid pack', () => {
    expect(RegionPackSchema.safeParse(pack).success).toBe(true);
  });

  it('rejects float assignments and duplicate region ids', () => {
    const floatAssignment = { ...pack, assignment: encodeColumn(new Float32Array([0, 1])) };
    expect(RegionPackSchema.safeParse(floatAssignment).success).toBe(false);
    const dupes = { ...pack, regions: [pack.regions[0], { ...pack.regions[1], id: 0 }] };
    expect(RegionPackSchema.safeParse(dupes).success).toBe(false);
  });
});
