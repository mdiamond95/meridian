import { beforeEach, describe, expect, it } from 'vitest';
import type { AtlasFile, AtlasUnit } from '../schema/atlas';
import { initialAtlasState, startYear, useAtlasStore } from '../state/atlasStore';
import {
  currentEvent,
  dateToYear,
  formatDate,
  resolveReferences,
  resolvedAt,
  resolveUnits,
  unitHistory,
  yearRange,
  yearToDate,
} from './resolve';

const unit = (over: Partial<AtlasUnit>): AtlasUnit => ({
  id: 'manitoba',
  name: 'Manitoba',
  status: 'province',
  sovereign: 'Canada',
  capital: 'Winnipeg',
  validFrom: '1870-07-15',
  validTo: null,
  truth: 'dejure',
  geometryRef: 'manitoba_1870',
  ...over,
});

const ATLAS: AtlasFile = {
  format: 'meridian.atlas',
  version: 'v1',
  events: [
    { date: '1870-07-15', title: 'Manitoba', note: 'n', changes: [{ unit: 'manitoba', kind: 'create' }] },
    {
      date: '1881-07-01',
      title: 'Manitoba enlarged',
      note: 'n',
      changes: [{ unit: 'manitoba', kind: 'alter' }],
    },
  ],
  units: [
    unit({ validTo: '1881-07-01' }),
    unit({ validFrom: '1881-07-01', geometryRef: 'manitoba_1881' }),
    unit({
      id: 'keewatin',
      name: 'Keewatin',
      status: 'district',
      validFrom: '1876-04-12',
      validTo: '1905-07-20',
    }),
    unit({
      id: 'claim',
      name: 'Claim',
      status: 'disputed',
      truth: 'disputed',
      validFrom: '1881-07-01',
      validTo: '1889-08-12',
    }),
  ],
};

describe('resolveUnits', () => {
  it('treats validFrom as inclusive and validTo as exclusive', () => {
    expect(resolveUnits(ATLAS, '1870-07-14')).toEqual([]);
    expect(resolveUnits(ATLAS, '1870-07-15').map((u) => u.geometryRef)).toEqual(['manitoba_1870']);
    expect(resolveUnits(ATLAS, '1881-06-30').map((u) => u.geometryRef)).toEqual([
      'manitoba_1870',
      'manitoba_1870',
    ]);
    expect(resolveUnits(ATLAS, '1881-07-01').map((u) => u.geometryRef)).toEqual([
      'manitoba_1881',
      'manitoba_1870',
    ]);
    expect(resolveUnits(ATLAS, '1905-07-20').map((u) => u.id)).toEqual(['manitoba']);
  });

  it('filters by truth layer, de jure by default', () => {
    expect(resolveUnits(ATLAS, '1885-01-01').map((u) => u.id)).toEqual(['manitoba', 'keewatin']);
    expect(resolveUnits(ATLAS, '1885-01-01', ['disputed']).map((u) => u.id)).toEqual(['claim']);
  });
});

describe('resolveReferences', () => {
  it('resolves reference drawings by date and tolerates files without any', () => {
    const ref = {
      id: 'nrcan_manitoba_1870_manitoba',
      name: 'Manitoba',
      unit: 'manitoba',
      source: 'nrcan_te_1870',
      attribution: 'OGL',
      validFrom: '1870-07-15',
      validTo: '1881-07-01',
      geometryRef: 'nrcan_manitoba_1870_manitoba',
    };
    const atlas = { references: [ref] };
    expect(resolveReferences(atlas, '1870-07-14')).toEqual([]);
    expect(resolveReferences(atlas, '1875-01-01')).toEqual([ref]);
    expect(resolveReferences(atlas, '1881-07-01')).toEqual([]);
    expect(resolveReferences({}, '1875-01-01')).toEqual([]);
  });
});

