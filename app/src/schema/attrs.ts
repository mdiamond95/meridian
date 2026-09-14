import { z } from 'zod';
import {
  ColumnNameSchema,
  EncodedColumnSchema,
  FileMetaSchema,
  IdColumnSchema,
  type TypedColumn,
} from './columns';

/**
 * AttrsFile — present-day per-cell attribute columns for one mesh version (vision §2, plan
 * Phase 1). Kept apart from the mesh so attributes can be rebuilt without touching geometry.
 * Every column is indexed by cell index in the MeshFile named by meshVersion.
 */

export const SideTableSchema = z
  .strictObject({
    offsets: IdColumnSchema.describe(
      'int32, length cellCount + 1; values for cell i are values[offsets[i]:offsets[i+1]]',
    ),
    values: IdColumnSchema,
  })
  .describe('Variable-length per-cell id lists in CSR form, e.g. Native Land territory ids')
  .meta({ id: 'SideTable' });

export const AttrsFileSchema = z
  .strictObject({
    format: z.literal('meridian.attrs'),
    version: z.string().regex(/^v\d+$/),
    meshVersion: z.string().regex(/^v\d+$/),
    cellCount: z.int().nonnegative(),
    meta: FileMetaSchema,
    columns: z.record(ColumnNameSchema, EncodedColumnSchema),
    lookups: z
      .record(ColumnNameSchema, z.record(z.string().regex(/^-?\d+$/), z.string()))
      .optional()
      .describe('Labels for id columns: column name → code → label'),
    sideTables: z.record(ColumnNameSchema, SideTableSchema).optional(),
  })
  .superRefine((attrs, ctx) => {
    for (const [name, column] of Object.entries(attrs.columns)) {
      if (column.length !== attrs.cellCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['columns', name],
          message: `length ${column.length} ≠ cellCount ${attrs.cellCount}`,
        });
      }
    }
    for (const name of Object.keys(attrs.lookups ?? {})) {
      if (attrs.columns[name]?.kind !== 'id') {
        ctx.addIssue({ code: 'custom', path: ['lookups', name], message: 'lookup must name an id column' });
      }
    }
    for (const [name, table] of Object.entries(attrs.sideTables ?? {})) {
      if (table.offsets.length !== attrs.cellCount + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['sideTables', name, 'offsets'],
          message: `offsets length must be cellCount + 1`,
        });
      }
    }
  })
  .meta({ id: 'AttrsFile', title: 'Meridian AttrsFile' });

export type AttrsFileWire = z.infer<typeof AttrsFileSchema>;

export type AttrsFile = Omit<AttrsFileWire, 'columns' | 'sideTables'> & {
  columns: Record<string, TypedColumn>;
  sideTables: Record<string, { offsets: Int32Array; values: Int32Array }>;
};
