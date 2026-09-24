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
    expect(SCENARIOS.map((s) => s.id)).toEqual([
      'buffalo-1905',
      'maritime-union',
      'newfoundland-independent-1949',
      'no-1912-extensions',
    ]);
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

describe('No 1912 extensions', () => {
  const result = applyScenario(base, scenario('no-1912-extensions'));
  const units = (date: string) => resolveUnits(result.loaded.atlas, date);
  const ref = (date: string, id: string) => unitAt(units(date), id)?.geometryRef;
  const baseRef = (date: string, id: string) => unitAt(resolveUnits(atlas, date), id)?.geometryRef;

  it('keeps the three provinces at their pre-1912 lines, and the land in the districts', () => {
    for (const date of ['1912-05-15', '1919-12-31', '1920-01-01']) {
      for (const id of ['manitoba', 'ontario', 'quebec', 'district_of_keewatin', 'district_of_ungava'])
        expect(ref(date, id)).toBe(baseRef('1912-05-14', id));
    }
    for (const date of ['1927-03-01', '1998-12-31']) {
      expect(ref(date, 'manitoba')).toBe('manitoba_1881');
      expect(ref(date, 'ontario')).toBe('ontario_1889');
      expect(ref(date, 'district_of_keewatin')).toBe('district_of_keewatin_1905');
    }
    expect(unitAt(units('1950-01-01'), 'district_of_ungava')).toMatchObject({ status: 'district' });
  });

  it('keeps the districts at their earlier lines through the 1920 revision', () => {
    const later = units('1950-01-01');
    expect(unitAt(later, 'district_of_mackenzie')?.geometryRef).toBe('district_of_mackenzie_1901');
    expect(unitAt(later, 'district_of_franklin')?.geometryRef).toBe('district_of_franklin_1897');
    expect(unitAt(later, 'district_of_ungava')?.geometryRef).toBe('district_of_ungava_1912');
  });

  it('rejoins the record where the atlas has no drawing: Quebec in 1927, Manitoba and Ontario in 1999', () => {
    expect(ref('1927-03-01', 'quebec')).toBe('quebec_1927');
    expect(ref('1927-02-28', 'quebec')).toBe('quebec_1898');
    for (const id of ['manitoba', 'ontario', 'quebec', 'newfoundland'])
      expect(ref(TODAY, id)).toBe(baseRef(TODAY, id));
    expect(unitAt(units('1999-04-01'), 'district_of_ungava')).toBeUndefined();
    expect(unitAt(units(TODAY), 'nunavut')).toBeDefined();
    expect(diffAtDate(base, result.loaded, TODAY)).toEqual([]);
  });

  it('applies every later base event, and resolves cleanly', () => {
    expect(result.skipped).toEqual([]);
    const applied = new Set(result.loaded.atlas.events.map((e) => `${e.date}|${e.title}`));
    for (const e of atlas.events) expect(applied.has(`${e.date}|${e.title}`)).toBe(true);
    expect(checkScenario(base, result, TODAY)).toEqual({ ok: true, problems: [] });
  });

  it('diffs against the base: the three provinces and the districts between 1912 and 1927', () => {
    const diff = diffAtDate(base, result.loaded, '1913-01-01');
    expect(diff.map((d) => `${d.kind}:${d.id}`)).toEqual([
      'changed:district_of_keewatin',
      'changed:district_of_ungava',
      'changed:manitoba',
      'changed:ontario',
      'changed:quebec',
    ]);
    expect(diff.every((d) => d.kind === 'changed' && d.fields.includes('boundary'))).toBe(true);
  });
});

describe('Maritime Union', () => {
  const result = applyScenario(base, scenario('maritime-union'));
  const units = (date: string) => resolveUnits(result.loaded.atlas, date);
  const MARITIMES = ['nova_scotia', 'new_brunswick', 'prince_edward_island'];

  it('shows one Maritime province from 1867, and no Nova Scotia, New Brunswick or Island', () => {
    for (const date of ['1867-07-01', '1873-07-01', TODAY]) {
      const here = units(date);
      expect(unitAt(here, 'maritime_province')).toMatchObject({
        name: 'Maritime Province',
        status: 'province',
        sovereign: 'Canada',
      });
      for (const id of MARITIMES) expect(unitAt(here, id)).toBeUndefined();
    }
    expect(unitAt(units('1867-06-30'), 'maritime_province')).toBeUndefined();
    expect(unitAt(units('1867-06-30'), 'prince_edward_island')).toMatchObject({ status: 'colony' });
  });

  it('skips the 1873 admission of the Island, which is already in, and says why', () => {
    expect(result.skipped.map((s) => `${s.date}|${s.title}`)).toEqual([
      '1873-07-01|Prince Edward Island joins',
    ]);
    expect(result.skipped[0].reasons).toEqual([
      'acts on prince_edward_island, which does not exist in this scenario',
    ]);
    // Every other base event applies.
    const applied = new Set(result.loaded.atlas.events.map((e) => e.date));
    for (const e of atlas.events) if (e.date !== '1873-07-01') expect(applied.has(e.date)).toBe(true);
    expect(checkScenario(base, result, TODAY)).toEqual({ ok: true, problems: [] });
  });

  it('is exactly the three drawings joined, the Chignecto border dissolved', () => {
    const row = unitAt(units(TODAY), 'maritime_province');
    const geometry = row && result.loaded.geometries.get(row.geometryRef);
    if (!geometry) throw new Error('no merged drawing');
    const parts = MARITIMES.map((id) => {
      const g = base.geometries.get(unitAt(resolveUnits(atlas, TODAY), id)?.geometryRef ?? '');
      if (!g) throw new Error(id);
      return sphericalAreaKm2(g);
    });
    expect(sphericalAreaKm2(geometry) / parts.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
  });

  it('diffs against the base: the Maritime province added, the three removed', () => {
    expect(diffAtDate(base, result.loaded, '1867-06-30')).toEqual([]);
    expect(diffAtDate(base, result.loaded, '1880-01-01').map((d) => `${d.kind}:${d.id}`)).toEqual([
      'added:maritime_province',
      'removed:new_brunswick',
      'removed:nova_scotia',
      'removed:prince_edward_island',
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
