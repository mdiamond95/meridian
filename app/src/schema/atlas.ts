import { z } from 'zod';
import { IsoDateSchema } from './columns';

/**
 * AtlasFile — the historical event list that resolves any date to a map (vision §5).
 *
 * Not a map per year: units carry a validity range, events explain the changes,
 * and geometry lives in a separate TopoJSON referenced by `geometryRef`.
 */

export const UNIT_STATUSES = [
  'colony',
  'province',
  'territory',
  'district',
  'hbc_charter',
  'unorganized',
  'foreign',
  'disputed',
] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export const TRUTH_LAYERS = ['dejure', 'defacto', 'disputed'] as const;
export type TruthLayer = (typeof TRUTH_LAYERS)[number];

const UnitIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .describe('Stable snake_case id, e.g. "ruperts_land"');

export const AtlasChangeSchema = z
  .object({
    unit: UnitIdSchema,
    kind: z.enum(['create', 'alter', 'rename', 'dissolve']),
  })
  .meta({ id: 'AtlasChange' });

export const AtlasEventSchema = z
  .object({
    date: IsoDateSchema.describe('The date the instrument took effect'),
    title: z.string().min(1),
    note: z.string().describe('Two plain sentences; an uncertain date names the alternative here'),
    dateConfidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Present when sources disagree on the effective date'),
    changes: z.array(AtlasChangeSchema),
  })
  .meta({ id: 'AtlasEvent' });

export const AtlasUnitSchema = z
  .object({
    id: UnitIdSchema.describe('Unique per (id, validFrom); a unit whose boundary changes gets a new row'),
    name: z.string().min(1),
    status: z.enum(UNIT_STATUSES),
    sovereign: z.string().min(1).describe('e.g. "Britain", "France", "HBC", "Canada"'),
    capital: z.string().nullable(),
    validFrom: IsoDateSchema.describe('Inclusive'),
    validTo: IsoDateSchema.nullable().describe('Exclusive; null means still valid'),
    truth: z.enum(TRUTH_LAYERS),
    dispute: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional()
      .describe('Groups the claim rows of one dispute, so the map can say whose claim a hatch is'),
    geometryRef: z.string().min(1).describe('Object key in the atlas TopoJSON; shared by unchanged units'),
    note: z.string().optional(),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Present on approximate polygons (de facto extents, pre-contact) and contested drawings'),
    instrument: z
      .string()
      .optional()
      .describe('The statute, order or treaty the boundary follows, with date and section'),
    rationale: z
      .string()
      .optional()
      .describe('Why the drawing departs from the reference map, in one sentence'),
  })
  .meta({ id: 'AtlasUnit' });

/**
 * Another map's drawing of the same area, shown for comparison where the atlas departs from it
 * (NRCan's Territorial Evolution maps). Not part of any truth layer.
 */
export const AtlasReferenceSchema = z
  .object({
    id: UnitIdSchema,
    name: z.string().min(1).describe('The polygon name on the reference map'),
    unit: UnitIdSchema.describe('The atlas unit whose drawing it contrasts with'),
    source: z.string().min(1).describe('Source id in docs/data-sources.md, e.g. "nrcan_te_1895"'),
    attribution: z.string().min(1),
    validFrom: IsoDateSchema,
    validTo: IsoDateSchema.nullable(),
    geometryRef: z.string().min(1),
    note: z.string().optional(),
  })
  .meta({ id: 'AtlasReference' });

export const AtlasFileSchema = z
  .object({
    format: z.literal('meridian.atlas'),
    version: z.string().regex(/^v\d+$/),
    events: z.array(AtlasEventSchema).describe('Sorted by date ascending'),
    units: z.array(AtlasUnitSchema),
    references: z.array(AtlasReferenceSchema).optional().describe('Comparison drawings; see AtlasReference'),
  })
  .superRefine((atlas, ctx) => {
    atlas.events.forEach((event, i) => {
      if (i > 0 && atlas.events[i - 1].date > event.date) {
        ctx.addIssue({ code: 'custom', path: ['events', i, 'date'], message: 'events not sorted by date' });
      }
    });
    atlas.units.forEach((unit, i) => {
      if (unit.validTo !== null && unit.validTo <= unit.validFrom) {
        ctx.addIssue({
          code: 'custom',
          path: ['units', i, 'validTo'],
          message: 'validTo must follow validFrom',
        });
      }
    });
    (atlas.references ?? []).forEach((ref, i) => {
      if (ref.validTo !== null && ref.validTo <= ref.validFrom) {
        ctx.addIssue({
          code: 'custom',
          path: ['references', i, 'validTo'],
          message: 'validTo must follow validFrom',
        });
      }
    });
  })
  .meta({ id: 'AtlasFile', title: 'Meridian AtlasFile' });

export type AtlasFile = z.infer<typeof AtlasFileSchema>;
export type AtlasEvent = z.infer<typeof AtlasEventSchema>;
export type AtlasUnit = z.infer<typeof AtlasUnitSchema>;
export type AtlasChange = z.infer<typeof AtlasChangeSchema>;
export type AtlasReference = z.infer<typeof AtlasReferenceSchema>;
