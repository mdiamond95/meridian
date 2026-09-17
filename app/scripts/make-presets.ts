/**
 * Regenerate the shipped presets in app/public/packs/ from src/splitter/presets.ts.
 *
 *   npm run presets
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildPresetPack } from '../src/dossier/presetPack';
import { TopologySchema } from '../src/schema/topojson';
import { cellTopology } from '../src/splitter/outline';
import { PRESETS } from '../src/splitter/presets';
import { realSplitterData } from '../src/splitter/testing/realSplitterData';

const out = new URL('../public/packs/', import.meta.url);
const data = realSplitterData();
const topo = cellTopology(
  TopologySchema.parse(
    JSON.parse(
      gunzipSync(readFileSync(new URL('../../data/build/cells.v1.topojson.gz', import.meta.url))).toString(
        'utf8',
      ),
    ),
  ),
);
for (const preset of PRESETS) {
  const started = Date.now();
  const { result, finished, dossiers, setAnalysis, pack } = buildPresetPack(preset, data, topo);
  writeFileSync(new URL(`${preset.id}.json`, out), JSON.stringify(pack) + '\n');
  const pops = finished.regions.map((r) => r.population);
  console.log(
    `${preset.id}: ${finished.regions.length} regions in ${Date.now() - started} ms (${result.stoppedBy}), ` +
      `population max/min ${(Math.max(...pops) / Math.min(...pops)).toFixed(2)}, ` +
      `pieces max ${Math.max(...finished.regions.map((r) => r.pieces))}`,
  );
  console.log('  ' + dossiers.map((d) => d.name).join(' · '));
  console.log(
    `  federalism: ${setAnalysis.federalism.map((f) => `${f.id}=${f.verdict}`).join(' ')}; reconciles ${setAnalysis.reconciliation.ok}`,
  );
}

const library = {
  format: 'meridian.packLibrary',
  packs: PRESETS.map(({ id, name, description }) => ({ id, name, description, file: `${id}.json` })),
};
writeFileSync(new URL('index.json', out), JSON.stringify(library, null, 2) + '\n');
