import type { SplitterData } from './data';

/**
 * Compare mode (vision §6): two splits side by side, and what actually moved between them.
 *
 * Regions are matched by overlap, greedily and largest first, so "reassigned" means cells that
 * changed hands between matched regions rather than cells whose region happens to have a different
 * number. Actual Canada — the provinces and territories — is always available as the other side.
 */

export interface ComparableSplit {
  /** region id per mesh cell, -1 outside */
  assignment: Int32Array;
  names: string[];
}

export interface Difference {
  cells: number;
  cellsReassigned: number;
  populationMoved: number;
  /** matched pairs, largest overlap first */
  matches: {
    a: number;
    b: number;
    nameA: string;
    nameB: string;
    sharedCells: number;
    sharedPopulation: number;
  }[];
  onlyInA: string[];
  onlyInB: string[];
  metrosSplitA: string[];
  metrosSplitB: string[];
}

export function actualCanada(data: SplitterData): ComparableSplit {
  const names = [...new Set(data.provinces)].sort();
  return { assignment: Int32Array.from(data.provinces, (p) => names.indexOf(p)), names };
}

export function compareSplits(a: ComparableSplit, b: ComparableSplit, data: SplitterData): Difference {
  const population = data.columns.population;
  const overlapCells = new Map<number, number>();
  const overlapPopulation = new Map<number, number>();
  const key = (x: number, y: number) => x * 10000 + y;
  let cells = 0;
  for (let cell = 0; cell < a.assignment.length; cell++) {
    const x = a.assignment[cell];
    const y = b.assignment[cell];
    if (x < 0 || y < 0) continue;
    cells++;
    overlapCells.set(key(x, y), (overlapCells.get(key(x, y)) ?? 0) + 1);
    overlapPopulation.set(
      key(x, y),
      (overlapPopulation.get(key(x, y)) ?? 0) + (population ? population[cell] : 0),
    );
  }

  const pairs = [...overlapCells]
    .map(([k, count]) => ({
      a: Math.floor(k / 10000),
      b: k % 10000,
      count,
      people: overlapPopulation.get(k) ?? 0,
    }))
    .sort((p, q) => q.count - p.count || p.a - q.a || p.b - q.b);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const matches: Difference['matches'] = [];
  for (const pair of pairs) {
    if (usedA.has(pair.a) || usedB.has(pair.b)) continue;
    usedA.add(pair.a);
    usedB.add(pair.b);
    matches.push({
      a: pair.a,
      b: pair.b,
      nameA: a.names[pair.a] ?? `Region ${pair.a + 1}`,
      nameB: b.names[pair.b] ?? `Region ${pair.b + 1}`,
      sharedCells: pair.count,
      sharedPopulation: Math.round(pair.people),
    });
  }
  const matchedA = new Map(matches.map((m) => [m.a, m.b]));
  let cellsReassigned = 0;
  let populationMoved = 0;
  for (let cell = 0; cell < a.assignment.length; cell++) {
    const x = a.assignment[cell];
    const y = b.assignment[cell];
    if (x < 0 || y < 0) continue;
    if (matchedA.get(x) !== y) {
      cellsReassigned++;
      populationMoved += population ? population[cell] : 0;
    }
  }

  const metros = (split: ComparableSplit) =>
    data.cmas
      .filter(
        (cma) => new Set(cma.cells.map((cell) => split.assignment[cell]).filter((r) => r >= 0)).size > 1,
      )
      .map((cma) => cma.name);

  return {
    cells,
    cellsReassigned,
    populationMoved: Math.round(populationMoved),
    matches,
    onlyInA: a.names.filter((_, i) => !usedA.has(i)),
    onlyInB: b.names.filter((_, i) => !usedB.has(i)),
    metrosSplitA: metros(a),
    metrosSplitB: metros(b),
  };
}
