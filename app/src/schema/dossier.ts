import { z } from 'zod';

/**
 * RegionDossier and SetAnalysis (vision §6, plan Phase 4): what a generated region says about
 * itself, and what the set says about itself. Both are computed from the assignment, the mesh and
 * attrs, so a pack carries them and Phase 5 exports them.
 *
 * Written text is either measured or templated. A templated field carries `placeholder: true` and
 * its text opens with PLACEHOLDER_MARK, so nothing invented is mistaken for a written line.
 */

export const PLACEHOLDER_MARK = '⟨draft⟩';

/** GDP is an allocation, never a measurement; it travels with every GDP number. */
export const GDP_CAVEAT =
  'GDP is an estimate: provincial GDP by industry shared over cells by census labour force (allocation_v1), not a measurement of what a region produces.';

export const TextFieldSchema = z
  .strictObject({
    text: z.string().min(1),
    placeholder: z.boolean().describe('True while the text is templated and waiting to be rewritten'),
  })
  .meta({ id: 'DossierText' });

export const CitySchema = z.strictObject({ name: z.string().min(1), population: z.int().nonnegative() });

export const IndustryShareSchema = z.strictObject({
  code: z.string().min(1),
  label: z.string().min(1),
  share: z.number().min(0).max(1),
});

export const RegionDossierSchema = z
  .strictObject({
    name: z.string().min(1),
    nameSource: z.enum(['generated', 'manual']),
    /** why the generator chose that name, so a reader can argue with it */
    nameReason: z.string().min(1),
    capital: CitySchema.nullable(),
    mainCities: z.array(CitySchema),
    secondaryCities: z.array(CitySchema),
    population: z.int().nonnegative(),
    areaKm2: z.number().nonnegative(),
    densityPerKm2: z.number().nonnegative(),
    gdpCadMillions: z.number().nullable(),
    gdpCaveat: z.literal(GDP_CAVEAT),
    gdpPerCapita: z.number().nullable(),
    growth2016to2021: z.number().describe('Share, e.g. 0.052 for +5.2%'),
    primaryIndustries: z.array(IndustryShareSchema).max(3),
    dependencyScore: z.number().min(0).max(1).describe('Share of the labour force in the top industry'),
    urbanShare: z.number().min(0).max(1).describe('People in a CMA or CA'),
    internalColonyIndex: z.number().min(0).max(1),
    distanceToCapitalKmMean: z.number().nonnegative(),
    languages: z.strictObject({
      english: z.number().min(0).max(1),
      french: z.number().min(0).max(1),
      indigenous: z.number().min(0).max(1),
      other: z.number().min(0).max(1),
    }),
    indigenous: z.strictObject({
      identityShare: z.number().min(0).max(1),
      languageFamilies: z.array(
        z.strictObject({ label: z.string().min(1), share: z.number().min(0).max(1) }),
      ),
      majority: z.boolean().describe('Indigenous identity over half the population'),
    }),
    treatyComposition: z.array(z.strictObject({ label: z.string().min(1), share: z.number().min(0).max(1) })),
    governingParty: z.strictObject({
      party: z.string().min(1),
      share: z.number().min(0).max(1),
      hypothetical: z.literal(true),
    }),
    bordersInWords: z.array(z.string().min(1)).describe('Clockwise from the north-west'),
    characterLine: TextFieldSchema,
    rivalRegion: z
      .strictObject({ id: z.int().nonnegative(), name: z.string().min(1), similarity: z.number() })
      .nullable(),
    oneSentence: TextFieldSchema,
    whatWouldKillIt: TextFieldSchema,
    whatWouldSaveIt: TextFieldSchema,
  })
  .meta({ id: 'RegionDossier' });

export const FederalismFindingSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  title: z.string().min(1),
  citation: z.string().min(1),
  url: z.url(),
  verdict: z.enum(['breaks', 'strained', 'holds']),
  detail: z.string().min(1),
});

export const SetAnalysisSchema = z
  .strictObject({
    scope: z.string().min(1),
    regions: z.int().nonnegative(),
    powerRanking: z.array(
      z.strictObject({
        id: z.int().nonnegative(),
        name: z.string().min(1),
        economicLeverage: z.number().min(0).max(1).describe('Share of the set GDP estimate'),
        chokepoints: z.int().nonnegative().describe('Boundary crossings of major rivers and ridings'),
        resourceOwnership: z.number().min(0).max(1).describe('Share of the set extractive labour force'),
        score: z.number(),
        rank: z.int().positive(),
      }),
    ),
    ratios: z.strictObject({
      population: z.number().nullable(),
      area: z.number().nullable(),
      gdp: z.number().nullable(),
    }),
    metrosSplit: z.array(
      z.strictObject({
        cma: z.string().min(1),
        name: z.string().min(1),
        regions: z.array(z.int().nonnegative()),
      }),
    ),
    reconciliation: z.strictObject({
      population: z.strictObject({ regions: z.number(), scope: z.number(), difference: z.number() }),
      gdp: z.strictObject({ regions: z.number(), scope: z.number(), difference: z.number() }),
      ok: z.boolean(),
    }),
    contiguityLog: z.array(
      z.strictObject({
        id: z.int().nonnegative(),
        name: z.string().min(1),
        pieces: z.int().positive(),
        note: z.string().min(1),
      }),
    ),
    federalism: z.array(FederalismFindingSchema),
    gdpCaveat: z.literal(GDP_CAVEAT),
  })
  .meta({ id: 'SetAnalysis' });

export type RegionDossier = z.infer<typeof RegionDossierSchema>;
export type SetAnalysis = z.infer<typeof SetAnalysisSchema>;
export type FederalismFinding = z.infer<typeof FederalismFindingSchema>;
export type DossierText = z.infer<typeof TextFieldSchema>;
