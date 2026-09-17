/**
 * Deterministic elementary functions for the solver.
 *
 * The determinism gate (plan Phase 3) is the same seed giving the same split on iPad Safari and on
 * desktop Chrome. IEEE 754 fixes +, −, ×, ÷ and Math.sqrt to the bit, but ECMAScript lets
 * Math.exp, Math.log, Math.cos and friends differ between engines in the last bits — enough to flip
 * one annealing acceptance, after which two devices diverge. Everything here is built from the
 * exact operations only, in a fixed order, so every engine computes the same bits.
 */

const LN2 = 0.6931471805599453;
const PI = 3.141592653589793;

/** e^x for x in [-745, 709]: x = k·ln2 + r with |r| ≤ ln2/2, a fixed-length Taylor series for r. */
export function detExp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x > 709) return Infinity;
  if (x < -745) return 0;
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  // 18 terms: the remainder is below 1e-19 for |r| ≤ 0.35.
  let term = 1;
  let sum = 1;
  for (let i = 1; i <= 18; i++) {
    term = (term * r) / i;
    sum += term;
  }
  return scaleByPowerOfTwo(sum, k);
}

/** sum × 2^k by repeated exact doubling or halving (Math.pow is not required to be exact). */
function scaleByPowerOfTwo(value: number, k: number): number {
  let out = value;
  if (k > 0) for (let i = 0; i < k; i++) out *= 2;
  else for (let i = 0; i < -k; i++) out *= 0.5;
  return out;
}

/** cos x for any finite x: reduced to [-π, π], then a fixed-length Taylor series. */
export function detCos(x: number): number {
  let r = x - 2 * PI * Math.round(x / (2 * PI));
  let sign = 1;
  if (r < 0) r = -r;
  if (r > PI / 2) {
    r = PI - r;
    sign = -1;
  }
  const r2 = r * r;
  let term = 1;
  let sum = 1;
  for (let i = 1; i <= 12; i++) {
    term = (-term * r2) / ((2 * i - 1) * (2 * i));
    sum += term;
  }
  return sign * sum;
}

export const DEG = PI / 180;
