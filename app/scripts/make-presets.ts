/**
 * Regenerate the shipped presets in app/public/packs/ from src/splitter/presets.ts.
 *
 *   npm run presets
 */
import { writeFileSync } from 'node:fs';
import { buildPack } from '../src/splitter/pack';
import { PRESETS } from '../src/splitter/presets';
import { runSplit } from '../src/splitter/split';
import { realSplitterData } from '../src/splitter/testing/realSplitterData';

const out = new URL('../public/packs/', import.meta.url);
const data = realSplitterData();
for (const preset of PRESETS) {
  const started = Date.now();
  const { result, finished } = runSplit(preset.spec, data);
  const pack = buildPack(preset.spec, finished.assignment, finished.regions, data.meshVersion);
  writeFileSync(new URL(`${preset.id}.json`, out), JSON.stringify(pack) + '\n');
  const pops = finished.regions.map((r) => r.population);
  console.log(
    `${preset.id}: ${finished.regions.length} regions in ${Date.now() - started} ms (${result.stoppedBy}), ` +
      `population max/min ${(Math.max(...pops) / Math.min(...pops)).toFixed(2)}, ` +
      `pieces max ${Math.max(...finished.regions.map((r) => r.pieces))}`,
  );
  console.log('  ' + finished.regions.map((r) => r.name).join(' · '));
}
const library = {
  format: 'meridian.packLibrary',
  packs: PRESETS.map(({ id, name, description }) => ({ id, name, description, file: `${id}.json` })),
};
writeFileSync(new URL('index.json', out), JSON.stringify(library, null, 2) + '\n');
