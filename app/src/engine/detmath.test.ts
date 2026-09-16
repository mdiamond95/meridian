import { describe, expect, it } from 'vitest';
import { DEG, detCos, detExp } from './detmath';

describe('deterministic maths', () => {
  it('detExp agrees with Math.exp to within rounding over the range annealing uses', () => {
    for (const x of [-700, -50, -20.5, -3, -1, -0.5, -1e-9, 0, 1e-9, 0.3, 1, 5, 40, 700]) {
      const exact = Math.exp(x);
      expect(Math.abs(detExp(x) - exact)).toBeLessThanOrEqual(exact * 1e-13);
    }
    expect(detExp(-800)).toBe(0);
    expect(detExp(800)).toBe(Infinity);
  });

  it('detCos agrees with Math.cos to within rounding', () => {
    for (const deg of [-720, -180, -95, -42.5, 0, 1e-6, 30, 45, 60, 83.1, 89.999, 90, 135, 180, 359]) {
      expect(detCos(deg * DEG)).toBeCloseTo(Math.cos(deg * DEG), 14);
    }
  });
});
