// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { realSplitterData } from '../splitter/testing/realSplitterData';
import { immigrantHalos, OVERLAYS } from './overlays';

describe('non-geographic overlays', () => {
  const data = realSplitterData();

  it('immigrant-share halos: one per CMA, sized by people, coloured by share', () => {
    const halos = immigrantHalos(data);
    expect(halos).toHaveLength(data.cmas.length);
    expect(halos[0].label).toBe('Toronto');
    expect(halos[0].size).toBe(1);
    expect(halos[0].detail).toMatch(/^Toronto: 4\d\.\d% immigrants/);
    for (const h of halos) {
      expect(h.size).toBeGreaterThan(0);
      expect(h.size).toBeLessThanOrEqual(1);
      expect(h.value).toBeGreaterThanOrEqual(0);
      expect(h.value).toBeLessThanOrEqual(1);
    }
    // The share is the population-weighted mean over the CMA's cells, so it differs by city.
    expect(new Set(halos.map((h) => h.value.toFixed(3))).size).toBeGreaterThan(20);
    // Placed at the population-weighted centre, inside Canada's extent.
    const toronto = halos[0];
    expect(Math.abs(toronto.lng + 79.4)).toBeLessThan(0.6);
    expect(Math.abs(toronto.lat - 43.7)).toBeLessThan(0.4);
  });

  it('claims no cells: an overlay is built from data alone, whatever the partition', () => {
    for (const overlay of OVERLAYS) expect(overlay.build.length).toBe(1);
    expect(OVERLAYS.map((o) => `${o.id}:${o.kind}`)).toEqual(['immigrant-halos:point']);
  });
});
