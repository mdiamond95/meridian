// @vitest-environment node
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { UnitTableSchema, type UnitTable } from './unitTable';

/** The committed riding table parses with the Zod contract, which pytest checks through the export too. */
const table = JSON.parse(
  gunzipSync(readFileSync(new URL('../../../data/build/ridings.v1.json.gz', import.meta.url))).toString(
    'utf8',
  ),
) as UnitTable;
const issues = (doc: UnitTable) => UnitTableSchema.safeParse(doc).error?.issues.map((i) => i.message) ?? [];

describe('UnitTable', () => {
  it('parses data/build/ridings.v1.json.gz', () => {
    expect(issues(table)).toEqual([]);
    expect(table.rows).toHaveLength(343);
  });

  it('refuses a one-sided neighbour, unsorted places and a gap in the jurisdictions', () => {
    const doc = structuredClone(table);
    const [a, b] = doc.rows;
    b.neighbours = b.neighbours.filter((n) => n !== a.id);
    a.neighbours = [...new Set([...a.neighbours, b.id])].sort((x, y) => x - y);
    doc.rows.filter((r) => r.places.length > 1)[0].places.reverse();
    const spans = doc.rows.filter((r) => r.jurisdictions.length > 1)[0].jurisdictions;
    spans[1] = { ...spans[1], from: '1866-01-01' };
    expect(issues(doc)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/does not list/),
        expect.stringMatching(/places not sorted/),
        expect.stringMatching(/not contiguous/),
      ]),
    );
  });

  it('carries the GDP caveat and no cohesion score', () => {
    expect(table.gdpCaveat).toMatch(/not a measurement/);
    expect(table.rows.every((r) => !('cohesion' in r.score))).toBe(true);
  });
});
