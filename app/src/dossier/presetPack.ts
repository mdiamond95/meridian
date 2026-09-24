import { buildPack } from '../splitter/pack';
import type { Preset } from '../splitter/presets';
import { describe, manualNamesFor } from '../splitter/land';
import { runSplit, type ScopeContext } from '../splitter/split';
import type { SplitterData } from '../splitter/data';
import type { CellTopology } from '../splitter/outline';

/**
 * One shipped preset, run and described: the pack `npm run presets` writes, and the pack the tests
 * regenerate to check the committed one. Both go through here, and describe the split with the same
 * function the worker uses (src/splitter/land.ts), so the three cannot drift apart.
 */
export function buildPresetPack(
  preset: Preset,
  data: SplitterData,
  topo: CellTopology,
  context: ScopeContext = {},
) {
  const { prepared, result, finished } = runSplit(preset.spec, data, context);
  const { dossiers, setAnalysis, scores } = describe(
    data,
    topo,
    prepared,
    finished.assignment,
    finished.regions,
    manualNamesFor(prepared, finished.regions, false),
  );
  const pack = buildPack(preset.spec, finished.assignment, finished.regions, data.meshVersion, {
    dossiers,
    setAnalysis,
    scores,
    id: preset.id,
    premise: preset.premise,
  });
  return { prepared, result, finished, dossiers, setAnalysis, scores, pack };
}
