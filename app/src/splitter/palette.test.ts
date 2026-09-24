// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { deltaE2000, hexToRgb, over, rgbToLab, simulateDeuteranopia } from './colourVision';
import { BASEMAP_LAND, REGION_FILL_OPACITY, REGION_HUES } from './palette';

/** Every pair of the eight region hues, as four viewers see them (plan Phase 7 §3). */

const MIN_DELTA_E = 12;

function worstPair(transform: (hex: string) => [number, number, number]) {
  let worst = { delta: Infinity, pair: '' };
  for (let i = 0; i < REGION_HUES.length; i++) {
    for (let j = i + 1; j < REGION_HUES.length; j++) {
      const delta = deltaE2000(rgbToLab(transform(REGION_HUES[i])), rgbToLab(transform(REGION_HUES[j])));
      if (delta < worst.delta) worst = { delta, pair: `${REGION_HUES[i]} / ${REGION_HUES[j]}` };
    }
  }
  return worst;
}

const base = hexToRgb(BASEMAP_LAND);
const drawn = (hex: string) => over(hexToRgb(hex), base, REGION_FILL_OPACITY);

describe('region palette', () => {
  it('computes CIEDE2000 as published (Sharma, Wu and Dalal 2005, test pairs 1, 7 and 17)', () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE2000([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 3);
    expect(deltaE2000([22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619])).toBeCloseTo(2.0373, 3);
  });

  it('simulates deuteranopia so red and green collapse, and leaves grey alone', () => {
    const red = rgbToLab(simulateDeuteranopia(hexToRgb('#d62728')));
    const green = rgbToLab(simulateDeuteranopia(hexToRgb('#2ca02c')));
    expect(deltaE2000(red, green)).toBeLessThan(15);
    expect(simulateDeuteranopia([0.5, 0.5, 0.5]).map((c) => +c.toFixed(3))).toEqual([0.5, 0.5, 0.5]);
  });

  it.each([
    ['full strength', (hex: string) => hexToRgb(hex)],
    ['full strength, deuteranopia', (hex: string) => simulateDeuteranopia(hexToRgb(hex))],
    ['as drawn', drawn],
    ['as drawn, deuteranopia', (hex: string) => simulateDeuteranopia(drawn(hex))],
  ] as const)('keeps all 28 pairs at least 12 apart: %s', (_, transform) => {
    const worst = worstPair(transform);
    expect(worst.delta, worst.pair).toBeGreaterThanOrEqual(MIN_DELTA_E);
  });
});
