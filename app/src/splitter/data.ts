import { indexedDbCache, type DecodedCache } from '../data/decodedCache';
import { maybeGunzip } from '../data/loadMesh';
import { meshArrays, type MeshArrays } from '../engine/graph';
import type { Columns } from '../engine/solver';
import { decodeColumn, type EncodedColumn } from '../schema/columns';
import type { MeshCell } from '../schema/mesh';
import {
  PlacesFileSchema,
  SnapFileSchema,
  type Cma,
  type Place,
  type PlacesFile,
  type SnapFile,
} from '../schema/places';
import { TopologySchema, type Topology } from '../schema/topojson';
import { lensColumns } from './lenses';

/**
 * Everything the splitter needs, decoded once: the mesh as solver arrays plus the per-cell codes the
 * UI needs (id, province, CD, CSD), attrs and derived lens columns, the gazetteer, and the river snap
 * edges. Loaded the first time the Generate panel opens; the hex topology for drawing is separate.
 */
export interface SplitterData {
  meshVersion: string;
  arrays: MeshArrays;
  cellIds: string[];
  provinces: string[];
  cds: string[];
  csds: string[];
  columns: Columns;
  kinds: Record<string, string>;
  lookups: Record<string, Record<string, string>>;
  places: Place[];
  placeByCsd: Map<string, Place>;
  cmas: Cma[];
  /** mesh edge key (u * cellCount + v, u < v) → the river's name, '' when unnamed */
  riverEdges: Map<number, string>;
}

export interface MeshWire {
  version: string;
  cells: MeshCell[];
}

export interface AttrsWire {
  columns: Record<string, EncodedColumn>;
  lookups?: Record<string, Record<string, string>>;
}

export function splitterData(
  mesh: MeshWire,
  attrs: AttrsWire,
  places: PlacesFile,
  snap: SnapFile,
): SplitterData {
  const arrays = meshArrays(mesh);
  const provinces = mesh.cells.map((c) => c.province);
  const decoded: Columns = {};
  const kinds: Record<string, string> = {};
  for (const [name, column] of Object.entries(attrs.columns)) {
    decoded[name] = decodeColumn(column);
    kinds[name] = column.kind;
  }
  const lookups = attrs.lookups ?? {};
  const n = mesh.cells.length;
  const riverEdges = new Map<number, string>();
  const rivers = snap.layers.rivers;
  const pairs = rivers ? decodeColumn(rivers.pairs) : new Int32Array(0);
  const labels = rivers?.labels ?? [];
  const labelOf = rivers?.labelOf ? decodeColumn(rivers.labelOf) : null;
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const label = labelOf ? (labels[labelOf[i / 2]] ?? '') : '';
    riverEdges.set(pairs[i] * n + pairs[i + 1], label);
  }
  return {
    meshVersion: mesh.version,
    arrays,
    cellIds: mesh.cells.map((c) => c.id),
    provinces,
    cds: mesh.cells.map((c) => c.cd),
    csds: mesh.cells.map((c) => c.csd),
    columns: lensColumns({ columns: decoded, lookups, provinces, areas: arrays.areas }),
    kinds,
    lookups,
    places: places.places,
    placeByCsd: new Map(places.places.map((p) => [p.csd, p])),
    cmas: places.cmas,
    riverEdges,
  };
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return JSON.parse(new TextDecoder().decode(await maybeGunzip(await response.arrayBuffer())));
}

export interface SplitterUrls {
  mesh: string;
  attrs: string;
  places: string;
  snap: string;
}

/** Where the last load came from: the decoded cache, or the network. */
export type SplitterDataSource = 'cache' | 'network';

let defaultCache: DecodedCache<SplitterData> | null = null;
function sharedCache(): DecodedCache<SplitterData> | null {
  // Reading `indexedDB` itself throws where site data is blocked; the cache is then off.
  try {
    if (typeof indexedDB === 'undefined') return null;
  } catch {
    return null;
  }
  return (defaultCache ??= indexedDbCache<SplitterData>());
}

/**
 * The cache key is the four fingerprinted URLs: Vite puts a content hash in each, so a new mesh
 * version or attribute build is a new key and the old entry is never read.
 */
export const splitterCacheKey = (urls: SplitterUrls) =>
  ['splitter', urls.mesh, urls.attrs, urls.places, urls.snap].join('|');

export async function loadSplitterData(
  urls: SplitterUrls,
  fetchImpl: typeof fetch = fetch,
  cache: DecodedCache<SplitterData> | null = sharedCache(),
  /**
   * Whether to write the cache after decoding. IndexedDB serializes a put synchronously (about
   * 17 MB here, hundreds of milliseconds), so the page leaves the writing to the worker, which loads
   * the same data in parallel (release 1.0.1).
   */
  { write = true }: { write?: boolean } = {},
): Promise<{ data: SplitterData; source: SplitterDataSource }> {
  const key = splitterCacheKey(urls);
  const cached = await cache?.get(key);
  if (cached) return { data: cached, source: 'cache' };
  const data = await fetchSplitterData(urls, fetchImpl);
  // Written in the background: a refused write only means the next open decodes again.
  if (write) void cache?.put(key, data);
  return { data, source: 'network' };
}

async function fetchSplitterData(urls: SplitterUrls, fetchImpl: typeof fetch): Promise<SplitterData> {
  const [mesh, attrs, places, snap] = await Promise.all([
    fetchJson(urls.mesh, fetchImpl),
    fetchJson(urls.attrs, fetchImpl),
    fetchJson(urls.places, fetchImpl),
    fetchJson(urls.snap, fetchImpl),
  ]);
  // The mesh and attrs are validated by the pipeline and the Phase 1 loader tests; parsing 38k cells
  // with Zod on every open would cost seconds, so only the small new files are parsed here.
  return splitterData(
    mesh as MeshWire,
    attrs as AttrsWire,
    PlacesFileSchema.parse(places),
    SnapFileSchema.parse(snap),
  );
}

export async function loadCellTopology(url: string, fetchImpl: typeof fetch = fetch): Promise<Topology> {
  return TopologySchema.parse(await fetchJson(url, fetchImpl));
}
