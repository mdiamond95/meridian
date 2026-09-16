import { z } from 'zod';

/**
 * IndigenousFile — the pre-contact base: Indigenous language families by area, and community
 * labels (replaces the declined Native Land Digital layer; docs/decisions.md 2026-09-16).
 *
 * Families come from the `indigenous_language_family` attrs column, dissolved into one area per
 * family and source: census mother-tongue speakers where there are any (confidence 0.7), otherwise
 * the nearest Glottolog language by distance over the mesh (confidence 0.3). Community points are
 * from Wikidata. The geometry is in indigenous.v1.topojson.gz, keyed by `geometryRef`.
 *
 * The caveat is a literal here, not free text in the data: this layer is a modern and
 * linguistic reconstruction drawn under historical dates, and nothing downstream may soften what
 * it says. The pipeline copies it from the exported JSON Schema.
 */

export const INDIGENOUS_CAVEAT =
  'Derived from modern language distribution and linguistic records; not pre-contact boundaries.' as const;

export const FAMILY_SOURCES = ['census', 'glottolog'] as const;
export type FamilySource = (typeof FAMILY_SOURCES)[number];

export const COMMUNITY_PEOPLES = ['first_nation', 'inuit', 'metis'] as const;
export type CommunityPeople = (typeof COMMUNITY_PEOPLES)[number];

const GlottocodeSchema = z.string().regex(/^[a-z0-9]{4}\d{4}$/);

export const LanguageFamilySchema = z
  .strictObject({
    code: z.int().min(1).describe('Value in the attrs column indigenous_language_family (0 = unassigned)'),
    glottocode: GlottocodeSchema.describe('Top-level family or isolate in Glottolog'),
    glottologName: z.string().min(1),
    label: z.string().min(1).describe('Name shown on the map'),
  })
  .meta({ id: 'LanguageFamily' });

export const FamilyAreaSchema = z
  .strictObject({
    family: z.int().min(1).describe('LanguageFamily.code'),
    source: z.enum(FAMILY_SOURCES).describe('census speakers, or the nearest Glottolog language'),
    confidence: z.number().min(0).max(1),
    cells: z.int().min(1).describe('Mesh cells in this area'),
    geometryRef: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .describe('Key into indigenous.v1.topojson.gz'),
    labelPoint: z
      .tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
      .describe('[lng, lat] inside the largest part, for the family name on the map'),
  })
  .meta({ id: 'FamilyArea' });

export const CommunitySchema = z
  .strictObject({
    id: z.int().positive().describe('Wikidata item number (Q-id without the Q)'),
    name: z.string().min(1).describe('English label on Wikidata'),
    people: z.enum(COMMUNITY_PEOPLES),
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
  })
  .meta({ id: 'Community' });

export const AttributionSchema = z
  .strictObject({
    source: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .describe('Source id in docs/data-sources.md'),
    text: z.string().min(1),
    licence: z.string().min(1),
    url: z.url(),
  })
  .meta({ id: 'Attribution' });

export const IndigenousFileSchema = z
  .strictObject({
    format: z.literal('meridian.indigenous'),
    version: z.string().regex(/^v\d+$/),
    caveat: z.literal(INDIGENOUS_CAVEAT).describe('Shown with the layer; not optional in the UI'),
    families: z.array(LanguageFamilySchema).min(1),
    areas: z.array(FamilyAreaSchema),
    communities: z.array(CommunitySchema).describe('Sorted by id'),
    attribution: z.array(AttributionSchema).min(1),
  })
  .superRefine((file, ctx) => {
    const codes = new Set<number>();
    for (const family of file.families) {
      if (codes.has(family.code))
        ctx.addIssue({ code: 'custom', message: `duplicate family ${family.code}` });
      codes.add(family.code);
    }
    const refs = new Set<string>();
    for (const area of file.areas) {
      if (!codes.has(area.family)) {
        ctx.addIssue({
          code: 'custom',
          message: `area ${area.geometryRef} names unknown family ${area.family}`,
        });
      }
      if (refs.has(area.geometryRef)) {
        ctx.addIssue({ code: 'custom', message: `duplicate area geometryRef ${area.geometryRef}` });
      }
      refs.add(area.geometryRef);
    }
    for (let i = 1; i < file.communities.length; i++) {
      if (!(file.communities[i - 1].id < file.communities[i].id)) {
        ctx.addIssue({ code: 'custom', message: `communities not strictly sorted by id at ${i}` });
      }
    }
  })
  .meta({ id: 'IndigenousFile', title: 'Meridian IndigenousFile' });

export type IndigenousFile = z.infer<typeof IndigenousFileSchema>;
export type LanguageFamily = z.infer<typeof LanguageFamilySchema>;
export type FamilyArea = z.infer<typeof FamilyAreaSchema>;
export type Community = z.infer<typeof CommunitySchema>;
