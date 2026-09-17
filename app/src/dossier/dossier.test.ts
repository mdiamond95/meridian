// @vitest-environment node
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { RegionDossierSchema, SetAnalysisSchema, PLACEHOLDER_MARK } from '../schema/dossier';
import { TopologySchema } from '../schema/topojson';
import { cellTopology } from '../splitter/outline';
import { decodePack, specFromPack } from '../splitter/pack';
import { prepareSplit, runSplit } from '../splitter/split';
import { realSplitterData } from '../splitter/testing/realSplitterData';
import { borderRuns } from './borders';
import { buildDossiers, buildSetAnalysis } from './dossier';
import { FEDERALISM_RULES, federalismFindings } from './federalism';
import { generateNames, namesRespectIndigenousRule } from './names';
import { setMarkdown } from './markdown';
import { regionAggregates } from './stats';
import { VAGUE_WORDS } from './text';

/**
 * Phase 4 tests. The borders-in-words golden is the alberta-15 preset (Mark, 2026-09-17): the set
 * must name at least one parallel or township line, one river and one provincial border, correctly.
 */

const data = realSplitterData();
const topo = cellTopology(
  TopologySchema.parse(
    JSON.parse(
      gunzipSync(readFileSync(new URL('../../../data/build/cells.v1.topojson.gz', import.meta.url))).toString(
        'utf8',
      ),
    ),
  ),
);
const pack = (id: string) =>
  decodePack(JSON.parse(readFileSync(new URL(`../../public/packs/${id}.json`, import.meta.url), 'utf8')));

function built(id: string) {
  const loaded = pack(id);
  const spec = specFromPack(loaded);
  const prepared = prepareSplit(spec, data);
  const input = {
    data,
    topo,
    prepared,
    assignment: loaded.assignment,
    regionCount: loaded.regions.length,
    manualNames: Object.fromEntries(
      loaded.regions.filter((r) => spec.capitalNames?.includes(r.name)).map((r) => [r.id, r.name]),
    ),
  };
  const { dossiers, aggregates, names } = buildDossiers(input);
  const set = buildSetAnalysis({
    ...input,
    aggregates,
    names,
    pieces: loaded.regions.map((r) => Number(r.stats.pieces ?? 1)),
  });
  return { loaded, spec, prepared, dossiers, aggregates, names, set };
}

describe('borders in words', () => {
  it('names a parallel, a river and a provincial border across alberta-15', () => {
    const { loaded } = built('alberta-15');
    const runs = loaded.regions.flatMap((r) => borderRuns(data, topo, loaded.assignment, r.id));
    const kinds = new Set(runs.map((run) => run.kind));
    expect(kinds.has('parallel') || kinds.has('meridian')).toBe(true);
    expect(kinds.has('river')).toBe(true);
    expect(kinds.has('province')).toBe(true);

    // ...and correctly: Alberta's neighbours, real rivers, and parallels inside Alberta's range.
    const provinces = runs.filter((r) => r.kind === 'province').map((r) => r.label);
    expect(provinces.every((label) => /Alberta/.test(label))).toBe(true);
    expect(provinces.some((label) => /British Columbia|Saskatchewan|Northwest Territories/.test(label))).toBe(
      true,
    );
    const rivers = new Set(runs.filter((r) => r.kind === 'river').map((r) => r.label));
    expect([...rivers].every((label) => /^the .+/.test(label))).toBe(true);
    expect(
      [...rivers].some((label) => /Athabasca|Saskatchewan|Peace|Bow|Red Deer|Smoky|McLeod/.test(label)),
    ).toBe(true);
    for (const run of runs.filter((r) => r.kind === 'parallel')) {
      const degrees = Number(/([\d.]+)°N/.exec(run.label)?.[1]);
      expect(degrees).toBeGreaterThanOrEqual(48.9);
      expect(degrees).toBeLessThanOrEqual(60.1);
    }
    // The 49th parallel is the international boundary, and says so.
    // The 49th parallel on the edge of the mesh is the international boundary and says so; a
    // boundary this split drew that happens to run flat says "about 49°N" instead.
    const southern = runs.filter((r) => r.kind === 'parallel' && r.label.includes('49'));
    expect(southern.some((r) => r.label === 'the 49°N parallel (the international boundary)')).toBe(true);
    expect(southern.every((r) => /^the .*international boundary\)$|^about /.test(r.label))).toBe(true);
  }, 120_000);

  it('walks clockwise from the north-west and merges runs', () => {
    const { loaded } = built('alberta-15');
    const runs = borderRuns(data, topo, loaded.assignment, 0);
    expect(runs.length).toBeGreaterThan(2);
    expect(runs.every((run) => run.km > 0)).toBe(true);
    // No two neighbouring runs say the same thing.
    for (let i = 1; i < runs.length; i++) expect(runs[i].label).not.toBe(runs[i - 1].label);
  }, 60_000);
});

