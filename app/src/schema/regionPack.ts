import { z } from 'zod';
import { EncodedColumnSchema, IsoDateSchema } from './columns';
import { PROVINCE_CODES } from './mesh';

/**
 * RegionPack v1 — a split of the mesh into regions, plus how it was made and what it
 * describes (vision §6–7). Shared with the cities atlas, Birdseye and the games, so
 * changes here follow the versioning rules in docs/decisions.md.
 *
 * Reproducible from meta.seed + meta.params + meta.meshVersion.
 */

export const SPLIT_METHODS = ['lens', 'balanced', 'seeded', 'random', 'template'] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];

export const ScopeSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('canada') }),
    z.object({ kind: z.literal('province'), province: z.enum(PROVINCE_CODES) }),
    z.object({
      kind: z.literal('atlasUnit'),
      unit: z.string().describe('AtlasUnit id, resolved at meta.date'),
    }),
    z.object({
      kind: z.literal('region'),
      pack: z.string().describe('Source pack URL or library id'),
      region: z.int().nonnegative(),
    }),
    z.object({
      kind: z.literal('polygon'),
      geometry: z
        .object({ type: z.enum(['Polygon', 'MultiPolygon']), coordinates: z.array(z.unknown()) })
        .describe('GeoJSON geometry in WGS84'),
    }),
  ])
  .meta({ id: 'Scope' });

export const RegionPackMetaSchema = z
  .object({
    seed: z.int().min(0).max(0xffffffff).describe('uint32 seed for mulberry32'),
    method: z.enum(SPLIT_METHODS),
    params: z.record(z.string(), z.unknown()).describe('Solver parameters; shape owned by the engine'),
    meshVersion: z.string().regex(/^v\d+$/),
    scope: ScopeSchema,
    date: IsoDateSchema.nullable().describe('Atlas date the split was made against; null = present day'),
  })
  .meta({ id: 'RegionPackMeta' });

export const RegionSchema = z
  .object({
    id: z.int().nonnegative().describe('Value used for this region in assignment'),
    name: z.string(),
    capital: z.string().nullable(),
    stats: z.record(z.string(), z.number()),
    dossier: z.record(z.string(), z.unknown()).describe('Filled in Phase 4'),
  })
  .meta({ id: 'Region' });

export const RegionPackSchema = z
  .object({
    format: z.literal('meridian.regionPack'),
    version: z.literal(1),
    meta: RegionPackMetaSchema,
    assignment: EncodedColumnSchema.describe(
      'int32, length = mesh cell count; region id per cell, -1 = outside scope',
    ),
    regions: z.array(RegionSchema),
    setAnalysis: z.record(z.string(), z.unknown()).describe('Filled in Phase 4'),
  })
  .superRefine((pack, ctx) => {
    if (pack.assignment.dtype !== 'int32') {
      ctx.addIssue({ code: 'custom', path: ['assignment', 'dtype'], message: 'assignment must be int32' });
    }
    const seen = new Set<number>();
    pack.regions.forEach((region, i) => {
      if (seen.has(region.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['regions', i, 'id'],
          message: `duplicate region id ${region.id}`,
        });
      }
      seen.add(region.id);
    });
  })
  .meta({ id: 'RegionPack', title: 'Meridian RegionPack v1' });

export type RegionPackWire = z.infer<typeof RegionPackSchema>;
export type RegionPackMeta = z.infer<typeof RegionPackMetaSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type Scope = z.infer<typeof ScopeSchema>;

/** The pack after decoding. Cell count must match the mesh named by meta.meshVersion. */
export type RegionPack = Omit<RegionPackWire, 'assignment'> & { assignment: Int32Array };
