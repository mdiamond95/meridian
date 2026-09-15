// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadMesh, maybeGunzip } from './loadMesh';

// 50 real cells around Edmonton, sliced from data/build by `make fixture`.
const FIXTURES: Record<string, string> = {
  '/mesh.v1.json.gz': new URL('./fixtures/mesh.fixture.v1.json.gz', import.meta.url).pathname,
  '/attrs.v1.json.gz': new URL('./fixtures/attrs.fixture.v1.json.gz', import.meta.url).pathname,
};

const fileFetch = (async (input: RequestInfo | URL) => {
  const path = FIXTURES[String(input)];
  if (!path) return new Response('not found', { status: 404 });
  return new Response(readFileSync(path));
}) as typeof fetch;

describe('loadMesh', () => {
  it('fetches, gunzips, validates and decodes the 50-cell fixture into typed arrays', async () => {
    const { mesh, attrs } = await loadMesh('/mesh.v1.json.gz', '/attrs.v1.json.gz', { fetch: fileFetch });

    expect(mesh.cells).toHaveLength(50);
    expect(mesh.h3Resolution).toBe(5);
    expect(mesh.meta.byteOrder).toBe('le');
    expect(attrs.cellCount).toBe(50);

    const population = attrs.columns.population;
    expect(population).toBeInstanceOf(Int32Array);
    expect(population).toHaveLength(50);
    expect(Array.from(population).reduce((a, b) => a + b, 0)).toBeGreaterThan(500_000); // Edmonton core

    const french = attrs.columns.french_share;
    expect(french).toBeInstanceOf(Float32Array);
    for (const value of french) expect(value).toBeGreaterThanOrEqual(0);

    for (const [i, cell] of mesh.cells.entries()) {
      expect(cell.province).toBe('AB');
      for (const j of cell.neighbours) expect(mesh.cells[j].neighbours).toContain(i);
    }
  });

  it('rejects attrs built for a different mesh', async () => {
    const mismatched = (async (input: RequestInfo | URL) => {
      const response = await fileFetch(input);
      if (!String(input).startsWith('/attrs')) return response;
      const text = new TextDecoder().decode(await maybeGunzip(await response.arrayBuffer()));
      return new Response(JSON.stringify({ ...JSON.parse(text), meshVersion: 'v2' }));
    }) as typeof fetch;
    await expect(loadMesh('/mesh.v1.json.gz', '/attrs.v1.json.gz', { fetch: mismatched })).rejects.toThrow(
      /mesh v2/,
    );
  });

  it('passes through bytes that are not gzip', async () => {
    const plain = new TextEncoder().encode('{"a":1}').buffer;
    expect(await maybeGunzip(plain)).toBe(plain);
  });
});
