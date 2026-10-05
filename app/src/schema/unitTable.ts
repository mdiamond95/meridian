import { z } from 'zod';
import { UNIT_STATUSES } from './atlas';
import { IsoDateSchema } from './columns';
import { PROVINCE_CODES } from './mesh';

/**
 * UnitTable v1 — one row per unit of a fixed external geography (1.0.3), for consumers whose unit is not
 * a Meridian region: House of Cards plays on the 343 federal ridings, and 128 of them are smaller than a
 * mesh cell. Built by pipeline/ridings.py from the same census and boundary sources as the cells, never
 * from the cells. Shared with other projects, so changes follow the versioning rules in docs/interop.md;
 * a published table is immutable (rule 7).
 */

export const UNIT_GDP_CAVEAT =
  'GDP is an estimate: provincial GDP by industry shared over ridings by census labour force (allocation_v1), not a measurement of what a riding produces.';

const share = () => z.number().min(0).max(1);

export const UnitScoreSchema = z
  .object({
    population: z.int().nonnegative().describe('People, 2021 census'),
    gdp: z
      .number()
      .nonnegative()
      .describe('GDP allocated to the unit, CAD millions (an allocation: see gdpCaveat)'),
    resource_index: share().describe(
      'Share of the labour force in agriculture, forestry, fishing, hunting, mining, quarrying, oil and gas',
    ),
    exposure: share().describe("The dependency score: the largest industry's labour-force share"),
  })
  .describe('The scores of docs/interop.md "Scores for games", without cohesion, which needs a split')
  .meta({ id: 'UnitScore' });

export const UnitSharesSchema = z
  .object({
    english: share().describe('Mother tongue English, multiple responses split equally'),
    french: share().describe('Mother tongue French, multiple responses split equally'),
    indigenous_language: share().describe('Mother tongue an Indigenous language'),
    other_language: share().describe('1 − english − french − indigenous_language'),
    indigenous_identity: share().describe('Indigenous identity, 25% sample'),
    immigrant: share().describe('Immigrants, 25% sample'),
  })
  .meta({ id: 'UnitShares' });

export const UnitPlaceSchema = z
  .object({
    csd: z
      .string()
      .regex(/^\d{7}$/)
      .describe('StatCan CSDUID, as in places.v1'),
    name: z.string().min(1),
    population: z.int().positive().describe('The whole CSD, 2021 census'),
  })
  .meta({ id: 'UnitPlace' });

export const UnitJurisdictionSchema = z
  .object({
    from: IsoDateSchema.describe('Inclusive: an atlas event date'),
    to: IsoDateSchema.nullable().describe('Exclusive: the next change; null means still in force'),
    unit: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .describe('The de jure atlas unit id'),
    name: z.string().min(1),
    status: z.enum(UNIT_STATUSES),
    sovereign: z.string().min(1),
    share: share().describe("Share of the unit's land inside the unit's drawing: the smallest over the span"),
    fallback: z
      .literal(true)
      .optional()
      .describe('Present when no unit overlaps the unit: the nearest unit, with share 0'),
  })
  .meta({ id: 'UnitJurisdiction' });

export const UnitRowSchema = z
  .object({
    id: z.int().positive().describe('The unit number: FED_NUM for fed_2023'),
    name: z.string().min(1),
    nameFr: z.string().min(1),
    province: z.enum(PROVINCE_CODES),
    population: z.int().nonnegative().describe('2021 census'),
    areaKm2: z.number().positive().describe('Land area: the boundary polygon clipped to the shoreline'),
    score: UnitScoreSchema,
    shares: UnitSharesSchema,
    urbanClass: z.int().min(0).describe('Key into lookups.urbanClass'),
    industryDominant: z.int().min(0).describe('Two-digit NAICS sector, key into lookups.industryDominant'),
    places: z
      .array(UnitPlaceSchema)
      .describe('Every places.v1 place whose point is in the unit, population descending'),
    neighbours: z.array(z.int().positive()).describe('Ids of units sharing a border, ascending'),
    jurisdictions: z
      .array(UnitJurisdictionSchema)
      .min(1)
      .describe('Contiguous spans from meta.jurisdictionsFrom to today'),
  })
  .meta({ id: 'UnitRow' });

