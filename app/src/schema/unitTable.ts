import { z } from 'zod';
import { UNIT_STATUSES } from './atlas';
import { IsoDateSchema } from './columns';
import { PROVINCE_CODES } from './mesh';

/**
 * UnitTable v1 — one row per unit of a fixed geography, for consumers whose unit is not a Meridian
 * region. The `unit` names the geography and decides the row's shape:
 *  - "fed_2023" (1.0.3): the 343 federal ridings; 128 are smaller than a mesh cell, so
 *    pipeline/ridings.py builds them from the census and boundary sources, never from the cells.
 *  - "h3_r4" (1.0.4): H3 resolution-4 hexagons, coarser than the mesh, so pipeline/hexes.py aggregates
 *    the mesh cells, as a pack region does.
 * Shared with other projects, so changes follow the versioning rules in docs/interop.md; a published
 * table is immutable (rule 7).
 */

export const UNIT_GDP_CAVEAT =
  'GDP is an estimate: provincial GDP by industry shared over ridings by census labour force (allocation_v1), not a measurement of what a riding produces.';
export const HEX_GDP_CAVEAT =
  'GDP is an estimate: provincial GDP by industry shared over mesh cells by census labour force (allocation_v1), not a measurement of what a hexagon produces.';

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

export const HexPlaceSchema = UnitPlaceSchema.extend({
  csdType: z.string().min(1).describe("Statistics Canada's CSD type code, key into lookups.csdType"),
}).meta({ id: 'HexPlace' });

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

const jurisdictionsField = () =>
  z.array(UnitJurisdictionSchema).min(1).describe('Contiguous spans from meta.jurisdictionsFrom to today');

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
    jurisdictions: jurisdictionsField(),
  })
  .meta({ id: 'UnitRow' });

const H3_R4 = /^84[0-9a-f]{13}$/;

export const HexRowSchema = z
  .object({
    id: z.string().regex(H3_R4).describe('The H3 index of a resolution-4 cell, lower-case hex'),
    centroid: z
      .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
      .describe('[lng, lat], H3 centre'),
    province: z.enum(PROVINCE_CODES).describe('The province or territory holding most of its land'),
    cells: z.int().positive().describe('Mesh cells (resolution 5) whose parent it is'),
    population: z.int().nonnegative().describe('2021 census'),
    areaKm2: z
      .number()
      .nonnegative()
      .describe('Land area: the hexagon clipped to the shoreline; 0 for open water (Great Lakes)'),
    score: UnitScoreSchema,
    shares: UnitSharesSchema,
    urbanClass: z.int().min(0).describe('Key into lookups.urbanClass'),
    industryDominant: z.int().min(0).describe('Two-digit NAICS sector, 0 when nobody lives there'),
    ecozone: z.int().min(0).describe('Key into lookups.ecozone'),
    places: z
      .array(HexPlaceSchema)
      .describe('Every places.v1 place whose point is in the hexagon, population descending'),
    neighbours: z
      .array(
        z.object({
          id: z.string().regex(H3_R4),
          kind: z.enum(['land', 'water']).describe('land: some of the common edge is on land'),
        }),
      )
      .describe('Hexagons in the table sharing an edge, ascending by id'),
    jurisdictions: jurisdictionsField(),
  })
  .meta({ id: 'HexRow' });

const SourceSchema = z.object({
  source: z.string().min(1).describe('Source id in docs/data-sources.md'),
  text: z.string().min(1),
  licence: z.string().min(1),
  url: z.url(),
});
const metaFields = {
  unitName: z.string().min(1),
  censusYear: z.int(),
  gdpMethod: z.literal('allocation_v1'),
  gdpReferenceYear: z.string().regex(/^\d{4}$/),
  gdpPrices: z.string().min(1),
  atlasVersion: z.string().regex(/^v\d+$/),
  jurisdictionsFrom: IsoDateSchema,
  sources: z.array(SourceSchema),
};
const lookup = () => z.record(z.string().min(1), z.string().min(1));

export const RidingTableSchema = z
  .object({
    format: z.literal('meridian.unitTable'),
    version: z.literal(1),
    unit: z.literal('fed_2023').describe('Federal electoral districts, 2023 Representation Order'),
    meta: z.object(metaFields).meta({ id: 'UnitTableMeta' }),
    gdpCaveat: z.literal(UNIT_GDP_CAVEAT),
    lookups: z.object({
      urbanClass: z.record(z.string().regex(/^\d+$/), z.string().min(1)),
      industryDominant: z.record(z.string().regex(/^\d+$/), z.string().min(1)),
    }),
    rows: z.array(UnitRowSchema).describe('Sorted by id'),
  })
  .meta({ id: 'RidingTable' });

