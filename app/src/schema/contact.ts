import { z } from 'zod';

/**
 * ContactFile — the contact frontier: the earliest documented direct European presence, by area
 * (plan Phase 2 Sitting C).
 *
 * Produced from pipeline/atlas/contact.yaml, which is also where the reasoning lives. `caveat`
 * travels with the data because these years must not be read as a record of what happened first:
 * "first contact" is a European frame, and contact usually arrived before Europeans did.
 *
 * Bands are the drawn classes; `regions` is the provenance behind them, one entry per source.
 */

const YearSchema = z.int().min(-2000).max(2100);

export const ContactBandSchema = z
  .object({
    label: z.string().min(1).describe('Legend text, e.g. "1600–1699"'),
    fromYear: YearSchema.nullable().describe('Inclusive start, null for "everything earlier"'),
    untilYear: YearSchema.nullable().describe('Exclusive end, null for "everything later"'),
    geometryRef: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .describe('Key into contact.v1.topojson.gz'),
  })
  .meta({ id: 'ContactBand' });

export const ContactRegionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .describe('Stable id from contact.yaml'),
    name: z.string().min(1),
    year: YearSchema,
    event: z.string().min(1).describe('What fixes the year, in one sentence'),
    confidence: z.number().min(0).max(1).describe('How well the evidence supports the year'),
    source: z.string().min(1),
    note: z.string().optional().describe('Where the entry is weak, uncertain or contested'),
  })
  .meta({ id: 'ContactRegion' });

export const ContactFileSchema = z
  .object({
    format: z.literal('meridian.contact'),
    version: z.string().regex(/^v\d+$/),
    caveat: z.string().min(1).describe('Shown with the layer; not optional in the UI'),
    bands: z.array(ContactBandSchema).min(1),
    regions: z.array(ContactRegionSchema).min(1),
  })
  .meta({ id: 'ContactFile' })
  .superRefine((file, ctx) => {
    const refs = new Set<string>();
    for (const band of file.bands) {
      if (refs.has(band.geometryRef)) {
        ctx.addIssue({ code: 'custom', message: `duplicate band geometryRef ${band.geometryRef}` });
      }
      refs.add(band.geometryRef);
      if (band.fromYear !== null && band.untilYear !== null && band.fromYear >= band.untilYear) {
        ctx.addIssue({ code: 'custom', message: `band ${band.label} ends before it starts` });
      }
    }
  });

export type ContactFile = z.infer<typeof ContactFileSchema>;
export type ContactBand = z.infer<typeof ContactBandSchema>;
export type ContactRegion = z.infer<typeof ContactRegionSchema>;
