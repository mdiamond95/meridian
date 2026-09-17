import type { Scope } from '../../schema/regionPack';
import { defaultParams, type Params } from '../solver';

/**
 * The determinism gate (docs/plan.md, Phase 3): these runs must give the same assignment bytes in
 * Chromium, WebKit and Firefox, and in Node. tests/determinism runs them in the three browsers;
 * src/engine/determinism.test.ts runs them in Node. Both assert src/engine/golden/cross-engine.json.
 */
export interface DeterminismCase {
  label: string;
  scope: Scope;
  params: Params;
  seed: number;
}

export const DETERMINISM_CASES: DeterminismCase[] = [
  {
    label: 'alberta-bisect-15',
    scope: { kind: 'province', province: 'AB' },
    params: defaultParams(15, 'lens'),
    seed: 20260917,
  },
  {
    label: 'canada-equal-population-10',
    scope: { kind: 'canada' },
    params: defaultParams(10, 'balanced'),
    seed: 20260917,
  },
];
