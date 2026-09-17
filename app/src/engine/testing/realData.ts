// Loads the committed mesh and attrs artefacts for engine tests and benchmarks (Node only).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeColumn } from '../../schema/columns';
import type { EncodedColumn } from '../../schema/columns';
import { buildScopeGraph, meshArrays, scopeMask, type MeshArrays, type MeshLike } from '../graph';
import type { Scope } from '../../schema/regionPack';
import type { Columns } from '../solver';

const BUILD = new URL('../../../../data/build/', import.meta.url);

function readGz(name: string): unknown {
  return JSON.parse(gunzipSync(readFileSync(new URL(name, BUILD))).toString('utf8'));
}

export interface RealData {
  mesh: MeshArrays;
  provinces: string[];
  columns: Columns;
}

let cached: RealData | null = null;

export function realData(names = ['population', 'french_share', 'gdp_estimate']): RealData {
  if (cached) return cached;
  const meshDoc = readGz('mesh.v1.json.gz') as MeshLike;
  const attrs = readGz('attrs.v1.json.gz') as { columns: Record<string, EncodedColumn> };
  const columns: Columns = {};
  for (const name of names) columns[name] = decodeColumn(attrs.columns[name]);
  cached = { mesh: meshArrays(meshDoc), provinces: meshDoc.cells.map((c) => c.province), columns };
  return cached;
}

export function graphFor(data: RealData, scope: Scope) {
  return buildScopeGraph(data.mesh, scopeMask(data.mesh, scope, { provinces: data.provinces }));
}
