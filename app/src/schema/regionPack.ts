import { z } from 'zod';
import { BYTE_ORDER, IdColumnSchema, IsoDateSchema } from './columns';
import { RegionDossierSchema, SetAnalysisSchema } from './dossier';
import { H3CellIdSchema, PROVINCE_CODES } from './mesh';
import { ScenarioSchema } from './scenario';

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
      kind: z.literal('atlasSovereign'),
      sovereign: z
        .string()
        .min(1)
        .describe('Every de jure atlas unit under this sovereign at meta.date, e.g. "Canada" in 1867'),
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
    byteOrder: z.literal(BYTE_ORDER).describe('Byte order of every encoded column in the pack'),
    edited: z
      .boolean()
      .optional()
      .describe(
        'True once cells were painted by hand; the pack can no longer be regenerated from seed + params',
      ),
    edits: z
      .array(
        z.strictObject({
          cell: H3CellIdSchema,
          from: z.int().min(-1),
          to: z.int().min(-1),
        }),
      )
      .optional()
      .describe('Manual edits in the order they were made'),
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional()
      .describe("The pack's id: a preset's slug, or a hash of the recipe and assignment"),
    parentPack: z
      .string()
      .optional()
      .describe("Nesting: the id of the pack whose region this pack splits (scope.kind 'region')"),
    parentRegionId: z.int().nonnegative().optional().describe("Nesting: that region's id in the parent pack"),
    scenario: ScenarioSchema.optional().describe(
      'The atlas scenario the split was made in, whole, so atlas scopes resolve the same way anywhere',
    ),
  })
  .meta({ id: 'RegionPackMeta' });

/**
 * Game-facing scores (plan Phase 6 §5), one object per region. Definitions in docs/interop.md; all
 * are measured from the 2021 mesh attributes, whatever the pack's atlas date.
 */
export const RegionScoreSchema = z
  .strictObject({
    population: z.number().nonnegative().describe('People, 2021 census'),
    gdp: z
      .number()
      .nonnegative()
      .describe('GDP allocated to the region, CAD millions (an allocation: see gdpCaveat)'),
    resource_index: z
      .number()
      .min(0)
      .max(1)
      .describe(
        'Share of the labour force in agriculture, forestry, fishing, hunting, mining, quarrying, oil and gas',
      ),
    cohesion: z.number().min(0).max(1).describe('1 − the population-weighted lens variance, scaled to 0–1'),
    exposure: z
      .number()
      .min(0)
      .max(1)
      .describe("The dependency score: the largest industry's labour-force share"),
  })
  .meta({ id: 'RegionScore' });

export const RegionSchema = z
  .object({
    id: z.int().nonnegative().describe('Value used for this region in assignment'),
    name: z.string(),
    capital: z.string().nullable(),
    stats: z
      .object({ score: RegionScoreSchema.optional() })
      .catchall(z.number())
      .describe('Numbers by name, plus the game-facing `score` object'),
    dossier: z
      .union([RegionDossierSchema, z.strictObject({})])
      .describe("The region's dossier, or {} before Phase 4 filled it"),
  })
  .meta({ id: 'Region' });

/** A pack, and the packs nested under its regions. */
export interface RegionPackTree {
  format: 'meridian.regionPack';
  version: 1;
  meta: z.infer<typeof RegionPackMetaSchema>;
  assignment: z.infer<typeof IdColumnSchema>;
  regions: z.infer<typeof RegionSchema>[];
  setAnalysis: z.infer<typeof SetAnalysisSchema> | Record<string, never>;
  children?: RegionPackTree[];
}

export const RegionPackSchema: z.ZodType<RegionPackTree> = z
  .object({
    format: z.literal('meridian.regionPack'),
    version: z.literal(1),
    meta: RegionPackMetaSchema,
    assignment: IdColumnSchema.describe(
      'int32, length = mesh cell count; region id per cell, -1 = outside scope',
    ),
    regions: z.array(RegionSchema),
    setAnalysis: z
      .union([SetAnalysisSchema, z.strictObject({})])
      .describe('The set analysis, or {} before Phase 4 filled it'),
    children: z
      .array(z.lazy(() => RegionPackSchema))
      .optional()
      .describe(
        "Nesting: packs splitting this pack's regions, each with meta.parentPack and meta.parentRegionId; a tree exports as its root",
      ),
  })
  .superRefine((pack, ctx) => {
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

export type RegionScore = z.infer<typeof RegionScoreSchema>;
export type RegionPackWire = RegionPackTree;
export type RegionPackMeta = z.infer<typeof RegionPackMetaSchema>;
export type Region = z.infer<typeof RegionSchema>;
export type Scope = z.infer<typeof ScopeSchema>;

/** The pack after decoding. Cell count must match the mesh named by meta.meshVersion. */
export type RegionPack = Omit<RegionPackWire, 'assignment'> & { assignment: Int32Array };
