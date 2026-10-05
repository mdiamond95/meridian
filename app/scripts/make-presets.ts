/**
 * Regenerate the shared presets in the top-level packs/ folder from src/splitter/presets.ts, named
 * <id>.<meshVersion>.json (docs/interop.md). Published packs are immutable: a preset whose pack comes
 * out different goes to the next <id>.<meshVersion>.<n>.json, the old file stays, and index.json
 * points at the new one.
 *
 *   npm run presets
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildPresetPack } from '../src/dossier/presetPack';
import { choosePackFile } from '../src/import/packFiles';
import { TopologySchema } from '../src/schema/topojson';
import { cellTopology } from '../src/splitter/outline';
import { PRESETS } from '../src/splitter/presets';
import { realAtlas, realSplitterData } from '../src/splitter/testing/realSplitterData';

const out = new URL('../../packs/', import.meta.url);
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
const files = new Map(
  readdirSync(out)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, readFileSync(new URL(f, out), 'utf8')] as const),
);
const library = { format: 'meridian.packLibrary', packs: [] as object[] };
for (const preset of PRESETS) {
  const started = Date.now();
  const { result, finished, dossiers, setAnalysis, pack } = buildPresetPack(preset, data, topo, {
    atlas: realAtlas(),
  });
  const text = JSON.stringify(pack) + '\n';
  const file = choosePackFile(files, preset.id, data.meshVersion, text);
  if (!files.has(file)) {
    writeFileSync(new URL(file, out), text);
    files.set(file, text);
    console.log(`${file}: new file`);
  }
  library.packs.push({ id: preset.id, name: preset.name, description: preset.description, file });
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

writeFileSync(new URL('index.json', out), JSON.stringify(library, null, 2) + '\n');
