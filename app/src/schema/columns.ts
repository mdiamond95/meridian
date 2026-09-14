import { z } from 'zod';

/**
 * Wire encoding for typed-array columns shared by every Meridian artefact.
 *
 * JSON cannot carry a Float32Array, so columns travel as base64 of the raw bytes plus a
 * dtype and an explicit byte order. Bytes are always little-endian: the Python writer uses
 * '<i4' / '<f4' (pipeline/columns.py) and this decoder reads through DataView with
 * littleEndian = true, so neither side depends on the host's native order.
 *
 * The dtype rule (docs/decisions.md) is enforced here through `kind`:
 *   count, id               → int32
 *   share, rate, index      → float32
 *   money                   → float32, unit "cad_millions"
 *   measure                 → float32, unit required (e.g. "km")
 */

export const BYTE_ORDER = 'le' as const;
export const MONEY_UNIT = 'cad_millions' as const;

export const INT_KINDS = ['count', 'id'] as const;
export const FLOAT_KINDS = ['share', 'rate', 'index'] as const;
export type ColumnKind = (typeof INT_KINDS)[number] | (typeof FLOAT_KINDS)[number] | 'money' | 'measure';

/** snake_case: lowercase words of letters/digits joined by single underscores. */
export const ColumnNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
  .meta({ id: 'ColumnName' });

const envelope = {
  byteOrder: z.literal(BYTE_ORDER).describe('Byte order of data; always little-endian'),
  length: z.int().nonnegative().describe('Element count, not byte count'),
  data: z.base64().describe('Base64 of the element bytes in byteOrder'),
  method: z
    .string()
    .optional()
    .describe('How the values were produced, e.g. "allocation_v1" for estimated GDP'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('0–1; present on any estimated column so the UI can label it'),
};

export const EncodedColumnSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.enum(INT_KINDS).describe('Counts and ids (including categorical codes) are int32'),
      dtype: z.literal('int32'),
      ...envelope,
    }),
    z.strictObject({
      kind: z.enum(FLOAT_KINDS).describe('Shares, rates and indices are float32'),
      dtype: z.literal('float32'),
      ...envelope,
    }),
    z.strictObject({
      kind: z.literal('money').describe('Money is float32 in millions of CAD'),
      dtype: z.literal('float32'),
      unit: z.literal(MONEY_UNIT),
      ...envelope,
    }),
    z.strictObject({
      kind: z.literal('measure').describe('Physical measures are float32 with an explicit unit'),
      dtype: z.literal('float32'),
      unit: z.string().regex(/^[a-z][a-z0-9_]*$/),
      ...envelope,
    }),
  ])
  .meta({ id: 'EncodedColumn' });

/** An int32 id column on its own, for places that only accept ids (assignments, side tables). */
export const IdColumnSchema = z
  .strictObject({ kind: z.literal('id'), dtype: z.literal('int32'), ...envelope })
  .meta({ id: 'IdColumn' });

export type EncodedColumn = z.infer<typeof EncodedColumnSchema>;
export type TypedColumn = Float32Array | Int32Array;

/** File-level metadata carried by every artefact that contains encoded columns. */
export const FileMetaSchema = z
  .object({ byteOrder: z.literal(BYTE_ORDER) })
  .catchall(z.union([z.string(), z.number(), z.boolean()]))
  .describe('byteOrder plus free-form provenance, e.g. gdp_method')
  .meta({ id: 'FileMeta' });

export interface ColumnSpec {
  kind: ColumnKind;
  unit?: string;
  method?: string;
  confidence?: number;
}

export function dtypeForKind(kind: ColumnKind): EncodedColumn['dtype'] {
  return (INT_KINDS as readonly string[]).includes(kind) ? 'int32' : 'float32';
}

export function encodeColumn(values: TypedColumn, spec: ColumnSpec): EncodedColumn {
  const dtype = dtypeForKind(spec.kind);
  if ((dtype === 'int32') !== values instanceof Int32Array) {
    throw new TypeError(`kind "${spec.kind}" must be ${dtype}, got ${values.constructor.name}`);
  }
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    if (dtype === 'int32') view.setInt32(i * 4, values[i], true);
    else view.setFloat32(i * 4, values[i], true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return EncodedColumnSchema.parse({
    ...spec,
    dtype,
    byteOrder: BYTE_ORDER,
    length: values.length,
    data: btoa(binary),
  });
}

export function decodeColumn(column: EncodedColumn): TypedColumn {
  if (column.byteOrder !== BYTE_ORDER) throw new Error(`unsupported byteOrder ${column.byteOrder}`);
  const binary = atob(column.data);
  if (binary.length !== column.length * 4) {
    throw new Error(`Column byte length ${binary.length} does not match ${column.length} × 4`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  if (column.dtype === 'float32') {
    const out = new Float32Array(column.length);
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
    return out;
  }
  const out = new Int32Array(column.length);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt32(i * 4, true);
  return out;
}

/** ISO 8601 calendar date. Years are four digits, so 1000-01-01 is valid. */
export const IsoDateSchema = z.iso.date().meta({ id: 'IsoDate' });
