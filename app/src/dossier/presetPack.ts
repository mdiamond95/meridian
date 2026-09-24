import { buildPack } from '../splitter/pack';
import type { Preset } from '../splitter/presets';
import { runSplit, type ScopeContext } from '../splitter/split';
import type { SplitterData } from '../splitter/data';
import type { CellTopology } from '../splitter/outline';
import { buildDossiers, buildSetAnalysis } from './dossier';
import { regionScores } from './score';

/**
 * One shipped preset, run and described: the pack `npm run presets` writes, and the pack the tests
 * regenerate to check the committed one. Both go through here so they cannot drift apart.
 */
export function buildPresetPack(
  preset: Preset,
  data: SplitterData,
  topo: CellTopology,
  context: ScopeContext = {},
) {
  const { prepared, result, finished } = runSplit(preset.spec, data, context);
  // Names that were chosen, not generated: a seeded region's capital, and every carved metro.
  const manualNames: Record<number, string> = {};
  const solverRegions = finished.regions.length - prepared.carved.length;
  prepared.carved.forEach((cma, i) => (manualNames[solverRegions + i] = cma.name));
  if (preset.spec.method === 'seeded') {
    preset.spec.capitalNames?.forEach((name, i) => {
      if (i < solverRegions) manualNames[i] = name;
    });
  }
  const input = {
    data,
    topo,
    prepared,
    assignment: finished.assignment,
    regionCount: finished.regions.length,
    manualNames,
  };
  const { dossiers, aggregates, names } = buildDossiers(input);
  const setAnalysis = buildSetAnalysis({
    ...input,
    aggregates,
    names,
    pieces: finished.regions.map((r) => r.pieces),
  });
  const scores = regionScores({ data, prepared, assignment: finished.assignment, aggregates, dossiers });
  const pack = buildPack(preset.spec, finished.assignment, finished.regions, data.meshVersion, {
    dossiers,
    setAnalysis,
    scores,
    id: preset.id,
  });
  return { prepared, result, finished, dossiers, setAnalysis, scores, pack };
}
