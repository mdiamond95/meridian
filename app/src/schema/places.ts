import { z } from 'zod';
import { IdColumnSchema } from './columns';

/**
 * PlacesFile — the splitter's gazetteer (plan Phase 3, Sitting B): every populated census
 * subdivision with a point and its mesh cell, for keep-together and keep-apart pins; and every CMA
 * with its mesh cells, for carve-CMA-first. Built by pipeline/splitter_inputs.py.
 */

export const PlaceSchema = z
  .strictObject({
    csd: z
      .string()
      .regex(/^\d{7}$/)
      .describe('StatCan CSDUID'),
    name: z.string().min(1),
    province: z
      .string()
      .regex(/^\d{2}$/)
      .describe('StatCan PRUID'),
    population: z.int().positive().describe('2021 Census'),
    lng: z.number().min(-180).max(180),
    lat: z.number().min(-90).max(90),
    cell: z.int().nonnegative().describe('Mesh cell index holding the representative point (or nearest)'),
  })
  .meta({ id: 'Place' });

export const CmaSchema = z
  .strictObject({
    cma: z
      .string()
      .regex(/^\d{3}$/)
      .describe('StatCan CMAUID'),
    name: z.string().min(1),
    population: z.int().nonnegative().describe('Sum of the attrs population of its cells'),
    cells: z
      .array(z.int().nonnegative())
      .min(1)
      .describe('Mesh cells whose centre lies in the CMA, ascending'),
  })
  .meta({ id: 'Cma' });

export const PlacesFileSchema = z
  .strictObject({
    format: z.literal('meridian.places'),
    version: z.string().regex(/^v\d+$/),
    meshVersion: z.string().regex(/^v\d+$/),
    places: z.array(PlaceSchema).describe('Sorted by csd'),
    cmas: z.array(CmaSchema).describe('Sorted by cma'),
  })
  .meta({ id: 'PlacesFile', title: 'Meridian PlacesFile' });

export type PlacesFile = z.infer<typeof PlacesFileSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type Cma = z.infer<typeof CmaSchema>;

/** SnapFile — snap layers that are lines, as mesh edges (pairs of cell indices, u < v). */
export const SnapFileSchema = z
  .strictObject({
    format: z.literal('meridian.snap'),
    version: z.string().regex(/^v\d+$/),
    meshVersion: z.string().regex(/^v\d+$/),
    layers: z.record(
      z.string().regex(/^[a-z][a-z0-9_]*$/),
      z.strictObject({
        description: z.string().min(1),
        pairs: IdColumnSchema.describe('int32 [u0, v0, u1, v1, ...], mesh cell indices, u < v'),
      }),
    ),
  })
  .meta({ id: 'SnapFile', title: 'Meridian SnapFile' });

export type SnapFile = z.infer<typeof SnapFileSchema>;
