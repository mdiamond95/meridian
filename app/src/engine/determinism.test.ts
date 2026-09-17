// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { solve } from './solver';
import { DETERMINISM_CASES } from './testing/determinismCases';
import { graphFor, realData } from './testing/realData';

// The Node leg of the cross-engine gate; the browsers' leg is tests/determinism/engines.spec.ts.
// Regenerate with UPDATE_GOLDEN=1 npx vitest run src/engine/determinism.test.ts.
const GOLDEN = new URL('./golden/cross-engine.json', import.meta.url);

describe('determinism cases', () => {
  it('match the cross-engine golden hashes in Node', () => {
    const data = realData();
    const hashes: Record<string, string> = {};
    for (const c of DETERMINISM_CASES) {
      const result = solve({
        mesh: data.mesh,
        graph: graphFor(data, c.scope),
        columns: data.columns,
        params: c.params,
        seed: c.seed,
      });
      expect(result.stoppedBy).not.toBe('time');
      hashes[c.label] = createHash('sha256').update(Buffer.from(result.assignment.buffer)).digest('hex');
    }
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, JSON.stringify(hashes, null, 2) + '\n');
    expect(hashes).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  }, 60_000);
});