export const UnitTableSchema = z
  .object({
    format: z.literal('meridian.unitTable'),
    version: z.literal(1),
    unit: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .describe('The geography, e.g. "fed_2023"; key on (unit, id)'),
    meta: z
      .object({
        unitName: z.string().min(1),
        censusYear: z.int(),
        gdpMethod: z.literal('allocation_v1'),
        gdpReferenceYear: z.string().regex(/^\d{4}$/),
        gdpPrices: z.string().min(1),
        atlasVersion: z.string().regex(/^v\d+$/),
        jurisdictionsFrom: IsoDateSchema,
        sources: z.array(
          z.object({
            source: z.string().min(1).describe('Source id in docs/data-sources.md'),
            text: z.string().min(1),
            licence: z.string().min(1),
            url: z.url(),
          }),
        ),
      })
      .meta({ id: 'UnitTableMeta' }),
    gdpCaveat: z.literal(UNIT_GDP_CAVEAT),
    lookups: z.object({
      urbanClass: z.record(z.string().regex(/^\d+$/), z.string().min(1)),
      industryDominant: z.record(z.string().regex(/^\d+$/), z.string().min(1)),
    }),
    rows: z.array(UnitRowSchema).describe('Sorted by id'),
  })
  .superRefine((table, ctx) => {
    const ids = new Set(table.rows.map((r) => r.id));
    const neighbours = new Map(table.rows.map((r) => [r.id, new Set(r.neighbours)]));
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    table.rows.forEach((row, i) => {
      const at = ['rows', i];
      if (i > 0 && table.rows[i - 1].id >= row.id) issue([...at, 'id'], 'rows not strictly sorted by id');
      if (!(String(row.urbanClass) in table.lookups.urbanClass))
        issue([...at, 'urbanClass'], 'not in lookups');
      if (!(String(row.industryDominant) in table.lookups.industryDominant)) {
        issue([...at, 'industryDominant'], 'not in lookups');
      }
      row.neighbours.forEach((n, j) => {
        if (j > 0 && row.neighbours[j - 1] >= n) issue([...at, 'neighbours'], 'not strictly ascending');
        if (n === row.id || !ids.has(n)) issue([...at, 'neighbours'], `${n} is itself or not a row`);
        else if (!neighbours.get(n)?.has(row.id))
          issue([...at, 'neighbours'], `${n} does not list ${row.id}`);
      });
      row.places.forEach((p, j) => {
        const prev = row.places[j - 1];
        if (
          prev &&
          (prev.population < p.population || (prev.population === p.population && prev.csd >= p.csd))
        ) {
          issue([...at, 'places', j], 'places not sorted by population descending, then csd');
        }
      });
      const spans = row.jurisdictions;
      if (spans[0].from !== table.meta.jurisdictionsFrom)
        issue([...at, 'jurisdictions', 0], 'must start at meta.jurisdictionsFrom');
      if (spans[spans.length - 1].to !== null)
        issue([...at, 'jurisdictions'], 'the last span must run on (to: null)');
      spans.forEach((s, j) => {
        if (s.to !== null && s.to <= s.from) issue([...at, 'jurisdictions', j, 'to'], 'must follow from');
        if (j > 0 && spans[j - 1].to !== s.from)
          issue([...at, 'jurisdictions', j, 'from'], 'spans not contiguous');
      });
    });
  })
  .meta({ id: 'UnitTable', title: 'Meridian UnitTable' });

export type UnitTable = z.infer<typeof UnitTableSchema>;
export type UnitRow = z.infer<typeof UnitRowSchema>;
export type UnitJurisdiction = z.infer<typeof UnitJurisdictionSchema>;
