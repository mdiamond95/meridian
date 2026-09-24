// @vitest-environment node
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeAtlas } from '../atlas/loadAtlas';
import { resolveUnits } from '../atlas/resolve';
import { topologyTools } from '../atlas/topology';
import { AtlasFileSchema } from '../schema/atlas';
import { ScenarioSchema, type Scenario } from '../schema/scenario';
import { TopologySchema } from '../schema/topojson';
import { applyScenario, checkScenario, diffAtDate, sphericalAreaKm2 } from './apply';
import { scenarioById, SCENARIOS } from './scenarios';

const BUILD = new URL('../../../data/build/', import.meta.url);
const atlas = AtlasFileSchema.parse(JSON.parse(readFileSync(new URL('atlas.v1.json', BUILD), 'utf8')));
const topology = TopologySchema.parse(
  JSON.parse(gunzipSync(readFileSync(new URL('atlas.v1.topojson.gz', BUILD))).toString('utf8')),
);
const base = decodeAtlas(atlas, topology);
const TODAY = '2026-09-24';

function scenario(id: string): Scenario {
  const found = scenarioById(id);
  if (!found) throw new Error(`no scenario ${id}`);
  return found;
}
const unitAt = (units: ReturnType<typeof resolveUnits>, id: string) => units.find((u) => u.id === id);

describe('replay', () => {
  it('reproduces the base atlas row for row when the scenario changes nothing', () => {
    const nothing = ScenarioSchema.parse({
      format: 'meridian.scenario',
      id: 'nothing',
      name: 'Nothing',
      fork: '2030-01-01',
      premise: 'p',
      events: [{ date: '2030-01-01', title: 'Nothing', note: 'n', sources: ['s'], changes: [] }],
    });
    const result = applyScenario(base, nothing);
    expect(result.loaded.atlas.units).toEqual(atlas.units);
    expect(result.loaded.atlas.events.slice(0, -1)).toEqual(atlas.events);
    expect(result.skipped).toEqual([]);
  });

  it('refuses a scenario whose own event cannot apply', () => {
    const broken = ScenarioSchema.parse({
      format: 'meridian.scenario',
      id: 'broken',
      name: 'Broken',
      fork: '1900-01-01',
      premise: 'p',
      events: [
        { date: '1900-01-01', title: 'Early', note: 'n', sources: ['s'], changes: [{ dissolve: 'alberta' }] },
      ],
    });
    expect(() => applyScenario(base, broken)).toThrow(/alberta, which does not exist/);
  });

  it('every shipped scenario parses, has a premise paragraph and cites every event', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(['buffalo-1905', 'newfoundland-independent-1949']);
    for (const s of SCENARIOS) {
      expect(s.premise.length).toBeGreaterThan(200);
      for (const event of s.events) expect(event.sources.length).toBeGreaterThan(0);
    }
  });
});

describe('Newfoundland independent (the Phase 6 gate)', () => {
  const result = applyScenario(base, scenario('newfoundland-independent-1949'));
  const units = (date: string) => resolveUnits(result.loaded.atlas, date);

  it('shows no 1949 accession, and says why', () => {
    expect(result.loaded.atlas.events.some((e) => e.date === '1949-03-31')).toBe(false);
    const skipped = result.skipped.map((s) => s.date);
    expect(skipped).toEqual(['1949-03-31', '2001-12-06']);
    expect(result.skipped[0].reasons[0]).toMatch(/under Britain; in this scenario it is under Newfoundland/);
    const nl = unitAt(units('1950-01-01'), 'newfoundland');
    expect(nl).toMatchObject({ status: 'dominion', sovereign: 'Newfoundland', name: 'Newfoundland' });
  });

  it('still resolves cleanly to today: Labrador as in 1927, nine provinces in Canada', () => {
    const today = units(TODAY);
    const nl = unitAt(today, 'newfoundland');
    expect(nl?.geometryRef).toBe('newfoundland_1927');
    expect(nl?.validTo).toBeNull();
    expect(today.filter((u) => u.status === 'province' && u.sovereign === 'Canada')).toHaveLength(9);
    expect(checkScenario(base, result, TODAY)).toEqual({ ok: true, problems: [] });
  });

  it('diffs against the base at any date', () => {
    expect(diffAtDate(base, result.loaded, '1940-01-01')).toEqual([]);
    const diff = diffAtDate(base, result.loaded, '1950-01-01');
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ kind: 'changed', id: 'newfoundland', fields: ['status', 'sovereign'] });
    expect(diffAtDate(base, result.loaded, TODAY)[0]).toMatchObject({
      fields: ['name', 'status', 'sovereign'],
    });
  });
});

