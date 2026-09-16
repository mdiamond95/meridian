import { describe, expect, it } from 'vitest';
import fixture from './fixtures/mulberry32.json';
import { mulberry32, shuffle } from './prng';

describe('mulberry32', () => {
  it('reproduces the shared fixture for every seed', () => {
    for (const { seed, uint32, float } of fixture.seeds) {
      const a = mulberry32(seed);
      expect(uint32.map(() => a.nextUint32())).toEqual(uint32);
      const b = mulberry32(seed);
      expect(float.map(() => b.next())).toEqual(float);
    }
  });

  it('draws integers in range and shuffles reproducibly', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 10_000; i++) {
      const k = rng.int(13);
      expect(k >= 0 && k < 13 && Number.isInteger(k)).toBe(true);
    }
    const once = shuffle([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(99));
    expect(shuffle([1, 2, 3, 4, 5, 6, 7, 8], mulberry32(99))).toEqual(once);
    expect([...once].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
