import { buildPack } from '../splitter/pack';
import type { Preset } from '../splitter/presets';
import { runSplit } from '../splitter/split';
import type { SplitterData } from '../splitter/data';
import type { CellTopology } from '../splitter/outline';
import { buildDossiers, buildSetAnalysis } from './dossier';

/**
 * One shipped preset, run and described: the pack `npm run presets` writes, and the pack the tests
 * regenerate to check the committed one. Both go through here so they cannot drift apart.
 */
export function buildPresetPack(preset: Preset, data: SplitterData, topo: CellTopology) {
  const { prepared, result, finished } = runSplit(preset.spec, data);
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
  const pack = buildPack(preset.spec, finished.assignment, finished.regions, data.meshVersion, {
    dossiers,
    setAnalysis,
  });
  return { prepared, result, finished, dossiers, setAnalysis, pack };
}
