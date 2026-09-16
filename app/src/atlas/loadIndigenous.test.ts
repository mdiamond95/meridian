import { describe, expect, it } from 'vitest';
import type { Topology } from '../schema/topojson';
import { INDIGENOUS_CAVEAT, IndigenousFileSchema, type IndigenousFile } from '../schema/indigenous';
import { FAMILY_COLOURS, familyColour, familyStyle } from './style';
import { decodeIndigenous, indigenousShown, labelledAreas } from './loadIndigenous';

const TOPOLOGY: Topology = {
  type: 'Topology',
  transform: { scale: [1, 1], translate: [0, 0] },
  arcs: [
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ],
  ],
  objects: { family_7_census: { type: 'Polygon', arcs: [[0]] } },
};

const FILE: IndigenousFile = {
  format: 'meridian.indigenous',
  version: 'v1',
  caveat: INDIGENOUS_CAVEAT,
  families: [{ code: 7, glottocode: 'sali1255', glottologName: 'Salishan', label: 'Salish' }],
  areas: [
    {
      family: 7,
      source: 'census',
      confidence: 0.7,
      cells: 12,
      geometryRef: 'family_7_census',
      labelPoint: [-123, 49.5],
    },
  ],
  communities: [
    { id: 55624, name: 'Snuneymuxw First Nation', people: 'first_nation', lng: -123.9, lat: 49.2 },
    { id: 123033, name: "Tsuut'ina Nation", people: 'first_nation', lng: -114.2, lat: 50.9 },
  ],
  attribution: [
    {
      source: 'glottolog_languoids',
      text: 'Language families and locations from Glottolog 5.3',
      licence: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
      url: 'https://creativecommons.org/licenses/by/4.0/',
    },
  ],
};

describe('Indigenous language families', () => {
  it('decodes one polygon per area', () => {
    const loaded = decodeIndigenous(IndigenousFileSchema.parse(FILE), TOPOLOGY);
    expect(loaded.geometries.get('family_7_census')?.type).toBe('Polygon');
  });

  it('carries the schema caveat and nothing softer', () => {
    expect(INDIGENOUS_CAVEAT).toBe(
      'Derived from modern language distribution and linguistic records; not pre-contact boundaries.',
    );
    expect(() => IndigenousFileSchema.parse({ ...FILE, caveat: 'Approximate territories.' })).toThrow();
    const { caveat, ...withoutCaveat } = FILE;
    expect(caveat).toBeTruthy();
    expect(() => IndigenousFileSchema.parse(withoutCaveat)).toThrow();
  });

  it('rejects an area of an unknown family and unsorted communities', () => {
    expect(() => IndigenousFileSchema.parse({ ...FILE, areas: [{ ...FILE.areas[0], family: 99 }] })).toThrow(
      /unknown family/,
    );
    expect(() =>
      IndigenousFileSchema.parse({ ...FILE, communities: [...FILE.communities].reverse() }),
    ).toThrow(/sorted/);
  });

  it('is the pre-contact base before the atlas begins and optional at any later date', () => {
    const off = { familiesVisible: false, communitiesVisible: false };
    expect(indigenousShown(off, true)).toEqual({ families: true, communities: true });
    expect(indigenousShown(off, false)).toEqual({ families: false, communities: false });
    expect(indigenousShown({ familiesVisible: true, communitiesVisible: false }, false)).toEqual({
      families: true,
      communities: false,
    });
  });

  it('draws inferred areas fainter than census areas, and keeps the eight hues distinct', () => {
    const census = familyStyle({ family: 1, source: 'census' });
    const inferred = familyStyle({ family: 1, source: 'glottolog' });
    expect(inferred.fillOpacity).toBeLessThan(census.fillOpacity ?? 0);
    expect(new Set(Object.values(FAMILY_COLOURS)).size).toBe(8);
    expect(familyColour(4)).toBe(familyColour(11)); // Haida and Beothuk share the neutral fill
  });

  it('names every family once and skips small scattered areas', () => {
    const areas = [
      { family: 1, cells: 900, geometryRef: 'family_1_glottolog' },
      { family: 1, cells: 3, geometryRef: 'family_1_census' },
      { family: 4, cells: 2, geometryRef: 'family_4_census' },
    ];
    expect(labelledAreas(areas).map((a) => a.geometryRef)).toEqual(['family_1_glottolog', 'family_4_census']);
  });
});
