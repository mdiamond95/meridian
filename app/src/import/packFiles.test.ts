import { describe, expect, it } from 'vitest';
import { choosePackFile, immutabilityViolations, packFileName, parsePackFile } from './packFiles';

/** Published packs are immutable: changes go to a new numbered file, and CI refuses edits in place. */

const pack = (regions: number) =>
  JSON.stringify({
    format: 'meridian.regionPack',
    version: 1,
    meta: { id: 'x' },
    regions: Array(regions).fill(0),
  });

describe('pack file names', () => {
  it('parses the first file and numbered regenerations', () => {
    expect(parsePackFile('acadie-2.v1.json')).toEqual({ slug: 'acadie-2', meshVersion: 'v1', n: 1 });
    expect(parsePackFile('acadie-2.v1.3.json')).toEqual({ slug: 'acadie-2', meshVersion: 'v1', n: 3 });
    expect(packFileName({ slug: 'acadie-2', meshVersion: 'v2', n: 2 })).toBe('acadie-2.v2.2.json');
  });

  it('is not fooled by the library listing or an explicit .1', () => {
    expect(parsePackFile('index.json')).toBeNull();
    expect(parsePackFile('acadie-2.v1.1.json')).toBeNull();
  });
});

describe('choosePackFile', () => {
  const files = new Map([
    ['acadie-2.v1.json', pack(2)],
    ['acadie-2.v1.2.json', pack(3)],
    ['alberta-15.v1.json', pack(15)],
  ]);

  it('starts a new slug at the plain name', () => {
    expect(choosePackFile(files, 'canada-14', 'v1', pack(14))).toBe('canada-14.v1.json');
  });

  it('keeps the latest file when the content is the same, whatever the formatting', () => {
    const reformatted = JSON.stringify(JSON.parse(pack(3)), null, 2);
    expect(choosePackFile(files, 'acadie-2', 'v1', reformatted)).toBe('acadie-2.v1.2.json');
  });

  it('writes a changed pack to the next number, never over the old file', () => {
    expect(choosePackFile(files, 'acadie-2', 'v1', pack(4))).toBe('acadie-2.v1.3.json');
    expect(choosePackFile(files, 'alberta-15', 'v1', pack(16))).toBe('alberta-15.v1.2.json');
  });

  it('starts again at the plain name on a new mesh', () => {
    expect(choosePackFile(files, 'acadie-2', 'v2', pack(2))).toBe('acadie-2.v2.json');
  });
});

describe('immutabilityViolations', () => {
  const released = new Map([
    ['index.json', '{"packs":[1]}'],
    ['acadie-2.v1.json', pack(2)],
    ['alberta-15.v1.json', pack(15)],
  ]);

  it('passes when released packs are untouched, new files are added and the index moves', () => {
    const now = new Map([
      ['index.json', '{"packs":[2]}'],
      ['acadie-2.v1.json', JSON.stringify(JSON.parse(pack(2)), null, 1)],
      ['acadie-2.v1.2.json', pack(3)],
      ['alberta-15.v1.json', pack(15)],
    ]);
    expect(immutabilityViolations(released, now)).toEqual([]);
  });

  it('fails on a released pack edited in place or deleted', () => {
    const now = new Map([
      ['index.json', '{"packs":[1]}'],
      ['alberta-15.v1.json', pack(16)],
    ]);
    expect(immutabilityViolations(released, now)).toEqual([
      { file: 'acadie-2.v1.json', problem: 'deleted' },
      { file: 'alberta-15.v1.json', problem: 'changed' },
    ]);
  });
});
