import { z } from 'zod';

/**
 * Wire encoding for typed-array columns shared by every Meridian artefact.
 *
 * JSON cannot carry a Float32Array, so columns travel as base64 of the raw
 * little-endian bytes plus a dtype tag. Byte-exact encoding means the Python
 * pipeline and the app agree to the bit, which golden hashes depend on.
 */
export const DTYPES = ['float32', 'int32'] as const;
export type Dtype = (typeof DTYPES)[number];

export const EncodedColumnSchema = z
  .object({
    dtype: z.enum(DTYPES),
    length: z.int().nonnegative().describe('Element count, not byte count'),
    data: z.base64().describe('Base64 of little-endian element bytes'),
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
  })
  .meta({ id: 'EncodedColumn' });

export type EncodedColumn = z.infer<typeof EncodedColumnSchema>;
export type TypedColumn = Float32Array | Int32Array;

const isLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function toLittleEndianBytes(values: TypedColumn): Uint8Array {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  if (isLittleEndian) return bytes;
  const swapped = new Uint8Array(bytes);
  for (let i = 0; i < swapped.length; i += 4) {
    swapped[i] = bytes[i + 3];
    swapped[i + 1] = bytes[i + 2];
    swapped[i + 2] = bytes[i + 1];
    swapped[i + 3] = bytes[i];
  }
  return swapped;
}

export function encodeColumn(
  values: TypedColumn,
  extra: Pick<EncodedColumn, 'method' | 'confidence'> = {},
): EncodedColumn {
  const bytes = toLittleEndianBytes(values);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return {
    dtype: values instanceof Float32Array ? 'float32' : 'int32',
    length: values.length,
    data: btoa(binary),
    ...extra,
  };
}

export function decodeColumn(column: EncodedColumn): TypedColumn {
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
