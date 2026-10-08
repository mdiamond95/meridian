// @vitest-environment node
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { UnitTableSchema, type HexTable, type RidingTable, type UnitTable } from './unitTable';

/** The committed unit tables parse with the Zod contract, which pytest checks through the export too. */
const read = <T>(name: string) =>
  JSON.parse(
    gunzipSync(readFileSync(new URL(`../../../data/build/${name}`, import.meta.url))).toString('utf8'),
  ) as T;
const ridings = read<RidingTable>('ridings.v1.json.gz');
const hexes = read<HexTable>('hexes.r4.v1.json.gz');
const issues = (doc: UnitTable) => UnitTableSchema.safeParse(doc).error?.issues.map((i) => i.message) ?? [];

describe('UnitTable fed_2023', () => {
  it('parses data/build/ridings.v1.json.gz', () => {
    expect(issues(ridings)).toEqual([]);
    expect(ridings.rows).toHaveLength(343);
  });

  it('refuses a one-sided neighbour, unsorted places and a gap in the jurisdictions', () => {
    const doc = structuredClone(ridings);
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
    expect(ridings.gdpCaveat).toMatch(/not a measurement/);
    expect(ridings.rows.every((r) => !('cohesion' in r.score))).toBe(true);
  });
});

describe('UnitTable h3_r4', () => {
  it('parses data/build/hexes.r4.v1.json.gz', () => {
    expect(issues(hexes)).toEqual([]);
    expect(hexes.rows).toHaveLength(6011);
    expect(hexes.rows.reduce((sum, r) => sum + r.population, 0)).toBe(36_991_981);
  });

  it('refuses a neighbour listed with different kinds each way, and an unknown CSD type', () => {
    const doc = structuredClone(hexes);
    const row = doc.rows.find((r) => r.neighbours.some((n) => n.kind === 'land'));
    if (!row) throw new Error('no land link');
    const link = row.neighbours.find((n) => n.kind === 'land');
    if (link) link.kind = 'water';
    doc.rows.filter((r) => r.places.length > 0)[0].places[0].csdType = 'XX';
    expect(issues(doc)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/another kind/),
        expect.stringMatching(/not in lookups/),
      ]),
    );
  });

  it('is not a riding table: the unit decides the row shape', () => {
    const doc = structuredClone(hexes) as unknown as RidingTable;
    (doc as { unit: string }).unit = 'fed_2023';
    expect(UnitTableSchema.safeParse(doc).success).toBe(false);
  });
});
