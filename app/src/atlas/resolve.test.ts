import { beforeEach, describe, expect, it } from 'vitest';
import type { AtlasFile, AtlasUnit } from '../schema/atlas';
import { initialAtlasState, useAtlasStore } from '../state/atlasStore';
import {
  currentEvent,
  dateToYear,
  formatDate,
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
