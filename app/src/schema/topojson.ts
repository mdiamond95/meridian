import { z } from 'zod';

/**
 * TopoJSON Topology as written by mapshaper for data/build/layers/*.topojson and the atlas
 * geometry. Structural check only: the topojson spec allows much, and mapshaper owns the
 * details. Geometry objects are validated one level deep.
 */

const PositionSchema = z.array(z.number()).min(2).max(3);

export const TopoGeometrySchema = z
  .looseObject({
    type: z.enum([
      'Point',
      'MultiPoint',
      'LineString',
      'MultiLineString',
      'Polygon',
      'MultiPolygon',
      'GeometryCollection',
    ]),
    id: z.union([z.string(), z.number()]).optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    arcs: z.array(z.unknown()).optional(),
    coordinates: z.array(z.unknown()).optional(),
    geometries: z.array(z.unknown()).optional(),
  })
  .meta({ id: 'TopoGeometry' });

export const TopologySchema = z
  .looseObject({
    type: z.literal('Topology'),
    objects: z.record(z.string(), TopoGeometrySchema),
    arcs: z.array(z.array(PositionSchema)),
    transform: z
      .strictObject({
        scale: z.tuple([z.number(), z.number()]),
        translate: z.tuple([z.number(), z.number()]),
      })
      .optional(),
    bbox: z.array(z.number()).optional(),
  })
  .meta({ id: 'Topology', title: 'TopoJSON Topology' });

export type Topology = z.infer<typeof TopologySchema>;