describe('dossiers', () => {
  it('validate, reconcile GDP and population, and keep every GDP number with its caveat', () => {
    const { dossiers, set, loaded } = built('alberta-15');
    for (const dossier of dossiers) expect(RegionDossierSchema.parse(dossier)).toBeTruthy();
    expect(SetAnalysisSchema.parse(set)).toBeTruthy();
    expect(set.reconciliation.ok).toBe(true);
    expect(Math.abs(set.reconciliation.population.difference)).toBeLessThanOrEqual(1);
    const packPopulation = loaded.regions.reduce((sum, r) => sum + Number(r.stats.population ?? 0), 0);
    expect(set.reconciliation.population.regions).toBe(packPopulation);
    for (const dossier of dossiers) {
      if (dossier.gdpCadMillions !== null) expect(dossier.gdpCaveat).toMatch(/estimate/);
    }
    expect(set.gdpCaveat).toMatch(/allocation_v1/);
  }, 120_000);

  it('writes one concrete sentence per text field, marked as a draft', () => {
    const { dossiers } = built('alberta-15');
    for (const dossier of dossiers) {
      for (const field of [
        dossier.characterLine,
        dossier.oneSentence,
        dossier.whatWouldKillIt,
        dossier.whatWouldSaveIt,
      ]) {
        expect(field.placeholder).toBe(true);
        expect(field.text.startsWith(PLACEHOLDER_MARK)).toBe(true);
        const body = field.text.slice(PLACEHOLDER_MARK.length).trim();
        // One sentence: a full stop at the end and none in the middle except in numbers.
        expect(body.endsWith('.')).toBe(true);
        // One sentence: nothing after a full stop but the end. ("No. 1" in a place name is not one.)
        expect(body.slice(0, -1)).not.toMatch(/\.\s+[A-Z]/);
        // Concrete: a number or a place name, never a word that could be said of any region.
        expect(body).toMatch(/\d|[A-Z][a-z]+/);
        for (const word of VAGUE_WORDS) expect(body.toLowerCase()).not.toMatch(new RegExp(`\\b${word}\\b`));
      }
    }
  }, 120_000);

  it('gives a rival, cities and a hypothetical governing party', () => {
    const { dossiers } = built('alberta-15');
    expect(dossiers.every((d) => d.governingParty.hypothetical)).toBe(true);
    expect(dossiers.some((d) => d.rivalRegion !== null)).toBe(true);
    expect(dossiers.every((d) => d.capital === null || d.capital.population > 0)).toBe(true);
    for (const dossier of dossiers) {
      const names = [dossier.capital?.name, ...dossier.mainCities.map((c) => c.name)].filter(Boolean);
      expect(new Set(names).size).toBe(names.length);
    }
  }, 120_000);
});

describe('names', () => {
  it('never applies an Indigenous name to a region without an Indigenous majority', () => {
    for (const id of ['alberta-15', 'canada-26', 'canada-14']) {
      const loaded = pack(id);
      const prepared = prepareSplit(specFromPack(loaded), data);
      const aggregates = regionAggregates(
        data,
        prepared.scopeGraph.cells,
        loaded.assignment,
        loaded.regions.length,
      );
      const names = generateNames(data, prepared.scopeGraph.cells, loaded.assignment, aggregates, 1);
      const rule = namesRespectIndigenousRule(names, aggregates);
      expect({ id, ...rule }).toEqual({ id, ok: true, offenders: [] });
      // The rule bites: a region that is not Indigenous-majority may not take a family name even
      // when one dominates its ground.
      names.forEach((name, region) => {
        if (aggregates[region].indigenousIdentity <= 0.5) expect(name.indigenous).toBe(false);
      });
    }
  }, 120_000);

  it('is deterministic, unique within a set, and lets a manual name win', () => {
    const loaded = pack('alberta-15');
    const prepared = prepareSplit(specFromPack(loaded), data);
    const cells = prepared.scopeGraph.cells;
    const aggregates = regionAggregates(data, cells, loaded.assignment, loaded.regions.length);
    const once = generateNames(data, cells, loaded.assignment, aggregates, 15);
    const twice = generateNames(data, cells, loaded.assignment, aggregates, 15);
    expect(twice).toEqual(once);
    expect(new Set(once.map((n) => n.name)).size).toBe(once.length);
    expect(once.every((n) => n.reason.length > 0)).toBe(true);
    const manual = generateNames(data, cells, loaded.assignment, aggregates, 15, {
      manual: { 0: 'Palliser' },
    });
    expect(manual[0]).toMatchObject({ name: 'Palliser', source: 'manual' });
  }, 120_000);
});