export const HexTableSchema = z
  .object({
    format: z.literal('meridian.unitTable'),
    version: z.literal(1),
    unit: z.literal('h3_r4').describe('H3 resolution-4 hexagons'),
    meta: z
      .object({
        ...metaFields,
        h3Resolution: z.literal(4),
        meshVersion: z.string().regex(/^v\d+$/),
        layer: z.string().min(1).describe('The repository path of the land-clipped TopoJSON layer'),
        landEdgeMetres: z.number().positive().describe('Land along a common edge that makes a land link'),
      })
      .meta({ id: 'HexTableMeta' }),
    gdpCaveat: z.literal(HEX_GDP_CAVEAT),
    lookups: z.object({
      urbanClass: lookup(),
      industryDominant: lookup(),
      ecozone: lookup(),
      csdType: lookup(),
    }),
    rows: z.array(HexRowSchema).describe('Sorted by id (H3 index order)'),
  })
  .meta({ id: 'HexTable' });

type Row = z.infer<typeof UnitRowSchema> | z.infer<typeof HexRowSchema>;
const neighbourId = (n: number | { id: string }) => (typeof n === 'object' ? n.id : n);

/** Invariants JSON Schema cannot state; pipeline/validate.py mirrors them. */
function checkRows(
  table: {
    rows: Row[];
    meta: { jurisdictionsFrom: string };
    lookups: Record<string, Record<string, string>>;
  },
  ctx: z.RefinementCtx,
) {
  const rows = table.rows;
  const ids = new Set<string | number>(rows.map((r) => r.id));
  const links = new Map<string | number, Map<string | number, unknown>>(
    rows.map((r) => [
      r.id,
      new Map((r.neighbours as (number | { id: string; kind: string })[]).map((n) => [neighbourId(n), n])),
    ]),
  );
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  rows.forEach((row, i) => {
    const at = ['rows', i];
    if (i > 0 && rows[i - 1].id >= row.id) issue([...at, 'id'], 'rows not strictly sorted by id');
    const keyed: [string, number | string][] = [
      ['urbanClass', row.urbanClass],
      ['industryDominant', row.industryDominant],
    ];
    if ('ecozone' in row) keyed.push(['ecozone', row.ecozone]);
    for (const [name, value] of keyed) {
      if (!(String(value) in table.lookups[name])) issue([...at, name], 'not in lookups');
    }
    const neighbours = row.neighbours as (number | { id: string; kind: string })[];
    neighbours.forEach((nb, j) => {
      const n = neighbourId(nb);
      if (j > 0 && neighbourId(neighbours[j - 1]) >= n)
        issue([...at, 'neighbours'], 'not strictly ascending');
      const back = links.get(n)?.get(row.id);
      if (n === row.id || !ids.has(n)) issue([...at, 'neighbours'], `${n} is itself or not a row`);
      else if (back === undefined) issue([...at, 'neighbours'], `${n} does not list ${row.id}`);
      else if (typeof nb === 'object' && (back as { kind: string }).kind !== nb.kind) {
        issue([...at, 'neighbours', j], `${n} lists ${row.id} with another kind`);
      }
    });
    row.places.forEach((p, j) => {
      const prev = row.places[j - 1];
      if (
        prev &&
        (prev.population < p.population || (prev.population === p.population && prev.csd >= p.csd))
      ) {
        issue([...at, 'places', j], 'places not sorted by population descending, then csd');
      }
      if ('csdType' in p && !(String(p.csdType) in table.lookups.csdType)) {
        issue([...at, 'places', j, 'csdType'], 'not in lookups');
      }
    });
    const spans = row.jurisdictions;
    if (spans[0].from !== table.meta.jurisdictionsFrom) {
      issue([...at, 'jurisdictions', 0], 'must start at meta.jurisdictionsFrom');
    }
    if (spans[spans.length - 1].to !== null)
      issue([...at, 'jurisdictions'], 'the last span must run on (to: null)');
    spans.forEach((s, j) => {
      if (s.to !== null && s.to <= s.from) issue([...at, 'jurisdictions', j, 'to'], 'must follow from');
      if (j > 0 && spans[j - 1].to !== s.from)
        issue([...at, 'jurisdictions', j, 'from'], 'spans not contiguous');
    });
  });
}

export const UnitTableSchema = z
  .discriminatedUnion('unit', [RidingTableSchema, HexTableSchema])
  .superRefine((table, ctx) => checkRows(table, ctx))
  .meta({ id: 'UnitTable', title: 'Meridian UnitTable' });

export type UnitTable = z.infer<typeof UnitTableSchema>;
export type UnitRow = z.infer<typeof UnitRowSchema>;
export type HexRow = z.infer<typeof HexRowSchema>;
export type RidingTable = z.infer<typeof RidingTableSchema>;
export type HexTable = z.infer<typeof HexTableSchema>;
export type UnitJurisdiction = z.infer<typeof UnitJurisdictionSchema>;
