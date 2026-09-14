import { describe, expect, it } from 'vitest';
// Shared fixtures written by pipeline/make_examples.py and validated by pytest with jsonschema too.
import attrsExample from '../../../docs/schemas/examples/attrs.example.json';
import atlasExample from '../../../docs/schemas/examples/atlas.example.json';
import columnVectors from '../../../docs/schemas/examples/column-vectors.json';
import meshExample from '../../../docs/schemas/examples/mesh.example.json';
import regionPackExample from '../../../docs/schemas/examples/regionPack.example.json';
import topologyExample from '../../../docs/schemas/examples/topojson.example.json';
import { AtlasFileSchema } from './atlas';
import { AttrsFileSchema } from './attrs';
import {
  decodeColumn,
  dtypeForKind,
  encodeColumn,
  EncodedColumnSchema,
  type ColumnKind,
  type EncodedColumn,
} from './columns';
import { MeshFileSchema } from './mesh';
import { RegionPackSchema } from './regionPack';
import { TopologySchema } from './topojson';

const clone = <T>(value: T): T => structuredClone(value);
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('column encoding', () => {
  for (const vector of columnVectors.vectors) {
    const kind = vector.kind as ColumnKind;
    const typed =
      dtypeForKind(kind) === 'int32' ? Int32Array.from(vector.values) : Float32Array.from(vector.values);

    it(`matches the Python writer byte for byte: ${vector.name}`, () => {
      expect(encodeColumn(typed, { kind }).data).toBe(vector.column.data);
      expect(Array.from(decodeColumn(EncodedColumnSchema.parse(vector.column)))).toEqual(vector.values);
    });
  }

  it('is explicitly little-endian: 0x01020304 is stored as 04 03 02 01', () => {
    const column = encodeColumn(new Int32Array([0x01020304]), { kind: 'id' });
    expect(column.byteOrder).toBe('le');
    const bytes = Uint8Array.from(atob(column.data), (c) => c.charCodeAt(0));
    expect(Array.from(bytes)).toEqual([0x04, 0x03, 0x02, 0x01]);
    // Reading the same bytes big-endian gives a different number, so order genuinely matters.
    expect(new DataView(bytes.buffer).getInt32(0, false)).toBe(0x04030201);
    expect(decodeColumn(column)[0]).toBe(0x01020304);
  });

  it('round-trips float32 edge values bit-exactly', () => {
    const floats = new Float32Array([0, -1.5, 3.4028234663852886e38, Number.NaN, 1e-45]);
    expect(decodeColumn(encodeColumn(floats, { kind: 'rate' }))).toEqual(floats);
  });

  it('enforces the dtype rule', () => {
    expect(() => encodeColumn(new Float32Array([1]), { kind: 'count' })).toThrow(/int32/);
    expect(() => encodeColumn(new Int32Array([1]), { kind: 'share' })).toThrow(/float32/);
    expect(() => encodeColumn(new Float32Array([1]), { kind: 'money' })).toThrow();
    expect(() => encodeColumn(new Float32Array([1]), { kind: 'money', unit: 'cad' })).toThrow();
    expect(() => encodeColumn(new Float32Array([1]), { kind: 'measure' })).toThrow();
    expect(encodeColumn(new Float32Array([1]), { kind: 'money', unit: 'cad_millions' }).dtype).toBe(
      'float32',
    );

    const count = encodeColumn(new Int32Array([1]), { kind: 'count' });
    expect(ok(EncodedColumnSchema, { ...count, dtype: 'float32' })).toBe(false);
    expect(ok(EncodedColumnSchema, { ...count, byteOrder: 'be' })).toBe(false);
    expect(ok(EncodedColumnSchema, { ...count, unit: 'people' })).toBe(false);
  });

  it('rejects a byte length that disagrees with length', () => {
    const column: EncodedColumn = {
      kind: 'id',
      dtype: 'int32',
      byteOrder: 'le',
      length: 2,
      data: 'AQAAAA==',
    };
    expect(() => decodeColumn(column)).toThrow();
  });
});

