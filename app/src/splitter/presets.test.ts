// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeColumn } from '../schema/columns';
import {
  buildPack,
  decodePack,
  fitPack,
  loadLibrary,
  loadPack,
  PackLibrarySchema,
  specFromPack,
} from './pack';
import { PRESETS } from './presets';
import { runSplit } from './split';
import { realSplitterData } from './testing/realSplitterData';
import { decodeHash, encodeHash } from './url';

/**
 * The shipped presets are the test cases for the pack loader, the library, share links and re-fit
 * (plan Phase 3 Sitting B §6, amended). Regenerate with `npm run presets` and say why in the commit.
 */

const PACKS = new URL('../../public/packs/', import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(new URL(file, PACKS), 'utf8')) as unknown;
const fileFetch = (async (input: RequestInfo | URL) => {
  const name = String(input).split('/packs/')[1];
  try {
    return new Response(readFileSync(new URL(name, PACKS)));
  } catch {
    return new Response('not found', { status: 404 });
  }
}) as typeof fetch;

describe('shipped presets', () => {
  const data = realSplitterData();

  it('the library lists every preset and every listed pack loads and validates', async () => {
    const library = await loadLibrary('/meridian/', fileFetch);
    expect(PackLibrarySchema.parse(read('index.json'))).toEqual(library);
    expect(library.packs.map((p) => p.id)).toEqual(PRESETS.map((p) => p.id));
    for (const entry of library.packs) {
      const pack = await loadPack('/meridian/', entry.file, fileFetch);
      expect(pack.assignment).toHaveLength(data.cellIds.length);
      expect(pack.meta.meshVersion).toBe(data.meshVersion);
      expect(pack.meta.edited).toBeUndefined();
      expect(pack.regions.every((r) => r.name && r.stats.pieces === 1)).toBe(true);
    }
    await expect(loadPack('/meridian/', 'missing.json', fileFetch)).rejects.toThrow(/404/);
  });

  it.each(PRESETS.map((p) => [p.id, p] as const))(
    '%s regenerates from its recorded seed and params',
    (id, preset) => {
      const pack = decodePack(read(`${id}.json`));
      // The recipe in the pack is the preset's spec, and running it gives the committed assignment.
      expect(specFromPack(pack)).toEqual(JSON.parse(JSON.stringify(preset.spec)));
      const { finished } = runSplit(specFromPack(pack), data);
      expect(finished.assignment).toEqual(pack.assignment);
      expect(buildPack(preset.spec, finished.assignment, finished.regions, data.meshVersion)).toEqual(
        read(`${id}.json`),
      );
    },
    60_000,
  );

  it('re-fits across mesh versions: exact on this mesh, regenerated from another, refused when edited', () => {
    const pack = decodePack(read('alberta-15.json'));
    expect(fitPack(pack, data.meshVersion)).toEqual({ kind: 'exact' });

    const older = { ...pack, meta: { ...pack.meta, meshVersion: 'v0' } };
    const fit = fitPack(older, data.meshVersion);
    expect(fit.kind).toBe('regenerate');
    if (fit.kind === 'regenerate') {
      expect(runSplit(fit.spec, data).finished.assignment).toEqual(pack.assignment);
    }

    const edited = {
      ...older,
      meta: { ...older.meta, edited: true, edits: [{ cell: data.cellIds[0], from: 0, to: 1 }] },
    };
    expect(fitPack(edited, data.meshVersion).kind).toBe('unfittable');
  }, 60_000);

  it('share links carry a spec or a pack id through the hash', () => {
    for (const preset of PRESETS) {
      const hash = encodeHash({ kind: 'split', spec: preset.spec });
      expect(hash).toMatch(/^#split=[A-Za-z0-9_-]+$/);
      expect(decodeHash(hash)).toEqual({ kind: 'split', spec: JSON.parse(JSON.stringify(preset.spec)) });
      expect(decodeHash(encodeHash({ kind: 'pack', id: preset.id }))).toEqual({
        kind: 'pack',
        id: preset.id,
      });
    }
    expect(decodeHash('#split=not-json')).toEqual({ kind: 'none' });
    expect(decodeHash('#pack=../etc')).toEqual({ kind: 'none' });
    expect(decodeHash('')).toEqual({ kind: 'none' });
  });

  it('packs record edits and the edited flag', () => {
    const pack = decodePack(read('canada-14.json'));
    const spec = specFromPack(pack);
    const { finished } = runSplit(spec, data);
    const assignment = Int32Array.from(finished.assignment);
    const cell = assignment.findIndex((r) => r === 0);
    assignment[cell] = 1;
    const edited = buildPack(spec, assignment, finished.regions, data.meshVersion, [
      { cell: data.cellIds[cell], from: 0, to: 1 },
    ]);
    expect(edited.meta.edited).toBe(true);
    expect(decodeColumn(edited.assignment)[cell]).toBe(1);
  }, 60_000);
});