describe('set analysis', () => {
  it('ranks power, finds split metros and evaluates every federalism rule with its citation', () => {
    const { set } = built('canada-14');
    expect(set.powerRanking).toHaveLength(14);
    expect(set.powerRanking[0].rank).toBe(1);
    expect(set.powerRanking.map((r) => r.rank)).toEqual([...set.powerRanking.map((_, i) => i + 1)]);
    expect(set.powerRanking.reduce((sum, r) => sum + r.economicLeverage, 0)).toBeCloseTo(1, 1);

    expect(set.federalism.map((f) => f.id)).toEqual(FEDERALISM_RULES.rules.map((r) => r.id));
    for (const finding of set.federalism) {
      expect(finding.citation.length).toBeGreaterThan(20);
      expect(finding.url).toMatch(/^https:\/\/laws-lois/);
      expect(finding.detail.length).toBeGreaterThan(40);
    }
    // Canada in 14 does not follow provincial lines, so the Senate divisions and Quebec are hit.
    expect(set.federalism.find((f) => f.id === 'senate_regions')?.verdict).toBe('breaks');
    expect(set.metrosSplit.every((m) => m.regions.length > 1)).toBe(true);
  }, 120_000);

  it('reports the scope and the ratios of a provincial split', () => {
    const { set } = built('alberta-15');
    expect(set.scope).toBe('AB');
    expect(set.ratios.population).toBeGreaterThan(1);
    expect(set.federalism.find((f) => f.id === 'quebec_asymmetry')?.detail).toMatch(
      /does not include Quebec/,
    );
    expect(set.federalism.find((f) => f.id === 'territorial_status')?.verdict).toBe('holds');
  }, 120_000);

  it('holds a set that follows provincial lines', () => {
    // Provinces as regions: the Senate divisions, Quebec and the territories all survive.
    const provinces = [...new Set(data.provinces)].sort();
    const assignment = Int32Array.from(data.provinces, (p) => provinces.indexOf(p));
    const spec = specFromPack(pack('canada-14'));
    const prepared = prepareSplit(spec, data);
    const aggregates = regionAggregates(data, prepared.scopeGraph.cells, assignment, provinces.length);
    const findings = federalismFindings({ regions: aggregates, names: provinces, scopeProvinces: provinces });
    expect(findings.find((f) => f.id === 'senate_regions')?.verdict).toBe('holds');
    expect(findings.find((f) => f.id === 'quebec_asymmetry')?.verdict).toBe('holds');
    expect(findings.find((f) => f.id === 'territorial_status')?.verdict).toBe('holds');
  }, 120_000);
});

describe('markdown export', () => {
  it('writes the set and every region, keeping the draft marks and the GDP caveat', () => {
    const { dossiers, set } = built('alberta-15');
    const markdown = setMarkdown(set, dossiers, 'Alberta in 15');
    expect(markdown).toContain('# Alberta in 15');
    expect(markdown).toContain('## Power ranking');
    expect(markdown).toContain('What would kill it');
    expect(markdown).toContain(PLACEHOLDER_MARK);
    expect(markdown).toContain('allocation_v1');
    for (const dossier of dossiers) expect(markdown).toContain(`## ${dossier.name}`);
    expect(markdown.split('\n').length).toBeGreaterThan(100);
  }, 120_000);
});

describe('a split from scratch', () => {
  it('describes a fresh run, not only a committed pack', () => {
    const spec = { ...specFromPack(pack('alberta-15')), n: 4, iterations: 20_000, seed: 4 };
    const { prepared, finished } = runSplit(spec, data);
    const input = {
      data,
      topo,
      prepared,
      assignment: finished.assignment,
      regionCount: finished.regions.length,
    };
    const { dossiers, aggregates, names } = buildDossiers(input);
    const set = buildSetAnalysis({
      ...input,
      aggregates,
      names,
      pieces: finished.regions.map((r) => r.pieces),
    });
    expect(dossiers).toHaveLength(4);
    expect(SetAnalysisSchema.parse(set).reconciliation.ok).toBe(true);
    expect(dossiers.every((d) => d.bordersInWords.length > 0)).toBe(true);
  }, 120_000);
});
