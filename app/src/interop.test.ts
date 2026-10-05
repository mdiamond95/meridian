// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRESETS } from './splitter/presets';

/**
 * docs/interop.md runs as written: the meridian.getScores helper on the committed House of Cards pack
 * returns the table the page prints, and the page's recipe is the preset's (plan Phase 6 §5); the
 * riding-table example (1.0.3) returns its 1867 table from the committed data/build/ridings.v1.json.gz.
 * Every raw URL the page gives is pinned to a release tag that has the file (consumer rule 1).
 */
const doc = readFileSync(new URL('../../docs/interop.md', import.meta.url), 'utf8');
const block = (name: string) => {
  const match = doc.match(new RegExp(`<!-- ${name}:start -->\\n([\\s\\S]*?)<!-- ${name}:end -->`));
  if (!match) throw new Error(`docs/interop.md has no ${name} block`);
  return match[1].replace(/^```\w*\n|```\n?$/gm, '').trim();
};

const ROOT = new URL('../../', import.meta.url);
// Raw URLs served from this checkout, as raw.githubusercontent.com serves them: plain bytes.
const fileFetch = (async (url: string) => {
  const path = String(url).match(/\/meridian\/[^/]+\/((?:packs|data\/build)\/.+)$/)?.[1];
  try {
    if (!path) throw new Error(url);
    return new Response(readFileSync(new URL(path, ROOT)));
  } catch {
    return new Response('not found', { status: 404 });
  }
}) as typeof fetch;

/** A markdown table block's body rows, cells trimmed. */
const tableRows = (name: string) =>
  block(name)
    .split('\n')
    .slice(2)
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );

interface Score {
  id: number;
  name: string;
  population: number;
  gdp: number;
  resource_index: number;
  cohesion: number;
  exposure: number;
}

interface Jurisdiction {
  from: string;
  to: string | null;
  name: string;
  sovereign: string;
}
interface UnitTable {
  format: string;
  version: number;
  unit: string;
  rows: { id: number; population: number; jurisdictions: Jurisdiction[] }[];
}
interface Helper {
  getScores(url: string): Promise<Score[]>;
  getUnitTable(url: string, unit: string): Promise<UnitTable>;
  jurisdictionOn(row: UnitTable['rows'][number], date: string): Jurisdiction | undefined;
}
const helper = new Function('fetch', `${block('getscores')}\nreturn meridian;`) as (
  f: typeof fetch,
) => Helper;

describe('docs/interop.md', () => {
  it('the House of Cards recipe is the dominion-1867-5 preset', () => {
    const preset = PRESETS.find((p) => p.id === 'dominion-1867-5');
    expect(preset).toBeDefined();
    expect(preset?.spec).toMatchObject(JSON.parse(block('hoc-recipe')));
  });

  it('meridian.getScores reads the pack and returns the table the page prints', async () => {
    const run = new Function(
      'meridian',
      `return (async () => {\n${block('hoc-fetch')}\nreturn scores;\n})();`,
    ) as (m: Helper) => Promise<Score[]>;
    const scores = await run(helper(fileFetch));
    expect(scores).toHaveLength(5);
    expect(tableRows('hoc-scores')).toEqual(
      scores.map((s) => [
        String(s.id),
        s.name,
        String(s.population),
        String(s.gdp),
        s.resource_index.toFixed(3),
        s.cohesion.toFixed(3),
        s.exposure.toFixed(3),
      ]),
    );
    for (const s of scores) {
      for (const key of ['resource_index', 'cohesion', 'exposure'] as const) {
        expect(s[key]).toBeGreaterThanOrEqual(0);
        expect(s[key]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the helper refuses what is not a region pack', async () => {
    const fake = (async () => new Response('{"format":"other"}')) as unknown as typeof fetch;
    await expect(helper(fake).getScores('x')).rejects.toThrow(/not a Meridian region pack/);
  });

  it('the helper refuses a version it does not read (consumer rule 4)', async () => {
    const v2 = (async () =>
      new Response('{"format":"meridian.regionPack","version":2}')) as unknown as typeof fetch;
    await expect(helper(v2).getScores('x')).rejects.toThrow(/version 2/);
  });

  it('the riding example reads the committed table and returns the 1867 table the page prints', async () => {
    interface Row {
      name: string;
      sovereign: string;
      ridings: number;
      population: number;
    }
    const run = new Function(
      'meridian',
      `return (async () => {\n${block('hoc-ridings')}\nreturn in1867;\n})();`,
    ) as (m: Helper) => Promise<Row[]>;
    const in1867 = await run(helper(fileFetch));
    expect(in1867.reduce((sum, r) => sum + r.ridings, 0)).toBe(343);
    expect(tableRows('hoc-ridings-1867')).toEqual(
      in1867.map((r) => [r.name, r.sovereign, String(r.ridings), r.population.toLocaleString('en-CA')]),
    );
  });

  it('getUnitTable refuses another format, version or unit (consumer rule 4)', async () => {
    const serve = (body: object) => {
      const bytes = new Blob([JSON.stringify(body)]).stream().pipeThrough(new CompressionStream('gzip'));
      return (async () => new Response(bytes)) as unknown as typeof fetch;
    };
    const table = { format: 'meridian.unitTable', version: 1, unit: 'fed_2023', rows: [] };
    await expect(helper(serve(table)).getUnitTable('x', 'fed_2023')).resolves.toMatchObject({
      unit: 'fed_2023',
    });
    await expect(helper(serve({ ...table, format: 'x' })).getUnitTable('x', 'fed_2023')).rejects.toThrow(
      /not a Meridian unit table/,
    );
    await expect(helper(serve({ ...table, version: 2 })).getUnitTable('x', 'fed_2023')).rejects.toThrow(
      /version 2/,
    );
    await expect(helper(serve(table)).getUnitTable('x', 'fed_2033')).rejects.toThrow(/not fed_2033/);
  });

  it('every raw URL is pinned to a release tag that has the files it fetches (consumer rule 1)', () => {
    // A tag not yet cut is allowed only for the release this commit is part of (the top CHANGELOG
    // entry), and then only for files in this checkout: the page can name the tag it ships in.
    const releasing = readFileSync(new URL('CHANGELOG.md', ROOT), 'utf8').match(/^## (v\d+\.\d+\.\d+)/m)?.[1];
    const tagged = (tag: string) => {
      try {
        execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };
    const bases = [
      ...doc.matchAll(
        /const BASE = '(https:\/\/raw\.githubusercontent\.com\/mdiamond95\/meridian\/([^/']+)\/)'/g,
      ),
    ];
    expect(bases.length).toBeGreaterThanOrEqual(2);
    for (const [, base, tag] of bases) {
      expect(tag, base).toMatch(/^v\d+\.\d+\.\d+$/);
      const after = doc.slice(doc.indexOf(base));
      const files = [
        ...after
          .slice(0, after.indexOf('```'))
          .matchAll(/BASE \+ [`'](packs\/[^`']+|data\/build\/[^`']+)[`']/g),
      ].map((m) => m[1].replace('${pack.meta.meshVersion}', 'v1'));
      expect(files.length, base).toBeGreaterThan(0);
      for (const file of files) {
        if (!tagged(tag)) {
          expect(tag, `${base}: no such tag, and not the release in progress`).toBe(releasing);
          expect(existsSync(new URL(file, ROOT)), file).toBe(true);
          continue;
        }
        expect(
          () => execFileSync('git', ['cat-file', '-e', `${tag}:${file}`], { stdio: 'ignore' }),
          `${tag}:${file}`,
        ).not.toThrow();
      }
    }
  });
});
