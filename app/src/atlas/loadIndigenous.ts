import type { MultiPolygon, Polygon } from 'geojson';
import { maybeGunzip } from '../data/loadMesh';
import { IndigenousFileSchema, type IndigenousFile } from '../schema/indigenous';
import { TopologySchema, type Topology } from '../schema/topojson';
import { topologyDecoder } from './topology';

/**
 * Fetch the pre-contact base (data/build/indigenous.v1.json and indigenous.v1.topojson.gz),
 * validate both, and decode each family area's polygon once.
 *
 * Loaded the first time a family or community layer is shown: before the atlas begins, or when
 * switched on from the Indigenous group of the layers menu.
 */

export interface LoadedIndigenous {
  indigenous: IndigenousFile;
  geometries: Map<string, Polygon | MultiPolygon>;
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return JSON.parse(new TextDecoder().decode(await maybeGunzip(await response.arrayBuffer())));
}

export function decodeIndigenous(indigenous: IndigenousFile, topology: Topology): LoadedIndigenous {
  const decode = topologyDecoder(topology);
  const geometries = new Map<string, Polygon | MultiPolygon>();
  for (const { geometryRef } of indigenous.areas) {
    if (!geometries.has(geometryRef)) geometries.set(geometryRef, decode(geometryRef));
  }
  return { indigenous, geometries };
}

export async function loadIndigenous(
  url: string,
  topologyUrl: string,
  { fetch: fetchImpl = fetch }: { fetch?: typeof fetch } = {},
): Promise<LoadedIndigenous> {
  const [json, topologyJson] = await Promise.all([
    fetchJson(url, fetchImpl),
    fetchJson(topologyUrl, fetchImpl),
  ]);
  return decodeIndigenous(IndigenousFileSchema.parse(json), TopologySchema.parse(topologyJson));
}

/**
 * Which Indigenous layers are drawn. Before the atlas begins they are the pre-contact base and are
 * always drawn; at any later date each is drawn when switched on.
 */
export function indigenousShown(
  toggles: { familiesVisible: boolean; communitiesVisible: boolean },
  beforeAtlas: boolean,
): { families: boolean; communities: boolean } {
  return {
    families: beforeAtlas || toggles.familiesVisible,
    communities: beforeAtlas || toggles.communitiesVisible,
  };
}

/** Areas smaller than this get no name on the map unless they are their family's largest. */
export const LABEL_MIN_CELLS = 25;

/**
 * The areas whose family name is drawn: every area of at least LABEL_MIN_CELLS cells, and the
 * largest area of each family whatever its size, so every family drawn is named at least once.
 * Census areas are often a scatter of single cells in towns; naming each one buries the map.
 */
export function labelledAreas<T extends { family: number; cells: number; geometryRef: string }>(
  areas: T[],
): T[] {
  const largest = new Map<number, T>();
  for (const area of areas) {
    const best = largest.get(area.family);
    if (!best || area.cells > best.cells) largest.set(area.family, area);
  }
  const keep = new Set([...largest.values()].map((a) => a.geometryRef));
  return areas.filter((a) => a.cells >= LABEL_MIN_CELLS || keep.has(a.geometryRef));
}

/** Short credit for the map's attribution control; the full strings ship in the file. */
export const INDIGENOUS_ATTRIBUTION =
  'Language families: <a href="https://glottolog.org">Glottolog 5.3</a> (CC BY 4.0) and Statistics Canada 2021 Census';
export const COMMUNITY_ATTRIBUTION = 'Communities: <a href="https://www.wikidata.org">Wikidata</a> (CC0)';
