// @vitest-environment node
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AtlasFileSchema } from '../schema/atlas';
import { TopologySchema } from '../schema/topojson';
import { decodeAtlas } from './loadAtlas';
import { resolveUnits } from './resolve';
import { bounds } from './topology';

// The committed artefacts, exactly as the bundle ships them (docs/plan.md Phase 2 §5 tests).
const BUILD = new URL('../../../data/build/', import.meta.url);
const atlas = AtlasFileSchema.parse(JSON.parse(readFileSync(new URL('atlas.v1.json', BUILD), 'utf8')));
const topology = TopologySchema.parse(
  JSON.parse(gunzipSync(readFileSync(new URL('atlas.v1.topojson.gz', BUILD))).toString('utf8')),
);
const { geometries } = decodeAtlas(atlas, topology);

const ids = (date: string) => resolveUnits(atlas, date).map((u) => u.id);
const unitAt = (date: string, id: string) => {
  const unit = resolveUnits(atlas, date).find((u) => u.id === id);
  if (!unit) throw new Error(`${id} not found at ${date}`);
  return unit;
};
const boundsOf = (date: string, id: string) => {
  const geometry = geometries.get(unitAt(date, id).geometryRef);
  if (!geometry) throw new Error(`no geometry for ${id}`);
  return bounds(geometry);
};

describe('the committed atlas', () => {
  it('decodes a polygon for every geometry ref', () => {
    const refs = [...atlas.units, ...(atlas.references ?? [])].map((u) => u.geometryRef);
    expect(geometries.size).toBe(new Set(refs).size);
  });

  it('1900: Yukon and the North-West Territories districts, but no province of Alberta', () => {
    const units = ids('1900-07-01');
    expect(units).toContain('yukon');
    expect(units).toEqual(expect.arrayContaining(['district_of_alberta', 'district_of_athabasca']));
    expect(units).not.toContain('alberta');
  });

  it('1906: Alberta and Saskatchewan are provinces reaching from 49°N to 60°N', () => {
    for (const id of ['alberta', 'saskatchewan']) {
      expect(unitAt('1906-01-01', id).status).toBe('province');
      const [, south, , north] = boundsOf('1906-01-01', id);
      expect(south).toBeCloseTo(49, 1);
      expect(north).toBeCloseTo(60, 1);
    }
  });

  it('1930: Manitoba reaches 60°N', () => {
    expect(boundsOf('1930-01-01', 'manitoba')[3]).toBeCloseTo(60, 1);
  });

  it('1950: Newfoundland is a province', () => {
    expect(unitAt('1950-01-01', 'newfoundland').status).toBe('province');
  });

  it('Nunavut does not exist on 1998-12-31 and does on 1999-04-01', () => {
    expect(ids('1998-12-31')).not.toContain('nunavut');
    expect(ids('1999-03-31')).not.toContain('nunavut');
    expect(ids('1999-04-01')).toContain('nunavut');
  });

  it('today has the thirteen provinces and territories', () => {
    expect(ids('2026-01-01')).toHaveLength(13);
  });
});
