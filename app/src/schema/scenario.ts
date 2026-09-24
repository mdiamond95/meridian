import { z } from 'zod';
import { AtlasRequirementSchema, UNIT_STATUSES } from './atlas';
import { IsoDateSchema } from './columns';

/**
 * Scenario — a counterfactual branch of the atlas (vision §8, plan Phase 6). A scenario is an overlay:
 * its events are merged into the base event list (on the same date, after the base events), and base
 * events whose `requires` it breaks are skipped with a notice. The source is YAML in docs/scenarios/;
 * `npm run scenarios` compiles it to src/scenario/scenarios.json, and a pack made in a scenario carries
 * the whole scenario in `meta.scenario`, so it can be replayed anywhere.
 */

const UnitIdSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

/**
 * Geometry for a scenario unit, built from the base atlas's own drawings: a base unit as it stood on a
 * date, or the union of several (shared borders dissolved), so a scenario never draws a line of its own.
 */
export type ScenarioGeometry = { unit: string; at: string } | { union: ScenarioGeometry[] };

export const ScenarioGeometrySchema: z.ZodType<ScenarioGeometry> = z.lazy(() =>
  z.union([
    z.strictObject({
      unit: UnitIdSchema.describe('A base atlas unit'),
      at: IsoDateSchema.describe('The date whose row of that unit is used'),
    }),
    z.strictObject({ union: z.array(ScenarioGeometrySchema).min(2) }),
  ]),
);

const RowFields = {
  name: z.string().min(1).optional(),
  status: z.enum(UNIT_STATUSES).optional(),
  sovereign: z.string().min(1).optional(),
  capital: z.string().nullable().optional(),
  geometry: ScenarioGeometrySchema.optional(),
  note: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  instrument: z.string().optional().describe('What the counterfactual rests on: the proposal, bill or vote'),
  rationale: z.string().optional(),
};

export const ScenarioChangeSchema = z
  .union([
    z.strictObject({ create: UnitIdSchema, ...RowFields }),
    z.strictObject({ alter: UnitIdSchema, ...RowFields }),
    z.strictObject({ rename: UnitIdSchema, name: z.string().min(1) }),
    z.strictObject({ dissolve: UnitIdSchema }),
  ])
  .meta({ id: 'ScenarioChange' });

export const ScenarioEventSchema = z
  .strictObject({
    date: IsoDateSchema,
    title: z.string().min(1),
    note: z.string().min(1),
    sources: z.array(z.string().min(1)).min(1).describe('Citations, as for base events'),
    requires: z.array(AtlasRequirementSchema).optional(),
    changes: z.array(ScenarioChangeSchema),
  })
  .meta({ id: 'ScenarioEvent' });

export const ScenarioSchema = z
  .strictObject({
    format: z.literal('meridian.scenario'),
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    fork: IsoDateSchema.describe(
      'Where the scenario leaves the base atlas; its first event is on or after it',
    ),
    premise: z.string().min(1).describe('One paragraph'),
    events: z.array(ScenarioEventSchema).min(1).describe('Sorted by date ascending'),
  })
  .superRefine((scenario, ctx) => {
    scenario.events.forEach((event, i) => {
      if (event.date < scenario.fork)
        ctx.addIssue({ code: 'custom', path: ['events', i, 'date'], message: 'event before the fork' });
      if (i > 0 && scenario.events[i - 1].date > event.date)
        ctx.addIssue({ code: 'custom', path: ['events', i, 'date'], message: 'events not sorted by date' });
      event.changes.forEach((change, j) => {
        if ('create' in change) {
          const missing = (['name', 'status', 'sovereign', 'geometry'] as const).filter(
            (k) => !(k in change),
          );
          if (missing.length)
            ctx.addIssue({
              code: 'custom',
              path: ['events', i, 'changes', j],
              message: `create needs ${missing.join(', ')}`,
            });
        }
      });
    });
  })
  .meta({ id: 'Scenario', title: 'Meridian Scenario' });

export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioEvent = z.infer<typeof ScenarioEventSchema>;
export type ScenarioChange = z.infer<typeof ScenarioChangeSchema>;