describe('Unified Buffalo (the Phase 6 gate)', () => {
  const result = applyScenario(base, scenario('buffalo-1905'));
  const units = (date: string) => resolveUnits(result.loaded.atlas, date);

  it('shows one province from 1905 with its capital, and no Alberta or Saskatchewan', () => {
    for (const date of ['1905-09-01', '1950-01-01', TODAY]) {
      const here = units(date);
      expect(unitAt(here, 'buffalo')).toMatchObject({ status: 'province', capital: 'Regina' });
      expect(unitAt(here, 'alberta')).toBeUndefined();
      expect(unitAt(here, 'saskatchewan')).toBeUndefined();
    }
    expect(unitAt(units('1905-08-31'), 'buffalo')).toBeUndefined();
    expect(result.skipped).toEqual([]);
  });

  it('draws no Alberta–Saskatchewan line', () => {
    const buffalo = unitAt(units(TODAY), 'buffalo');
    const geometry = buffalo && result.loaded.geometries.get(buffalo.geometryRef);
    if (!geometry || geometry.type !== 'MultiPolygon') throw new Error('no merged drawing');
    expect(geometry.coordinates).toHaveLength(1);
    expect(geometry.coordinates[0]).toHaveLength(1); // no holes, no second ring
    // No vertex on 110°W except where it meets the outer boundary at 49°N and 60°N.
    const onLine = geometry.coordinates[0][0].filter(
      ([x, y]) => Math.abs(x + 110) < 0.01 && y > 49.1 && y < 59.9,
    );
    expect(onLine).toEqual([]);
    const parts = ['alberta', 'saskatchewan'].map((id) => {
      const row = unitAt(resolveUnits(atlas, TODAY), id);
      const g = row && base.geometries.get(row.geometryRef);
      if (!g) throw new Error(id);
      return sphericalAreaKm2(g);
    });
    expect(sphericalAreaKm2(geometry) / (parts[0] + parts[1])).toBeCloseTo(1, 4);
  });

  it('still applies 1912 and every later event', () => {
    const later = atlas.events.filter((e) => e.date >= '1912-01-01').map((e) => e.date);
    const applied = new Set(result.loaded.atlas.events.map((e) => e.date));
    for (const date of later) expect(applied.has(date)).toBe(true);
    const manitoba = (list: typeof atlas.units) =>
      unitAt(resolveUnits({ units: list }, '1913-01-01'), 'manitoba');
    expect(manitoba(result.loaded.atlas.units)?.geometryRef).toBe(manitoba(atlas.units)?.geometryRef);
    expect(unitAt(units(TODAY), 'nunavut')).toBeDefined();
    expect(checkScenario(base, result, TODAY)).toEqual({ ok: true, problems: [] });
  });

  it('diffs against the base: Buffalo added, the two provinces gone', () => {
    const diff = diffAtDate(base, result.loaded, '1950-01-01');
    expect(diff.map((d) => `${d.kind}:${d.id}`)).toEqual([
      'added:buffalo',
      'removed:alberta',
      'removed:saskatchewan',
    ]);
  });
});

describe('merging drawings', () => {
  it('dissolves the arc two squares share', () => {
    const tools = topologyTools({
      type: 'Topology',
      arcs: [
        [
          [1, 0],
          [0, 0],
          [0, 1],
          [1, 1],
        ],
        [
          [1, 1],
          [1, 0],
        ],
        [
          [1, 1],
          [2, 1],
          [2, 0],
          [1, 0],
        ],
      ],
      objects: {
        a: { type: 'Polygon', arcs: [[0, 1]] },
        b: { type: 'Polygon', arcs: [[-2, 2]] },
      },
    } as never);
    const merged = tools.merge(['a', 'b']);
    expect(merged.coordinates).toHaveLength(1);
    expect(merged.coordinates[0]).toHaveLength(1);
    expect(merged.coordinates[0][0]).toHaveLength(7); // around both squares, closed
    expect(Math.abs(sphericalAreaKm2(merged) - sphericalAreaKm2(tools.decode('a')) * 2)).toBeLessThan(1);
  });
});
