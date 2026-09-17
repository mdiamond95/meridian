/**
 * mulberry32 and the helpers the solver draws from (plan Phase 3: no Math.random anywhere).
 *
 * The generator is the canonical mulberry32 (Tommy Ettinger's, as published and as used by the
 * township generator): 32-bit state, Math.imul and unsigned shifts only, so the sequence is the same
 * on every engine. src/engine/fixtures/mulberry32.json pins the first values for a few seeds; the
 * township generator should assert the same file.
 */

export interface Prng {
  /** Next uint32. */
  nextUint32(): number;
  /** Next float in [0, 1), from one uint32. */
  next(): number;
  /** Integer in [0, n). */
  int(n: number): number;
}

export function mulberry32(seed: number): Prng {
  let state = seed >>> 0;
  const nextUint32 = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  return {
    nextUint32,
    next: () => nextUint32() / 4294967296,
    // Multiply-shift rather than modulo; n is far below 2^21 here, so the product stays exact.
    int: (n: number) => Math.floor((nextUint32() / 4294967296) * n),
  };
}

/** Fisher–Yates in place, drawing from `rng`. */
export function shuffle<T>(items: T[], rng: Prng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