describe('timeline helpers', () => {
  it('finds the latest event on or before a date', () => {
    expect(currentEvent(ATLAS, '1870-01-01')).toBeNull();
    expect(currentEvent(ATLAS, '1870-07-15')?.title).toBe('Manitoba');
    expect(currentEvent(ATLAS, '1900-12-31')?.title).toBe('Manitoba enlarged');
  });

  it('maps a slider year to the end of that year and back', () => {
    expect(yearToDate(1870)).toBe('1870-12-31');
    expect(yearToDate(1000)).toBe('1000-12-31');
    expect(dateToYear('1999-04-01')).toBe(1999);
    expect(yearRange(ATLAS, new Date('2026-09-15T00:00:00Z'))).toEqual([1870, 2026]);
  });

  it('lists a unit history oldest first and formats dates', () => {
    expect(unitHistory(ATLAS, 'manitoba').map((u) => u.validFrom)).toEqual(['1870-07-15', '1881-07-01']);
    expect(formatDate('1999-04-01')).toBe('1 Apr 1999');
  });
});

describe('atlasStore', () => {
  beforeEach(() =>
    useAtlasStore.setState({
      ...initialAtlasState,
      data: { atlas: ATLAS, geometries: new Map() },
      status: 'ready',
    }),
  );

  it('keeps a selection while the unit exists and clears it once it does not', () => {
    const store = useAtlasStore.getState();
    store.setDate('1880-01-01');
    store.select('keewatin');
    store.setDate('1890-01-01'); // Keewatin still exists
    expect(useAtlasStore.getState().selected).toBe('keewatin');
    store.setDate('1906-01-01'); // dissolved in 1905
    expect(useAtlasStore.getState().selected).toBeNull();
  });

  it('clears the selection when the atlas is hidden, and toggles truth layers', () => {
    const store = useAtlasStore.getState();
    store.select('manitoba');
    store.setVisible(false);
    expect(useAtlasStore.getState()).toMatchObject({ visible: false, selected: null });
    store.toggleTruth('disputed');
    expect(useAtlasStore.getState().truth).toEqual({ dejure: true, defacto: false, disputed: true });
  });
});

describe('the timeline start and the disputed layer', () => {
  it('reaches back before the atlas when a start is chosen', () => {
    expect(startYear(1000)).toBe(1000);
    expect(startYear(1497)).toBe(1497);
    // "frontier" starts at 1000 too; what differs is that each area is shaded until contact.
    expect(startYear('frontier')).toBe(1000);
  });

  it('resolves at the current event, so a date inside one window gives the same rows', () => {
    expect(resolvedAt(ATLAS, '1875-06-01')).toBe('1870-07-15');
    expect(resolvedAt(ATLAS, '1870-07-15')).toBe('1870-07-15');
    expect(resolvedAt(ATLAS, '1600-01-01')).toBe(''); // before the first event: nothing to draw
  });

  it('keeps the claims of one dispute apart from the units', () => {
    const claims: AtlasUnit[] = [
      unit({
        id: 'oregon_claim_us',
        name: "Oregon Country (United States' claim)",
        truth: 'disputed',
        dispute: 'oregon',
        sovereign: 'United States',
        status: 'disputed',
        validFrom: '1819-01-30',
        validTo: '1846-07-17',
        geometryRef: 'oregon_us',
      }),
      unit({
        id: 'oregon_claim_britain',
        name: 'Columbia District (British claim)',
        truth: 'disputed',
        dispute: 'oregon',
        sovereign: 'Britain',
        status: 'disputed',
        validFrom: '1819-01-30',
        validTo: '1846-07-17',
        geometryRef: 'oregon_gb',
      }),
    ];
    const atlas: AtlasFile = { ...ATLAS, units: [...ATLAS.units, ...claims] };
    // De jure by default: a claim never joins the map of what was.
    expect(resolveUnits(atlas, '1830-01-01').length).toBe(0);
    const disputed = resolveUnits(atlas, '1830-01-01', ['disputed']);
    expect(disputed.map((u) => u.sovereign).sort()).toEqual(['Britain', 'United States']);
    expect(new Set(disputed.map((u) => u.dispute))).toEqual(new Set(['oregon']));
    // Both claims end with the treaty.
    expect(resolveUnits(atlas, '1846-07-17', ['disputed'])).toEqual([]);
  });
});
