import type { SolveResult } from '../engine/solver';
import { buildDossiers, buildSetAnalysis } from '../dossier/dossier';
import { regionScores } from '../dossier/score';
import type { RegionDossier, SetAnalysis } from '../schema/dossier';
import type { RegionScore } from '../schema/regionPack';
import type { SplitterData } from './data';
import { encodeRings, regionRings, type CellTopology, type EncodedRings } from './outline';
import { regionColours } from './palette';
import { packId } from './tree';
import { finishSplit, ruleNames, type NamedRegion, type PreparedSplit } from './split';

/**
 * What happens to a split between the solver finishing and the map showing it (release 1.0.1): name
 * the regions, colour them, write the dossiers, the set analysis and the scores, and dissolve the
 * rings to draw. All of it runs in the worker (src/engine/protocol.ts), which holds its own copy of the
 * splitter data and the cell topology, so the main thread only stores the result and draws it.
 */

export interface Described {
  dossiers: RegionDossier[];
  setAnalysis: SetAnalysis;
  scores: RegionScore[];
  /** each region's final name: the dossier's, which may differ from the solver-stage name */
  names: string[];
}

/** Names that were chosen rather than generated: a seeded region's capital, and every carved metro. */
export function manualNamesFor(
  prepared: PreparedSplit,
  regions: Pick<NamedRegion, 'id' | 'name'>[],
  template: boolean,
): Record<number, string> {
  const manualNames: Record<number, string> = {};
  const solverRegions = regions.length - prepared.carved.length;
  prepared.carved.forEach((cma, i) => (manualNames[solverRegions + i] = cma.name));
  if (template || prepared.spec.method === 'template') regions.forEach((r) => (manualNames[r.id] = r.name));
  if (prepared.spec.method === 'seeded') {
    prepared.spec.capitalNames?.forEach((name, i) => {
      if (i < solverRegions) manualNames[i] = name;
    });
  }
  return manualNames;
}

/** Dossiers, set analysis and scores for an assignment (formerly controller.describeSplit). */
export function describe(
  data: SplitterData,
  topo: CellTopology,
  prepared: PreparedSplit,
  assignment: Int32Array,
  regions: Pick<NamedRegion, 'id' | 'name' | 'pieces'>[],
  manualNames: Record<number, string>,
): Described {
  // A spec's naming rule (nameBy) names regions the manual names above leave to the generator.
  const named = {
    ...ruleNames(prepared.spec, data, assignment, regions.length - prepared.carved.length),
    ...manualNames,
  };
  const input = { data, topo, prepared, assignment, regionCount: regions.length, manualNames: named };
  const { dossiers, aggregates, names } = buildDossiers(input);
  const setAnalysis = buildSetAnalysis({ ...input, aggregates, names, pieces: regions.map((r) => r.pieces) });
  const scores = regionScores({ data, prepared, assignment, aggregates, dossiers });
  return { dossiers, setAnalysis, scores, names: regions.map((r, i) => dossiers[i]?.name ?? r.name) };
}

export interface Landed extends Described {
  assignment: Int32Array;
  /** named with their final (dossier) names */
  regions: NamedRegion[];
  colours: string[];
  rings: EncodedRings;
  /** the split's node id in a nesting tree (packId), hashed here rather than on the main thread */
  nodeId: string;
}

/** A solver result made ready to show: everything the main thread would otherwise compute. */
export function land(
  data: SplitterData,
  topo: CellTopology,
  prepared: PreparedSplit,
  result: Pick<SolveResult, 'assignment' | 'regions'>,
): Landed {
  const finished = finishSplit(prepared, result, data);
  const described = describe(
    data,
    topo,
    prepared,
    finished.assignment,
    finished.regions,
    manualNamesFor(prepared, finished.regions, false),
  );
  return {
    ...described,
    assignment: finished.assignment,
    regions: finished.regions.map((r, i) => ({ ...r, name: described.names[i] })),
    colours: regionColours(prepared.scopeGraph, finished.assignment, finished.regions.length),
    rings: encodeRings(regionRings(topo, finished.assignment)),
    nodeId: packId(prepared.spec, finished.assignment),
  };
}