describe('MeshFile', () => {
  it('accepts the shared example', () => {
    expect(MeshFileSchema.safeParse(meshExample).error).toBeUndefined();
  });

  it('requires cell ids as lowercase hex strings, never JSON numbers', () => {
    const numeric = clone(meshExample) as { cells: { id: unknown }[] };
    numeric.cells[0].id = Number.parseInt(meshExample.cells[0].id, 16);
    expect(ok(MeshFileSchema, numeric)).toBe(false);

    const upper = clone(meshExample);
    upper.cells[0].id = upper.cells[0].id.toUpperCase();
    expect(ok(MeshFileSchema, upper)).toBe(false);
  });

  it('requires cells strictly sorted by id string and at the declared resolution', () => {
    const unsorted = clone(meshExample);
    unsorted.cells.reverse();
    expect(ok(MeshFileSchema, unsorted)).toBe(false);
    expect(ok(MeshFileSchema, { ...clone(meshExample), h3Resolution: 6 })).toBe(false);
  });

  it('requires meta.byteOrder, snake_case column names, and full-length columns', () => {
    const noMeta: Partial<typeof meshExample> = clone(meshExample);
    delete noMeta.meta;
    expect(ok(MeshFileSchema, noMeta)).toBe(false);

    const population = encodeColumn(new Int32Array(meshExample.cells.length), { kind: 'count' });
    expect(ok(MeshFileSchema, { ...clone(meshExample), columns: { population } })).toBe(true);
    expect(ok(MeshFileSchema, { ...clone(meshExample), columns: { totalPop: population } })).toBe(false);
    expect(ok(MeshFileSchema, { ...clone(meshExample), columns: { pop__2021: population } })).toBe(false);
    const short = encodeColumn(new Int32Array(1), { kind: 'count' });
    expect(ok(MeshFileSchema, { ...clone(meshExample), columns: { population: short } })).toBe(false);
  });

  it('rejects out-of-range neighbours', () => {
    const bad = clone(meshExample);
    bad.cells[0].neighbours = [99];
    expect(ok(MeshFileSchema, bad)).toBe(false);
  });
});

describe('AttrsFile', () => {
  it('accepts the shared example and decodes columns the Python writer encoded', () => {
    const attrs = AttrsFileSchema.parse(attrsExample);
    expect(Array.from(decodeColumn(attrs.columns.population))).toEqual([
      412000, 58000, 91000, 120500, 33000, 77000, 1500,
    ]);
    expect(decodeColumn(attrs.columns.gdp_estimate)[0]).toBe(31250.5);
    expect(decodeColumn(attrs.columns.french_share)[0]).toBeCloseTo(0.021, 6);
    expect(attrs.meta.byteOrder).toBe('le');
  });

  it('rejects wrong lengths, lookups on non-id columns, and a money column without its unit', () => {
    expect(ok(AttrsFileSchema, { ...clone(attrsExample), cellCount: 8 })).toBe(false);

    const lookup = clone(attrsExample) as { lookups: Record<string, Record<string, string>> };
    lookup.lookups.population = { '0': 'none' };
    expect(ok(AttrsFileSchema, lookup)).toBe(false);

    const money = clone(attrsExample) as { columns: { gdp_estimate: Record<string, unknown> } };
    delete money.columns.gdp_estimate.unit;
    expect(ok(AttrsFileSchema, money)).toBe(false);
  });
});

describe('AtlasFile', () => {
  it('accepts the shared example, including pre-1500 dates', () => {
    expect(ok(AtlasFileSchema, atlasExample)).toBe(true);
    const early = clone(atlasExample);
    early.units[0].validFrom = '1000-01-01';
    expect(ok(AtlasFileSchema, early)).toBe(true);
  });

  it('rejects an unknown truth layer and an inverted validity range', () => {
    const truth = clone(atlasExample);
    truth.units[0].truth = 'claimed';
    expect(ok(AtlasFileSchema, truth)).toBe(false);
    const inverted = clone(atlasExample) as { units: { validTo: string | null }[] };
    inverted.units[0].validTo = '1900-01-01';
    expect(ok(AtlasFileSchema, inverted)).toBe(false);
  });
});

describe('RegionPack', () => {
  it('accepts the shared example', () => {
    expect(RegionPackSchema.safeParse(regionPackExample).error).toBeUndefined();
  });

  it('rejects non-id assignments, a missing byteOrder, and duplicate region ids', () => {
    const floatAssignment = {
      ...clone(regionPackExample),
      assignment: encodeColumn(new Float32Array([0, 1]), { kind: 'index' }),
    };
    expect(ok(RegionPackSchema, floatAssignment)).toBe(false);

    const noOrder = clone(regionPackExample) as { meta: { byteOrder?: string } };
    delete noOrder.meta.byteOrder;
    expect(ok(RegionPackSchema, noOrder)).toBe(false);

    const dupes = clone(regionPackExample);
    dupes.regions[1].id = 0;
    expect(ok(RegionPackSchema, dupes)).toBe(false);
  });
});

describe('Topology', () => {
  it('accepts the shared example and rejects non-topologies', () => {
    expect(ok(TopologySchema, topologyExample)).toBe(true);
    expect(ok(TopologySchema, { ...clone(topologyExample), type: 'FeatureCollection' })).toBe(false);
  });
});
