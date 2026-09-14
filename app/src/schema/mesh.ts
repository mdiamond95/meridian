import { z } from 'zod';
import { EncodedColumnSchema, type TypedColumn } from './columns';

/**
 * MeshFile — the H3 base mesh every region is aggregated from (vision §2).
 *
 * Produced once by pipeline/mesh.py and pipeline/attrs.py; read-only in the app.
 * Invariants beyond the JSON Schema are enforced by `.superRefine` below.
 */

export const PROVINCE_CODES = [
  'NL',
  'PE',
  'NS',
  'NB',
  'QC',
  'ON',
  'MB',
  'SK',
  'AB',
  'BC',
  'YT',
  'NT',
  'NU',
] as const;
export type ProvinceCode = (typeof PROVINCE_CODES)[number];

export const MeshCellSchema = z
  .object({
    id: z
      .string()
      .regex(/^[0-9a-f]{15}$/)
      .describe('H3 cell index, lowercase hex'),
    centroid: z
      .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
      .describe('[lon, lat] in WGS84, GeoJSON axis order'),
    area: z.number().positive().describe('Cell area in km²'),
    province: z.enum(PROVINCE_CODES).describe('Province/territory by largest area overlap'),
    cd: z
      .string()
      .regex(/^\d{4}$/)
      .describe('StatCan census division CDUID'),
    csd: z
      .string()
      .regex(/^\d{7}$/)
      .describe('StatCan census subdivision CSDUID'),
    neighbours: z
      .array(z.int().nonnegative())
      .describe('Indices into cells[] of adjacent cells in the mesh, ascending'),
  })
  .meta({ id: 'MeshCell' });

export const MeshFileSchema = z
  .object({
    format: z.literal('meridian.mesh'),
    version: z
      .string()
      .regex(/^v\d+$/)
      .describe('Mesh version; matches the artefact filename, e.g. "v1" for mesh.v1.json.gz'),
    h3Resolution: z.int().min(0).max(15),
    cells: z.array(MeshCellSchema).describe('Sorted by id ascending; array index is the cell index'),
    columns: z
      .record(z.string().regex(/^[a-z][a-z0-9_]*$/), EncodedColumnSchema)
      .describe('Per-cell attribute columns, each of length cells.length'),
  })
  .superRefine((mesh, ctx) => {
    const n = mesh.cells.length;
    for (const [name, column] of Object.entries(mesh.columns)) {
      if (column.length !== n) {
        ctx.addIssue({
          code: 'custom',
          path: ['columns', name],
          message: `length ${column.length} ≠ ${n} cells`,
        });
      }
    }
    for (let i = 0; i < n; i++) {
      const cell = mesh.cells[i];
      if (i > 0 && mesh.cells[i - 1].id >= cell.id) {
        ctx.addIssue({ code: 'custom', path: ['cells', i, 'id'], message: 'cells not sorted by id' });
      }
      if (cell.neighbours.some((j) => j >= n || j === i)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cells', i, 'neighbours'],
          message: 'neighbour index out of range or self',
        });
      }
    }
  })
  .meta({ id: 'MeshFile', title: 'Meridian MeshFile' });

/** The file as it travels over the wire (columns base64-encoded). */
export type MeshFileWire = z.infer<typeof MeshFileSchema>;
export type MeshCell = z.infer<typeof MeshCellSchema>;

/** The file after decoding: columns are typed arrays indexed by cell index. */
export type MeshFile = Omit<MeshFileWire, 'columns'> & {
  columns: Record<string, TypedColumn>;
};
