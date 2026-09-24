// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DecodedCache } from '../data/decodedCache';
import { loadSplitterData, splitterCacheKey, type SplitterData } from './data';

/** The decoded splitter data is cached by artefact fingerprint (plan Phase 7 §1). */

const root = new URL('../../../data/build/', import.meta.url);
const urls = {
  mesh: 'assets/mesh.v1.json-AAAA.gz',
  attrs: 'assets/attrs.v1.json-BBBB.gz',
  places: 'assets/places.v1.json-CCCC.gz',
  snap: 'assets/snap.v1.json-DDDD.gz',
};
const files: Record<string, string> = {
  [urls.mesh]: 'mesh.v1.json.gz',
  [urls.attrs]: 'attrs.v1.json.gz',
  [urls.places]: 'places.v1.json.gz',
  [urls.snap]: 'snap.v1.json.gz',
};

function counting() {
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    calls += 1;
    return new Response(readFileSync(new URL(files[url], root)));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

function memoryCache(): DecodedCache<SplitterData> & { entries: Map<string, SplitterData> } {
  const entries = new Map<string, SplitterData>();
  return {
    entries,
    get: async (key) => entries.get(key) ?? null,
    put: async (key, value) => {
      entries.clear();
      entries.set(key, structuredClone(value));
      return true;
    },
  };
}

describe('splitter data cache', () => {
  it('decodes from the network once, then reads the same data from the cache', async () => {
    const cache = memoryCache();
    const net = counting();
    const first = await loadSplitterData(urls, net.fetchImpl, cache);
    expect(first.source).toBe('network');
    expect(net.calls()).toBe(4);
    await Promise.resolve();
    expect([...cache.entries.keys()]).toEqual([splitterCacheKey(urls)]);

    const second = await loadSplitterData(urls, net.fetchImpl, cache);
    expect(second.source).toBe('cache');
    expect(net.calls()).toBe(4);
    // Structured clone keeps typed arrays and Maps: the cached copy is the decoded data, not JSON.
    expect(second.data.columns.population).toBeInstanceOf(first.data.columns.population.constructor);
    expect(second.data.columns.population).toEqual(first.data.columns.population);
    expect(second.data.arrays.offsets).toEqual(first.data.arrays.offsets);
    expect(second.data.riverEdges).toEqual(first.data.riverEdges);
    expect(second.data.placeByCsd.size).toBe(first.data.placeByCsd.size);
  }, 60_000);

  it('misses when any artefact changes (a new build or mesh version)', async () => {
    const cache = memoryCache();
    const net = counting();
    await loadSplitterData(urls, net.fetchImpl, cache);
    const rebuilt = { ...urls, attrs: 'assets/attrs.v1.json-EEEE.gz' };
    files[rebuilt.attrs] = 'attrs.v1.json.gz';
    const again = await loadSplitterData(rebuilt, net.fetchImpl, cache);
    expect(again.source).toBe('network');
    await Promise.resolve();
    expect([...cache.entries.keys()]).toEqual([splitterCacheKey(rebuilt)]);
  }, 60_000);

  it('loads from the network when the cache refuses', async () => {
    const broken: DecodedCache<SplitterData> = { get: async () => null, put: async () => false };
    const { data, source } = await loadSplitterData(urls, counting().fetchImpl, broken);
    expect(source).toBe('network');
    expect(data.cellIds.length).toBeGreaterThan(30_000);
  }, 60_000);

  it('loads from the network when reading indexedDB itself throws (blocked site data)', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      const { source } = await loadSplitterData(urls, counting().fetchImpl);
      expect(source).toBe('network');
    } finally {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
  }, 60_000);
});
