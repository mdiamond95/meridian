// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PRESETS } from './splitter/presets';

/**
 * docs/interop.md runs as written: the meridian.getScores helper on the committed House of Cards pack
 * returns the table the page prints, and the page's recipe is the preset's (plan Phase 6 §5).
 */
const doc = readFileSync(new URL('../../docs/interop.md', import.meta.url), 'utf8');
const block = (name: string) => {
  const match = doc.match(new RegExp(`<!-- ${name}:start -->\\n([\\s\\S]*?)<!-- ${name}:end -->`));
  if (!match) throw new Error(`docs/interop.md has no ${name} block`);
  return match[1].replace(/^```\w*\n|```\n?$/gm, '').trim();
};

const PACKS = new URL('../../packs/', import.meta.url);
const fileFetch = (async (url: string) => {
  const name = String(url).split('/packs/')[1];
  try {
    return new Response(readFileSync(new URL(name, PACKS)));
  } catch {
    return new Response('not found', { status: 404 });
  }
}) as typeof fetch;

interface Score {
  id: number;
  name: string;
  population: number;
  gdp: number;
  resource_index: number;
  cohesion: number;
  exposure: number;
}

const helper = new Function('fetch', `${block('getscores')}\nreturn meridian;`) as (f: typeof fetch) => {
  getScores(url: string): Promise<Score[]>;
};

describe('docs/interop.md', () => {
  it('the House of Cards recipe is the dominion-1867-5 preset', () => {
    const preset = PRESETS.find((p) => p.id === 'dominion-1867-5');
    expect(preset).toBeDefined();
    expect(preset?.spec).toMatchObject(JSON.parse(block('hoc-recipe')));
  });

  it('meridian.getScores reads the pack and returns the table the page prints', async () => {
    const BASE = 'https://raw.githubusercontent.com/mdiamond95/meridian/v0.6-scenarios/';
    const scores = await helper(fileFetch).getScores(BASE + 'packs/dominion-1867-5.v1.json');
    expect(scores).toHaveLength(5);
    const rows = block('hoc-scores')
      .split('\n')
      .slice(2)
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    expect(rows).toEqual(
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
});
