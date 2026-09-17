// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { actualCanada, compareSplits } from './compare';
import { decodePack } from './pack';
import { realSplitterData } from './testing/realSplitterData';
import { readFileSync } from 'node:fs';

const data = realSplitterData();
const pack = (id: string) =>
  decodePack(JSON.parse(readFileSync(new URL(`../../public/packs/${id}.json`, import.meta.url), 'utf8')));

describe('compare', () => {
  it('matches regions by overlap and counts what moved', () => {
    const canada14 = pack('canada-14');
    const mine = { assignment: canada14.assignment, names: canada14.regions.map((r) => r.name) };
    const baseline = actualCanada(data);
    expect(baseline.names).toHaveLength(13);

    const difference = compareSplits(mine, baseline, data);
    expect(difference.cells).toBe(data.cellIds.length);
    expect(difference.matches.length).toBeGreaterThan(5);
    // Every match is one-to-one.
    expect(new Set(difference.matches.map((m) => m.a)).size).toBe(difference.matches.length);
    expect(new Set(difference.matches.map((m) => m.b)).size).toBe(difference.matches.length);
    // A capitals split does not follow provincial lines, so plenty moves, but not everything.
    expect(difference.cellsReassigned).toBeGreaterThan(0);
    expect(difference.cellsReassigned).toBeLessThan(difference.cells);
    expect(difference.populationMoved).toBeGreaterThan(0);
    // 14 regions against 13 provinces: one region has no partner.
    expect(difference.onlyInA.length + difference.onlyInB.length).toBeGreaterThan(0);
  }, 60_000);

  it('a split compared with itself has nothing reassigned', () => {
    const canada26 = pack('canada-26');
    const mine = { assignment: canada26.assignment, names: canada26.regions.map((r) => r.name) };
    const difference = compareSplits(mine, mine, data);
    expect(difference.cellsReassigned).toBe(0);
    expect(difference.populationMoved).toBe(0);
    expect(difference.matches).toHaveLength(26);
    expect(difference.metrosSplitA).toEqual(difference.metrosSplitB);
  }, 60_000);
});
