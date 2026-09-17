// Runs in the browser under test: loads the committed mesh and attrs from the test's routes, runs
// each determinism case with the engine, and returns the assignment bytes.
import type { EncodedColumn } from '../../src/schema/columns';
import { decodeColumn } from '../../src/schema/columns';
import { maybeGunzip } from '../../src/data/loadMesh';
import { buildScopeGraph, meshArrays, scopeMask, type MeshLike } from '../../src/engine/graph';
import { solve } from '../../src/engine/solver';
import { DETERMINISM_CASES } from '../../src/engine/testing/determinismCases';

async function json(url: string): Promise<unknown> {
  const response = await fetch(url);
  return JSON.parse(new TextDecoder().decode(await maybeGunzip(await response.arrayBuffer())));
}

async function run() {
  const mesh = (await json('/data/mesh.v1.json.gz')) as MeshLike;
  const attrs = (await json('/data/attrs.v1.json.gz')) as { columns: Record<string, EncodedColumn> };
  const arrays = meshArrays(mesh);
  const provinces = mesh.cells.map((c) => c.province);
  const columns = { population: decodeColumn(attrs.columns.population) };
  const out: Record<string, number[]> = {};
  for (const c of DETERMINISM_CASES) {
    const graph = buildScopeGraph(arrays, scopeMask(arrays, c.scope, { provinces }));
    const result = solve({ mesh: arrays, graph, columns, params: c.params, seed: c.seed });
    if (result.stoppedBy === 'time') throw new Error(`${c.label} hit the wall-time cap`);
    out[c.label] = Array.from(result.assignment);
  }
  return out;
}

(window as unknown as { determinism: () => Promise<Record<string, number[]>> }).determinism = run;
