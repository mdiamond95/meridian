import type { MultiPolygon, Polygon } from 'geojson';
import { maybeGunzip } from '../data/loadMesh';
import { AtlasFileSchema, type AtlasFile } from '../schema/atlas';
import { TopologySchema, type Topology } from '../schema/topojson';
import { topologyDecoder } from './topology';

/**
 * Fetch the atlas event list (data/build/atlas.v1.json) and its geometry
 * (atlas.v1.topojson.gz), validate both, and decode every referenced polygon once.
 */

export interface LoadedAtlas {
  atlas: AtlasFile;
  /** geometryRef → GeoJSON geometry; shared by every unit row with that ref. */
  geometries: Map<string, Polygon | MultiPolygon>;
  /** The topology itself, so scenarios can merge drawings (src/scenario/apply.ts). */
  topology?: Topology;
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return JSON.parse(new TextDecoder().decode(await maybeGunzip(await response.arrayBuffer())));
}

export function decodeAtlas(atlas: AtlasFile, topology: Topology): LoadedAtlas {
  const decode = topologyDecoder(topology);
  const geometries = new Map<string, Polygon | MultiPolygon>();
  for (const { geometryRef } of [...atlas.units, ...(atlas.references ?? [])]) {
    if (!geometries.has(geometryRef)) geometries.set(geometryRef, decode(geometryRef));
  }
  return { atlas, geometries, topology };
}

export async function loadAtlas(
  atlasUrl: string,
  topologyUrl: string,
  { fetch: fetchImpl = fetch }: { fetch?: typeof fetch } = {},
): Promise<LoadedAtlas> {
  const [atlasJson, topologyJson] = await Promise.all([
    fetchJson(atlasUrl, fetchImpl),
    fetchJson(topologyUrl, fetchImpl),
  ]);
  return decodeAtlas(AtlasFileSchema.parse(atlasJson), TopologySchema.parse(topologyJson));
}
