import { z } from 'zod';
import { encodeColumn, decodeColumn } from '../schema/columns';
import type { RegionDossier, SetAnalysis } from '../schema/dossier';
import {
  RegionPackSchema,
  type RegionPack,
  type RegionPackWire,
  type RegionScore,
} from '../schema/regionPack';
import type { Scenario } from '../schema/scenario';
import type { NamedRegion, SplitSpec } from './split';
import { packId, parentOf } from './tree';

/**
 * Region packs (vision §7): build one from a split, decode one, list the shipped presets, and decide
 * how a pack made on another mesh version fits this one.
 *
 * meta.params holds the whole SplitSpec except what meta already carries (scope, seed, method, date),
 * so a pack is its own recipe.
 */

export interface Edit {
  cell: string;
  from: number;
  to: number;
}

type SpecParams = Omit<SplitSpec, 'scope' | 'seed' | 'method' | 'date'>;

export function specFromPack(pack: Pick<RegionPackWire, 'meta'>): SplitSpec {
  const { scope, seed, method, date, params } = pack.meta;
  return { ...(params as unknown as SpecParams), scope, seed, method, date };
}

export interface PackExtras {
  edits?: Edit[];
  /** one per region, in id order (Phase 4) */
  dossiers?: RegionDossier[];
  setAnalysis?: SetAnalysis;
  /** game-facing scores, one per region in id order (Phase 6) */
  scores?: RegionScore[];
  /** the pack's id; defaults to a hash of the recipe and the cells */
  id?: string;
  /** the atlas scenario the split was made in */
  scenario?: Scenario | null;
  /** a preset's premise, in prose (1.0.1) */
  premise?: string;
}

export function buildPack(
  spec: SplitSpec,
  assignment: Int32Array,
  regions: NamedRegion[],
  meshVersion: string,
  extras: PackExtras = {},
): RegionPackWire {
  const { edits = [], dossiers, setAnalysis, scores, scenario } = extras;
  const { scope, seed, method, date, ...params } = spec;
  const parent = parentOf(spec);
  return RegionPackSchema.parse({
    format: 'meridian.regionPack',
    version: 1,
    meta: {
      seed,
      method,
      params,
      meshVersion,
      scope,
      date,
      byteOrder: 'le',
      ...(edits.length ? { edited: true, edits } : {}),
      id: extras.id ?? packId(spec, assignment),
      ...(parent ? { parentPack: parent.id, parentRegionId: parent.regionId } : {}),
      ...(extras.premise ? { premise: extras.premise } : {}),
      ...(scenario ? { scenario } : {}),
    },
    assignment: encodeColumn(assignment, { kind: 'id' }),
    regions: regions.map((r) => ({
      id: r.id,
      name: dossiers?.[r.id]?.name ?? r.name,
      capital: r.capital,
      stats: {
        population: r.population,
        areaKm2: Math.round(r.areaKm2),
        ...(r.gdp !== null ? { gdpCadMillions: Math.round(r.gdp) } : {}),
        cells: r.cells,
        pieces: r.pieces,
        compactness: Math.round(r.compactness * 1000) / 1000,
        carved: r.carved ? 1 : 0,
        ...(scores?.[r.id] ? { score: scores[r.id] } : {}),
      },
      dossier: dossiers?.[r.id] ?? {},
    })),
    setAnalysis: setAnalysis ?? {},
  });
}

export function decodePack(json: unknown): RegionPack {
  const wire = RegionPackSchema.parse(json);
  return { ...wire, assignment: decodeColumn(wire.assignment) as Int32Array };
}

export const PackLibrarySchema = z.strictObject({
  format: z.literal('meridian.packLibrary'),
  packs: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9-]+$/),
      name: z.string().min(1),
      description: z.string().min(1),
      file: z
        .string()
        .regex(/^[a-z0-9-]+\.v\d+\.json$/)
        .describe('<id>.<meshVersion>.json, in the top-level packs/ folder'),
    }),
  ),
});
export type PackLibrary = z.infer<typeof PackLibrarySchema>;

export async function loadLibrary(base: string, fetchImpl: typeof fetch = fetch): Promise<PackLibrary> {
  const response = await fetchImpl(`${base}packs/index.json`);
  if (!response.ok) throw new Error(`pack library: HTTP ${response.status}`);
  return PackLibrarySchema.parse(await response.json());
}

export async function loadPack(
  base: string,
  file: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegionPack> {
  const response = await fetchImpl(`${base}packs/${file}`);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return decodePack(await response.json());
}

export type Fit =
  | { kind: 'exact' }
  | { kind: 'regenerate'; spec: SplitSpec; reason: string }
  | { kind: 'unfittable'; reason: string };

/**
 * How a pack fits the loaded mesh. Same mesh version: its assignment is used as it is. Another mesh
 * version: its cell indices mean nothing here, but an unedited pack is a recipe, so it is regenerated
 * from its seed and params. An edited pack cannot be: the edits were made to cells that may not exist.
 */
export function fitPack(pack: Pick<RegionPack, 'meta'>, meshVersion: string): Fit {
  if (pack.meta.meshVersion === meshVersion) return { kind: 'exact' };
  if (pack.meta.edited) {
    return {
      kind: 'unfittable',
      reason: `made on mesh ${pack.meta.meshVersion} and edited by hand, so it cannot be regenerated on ${meshVersion}`,
    };
  }
  return {
    kind: 'regenerate',
    spec: specFromPack(pack),
    reason: `made on mesh ${pack.meta.meshVersion}; regenerated from its seed and params on ${meshVersion}`,
  };
}
