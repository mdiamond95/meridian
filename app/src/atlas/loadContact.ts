import type { MultiPolygon, Polygon } from 'geojson';
import { maybeGunzip } from '../data/loadMesh';
import { ContactFileSchema, type ContactFile } from '../schema/contact';
import { TopologySchema, type Topology } from '../schema/topojson';
import { topologyDecoder } from './topology';

/**
 * Fetch the contact frontier (data/build/contact.v1.json and contact.v1.topojson.gz), validate
 * both, and decode each band's polygon once.
 *
 * Loaded only when the layer is switched on: it is another 200 kB or so, and most sessions never
 * look at it.
 */

export interface LoadedContact {
  contact: ContactFile;
  geometries: Map<string, Polygon | MultiPolygon>;
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return JSON.parse(new TextDecoder().decode(await maybeGunzip(await response.arrayBuffer())));
}

export function decodeContact(contact: ContactFile, topology: Topology): LoadedContact {
  const decode = topologyDecoder(topology);
  const geometries = new Map<string, Polygon | MultiPolygon>();
  for (const { geometryRef } of contact.bands) {
    if (!geometries.has(geometryRef)) geometries.set(geometryRef, decode(geometryRef));
  }
  return { contact, geometries };
}

export async function loadContact(
  contactUrl: string,
  topologyUrl: string,
  { fetch: fetchImpl = fetch }: { fetch?: typeof fetch } = {},
): Promise<LoadedContact> {
  const [contactJson, topologyJson] = await Promise.all([
    fetchJson(contactUrl, fetchImpl),
    fetchJson(topologyUrl, fetchImpl),
  ]);
  return decodeContact(ContactFileSchema.parse(contactJson), TopologySchema.parse(topologyJson));
}
