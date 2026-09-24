import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RegionPackWire } from '../schema/regionPack';
import { deleteSaved, getSaved, listSaved, savePack } from './library';

/** The pack library never throws: with IndexedDB missing or refusing, every call reports it. */

const pack = { meta: { meshVersion: 'v1' }, regions: [] } as unknown as RegionPackWire;

describe('pack library without storage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports unavailable when IndexedDB does not exist', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(listSaved()).resolves.toMatchObject({ ok: false });
    await expect(savePack('x', pack)).resolves.toMatchObject({ ok: false });
    await expect(getSaved('x')).resolves.toMatchObject({ ok: false });
    await expect(deleteSaved('x')).resolves.toMatchObject({ ok: false });
  });

  it('reports unavailable when opening throws (blocked site data)', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    const result = await listSaved();
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('The operation is insecure.'),
    });
  });
});
