/**
 * Export JSON Schema for every contract in src/schema to docs/schemas/.
 *
 *   npm run schemas          write the files
 *   npm run schemas:check    exit 1 if the committed files are stale (used in CI)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AtlasFileSchema } from '../src/schema/atlas';
import { AttrsFileSchema } from '../src/schema/attrs';
import { ContactFileSchema } from '../src/schema/contact';
import { IndigenousFileSchema } from '../src/schema/indigenous';
import { MeshFileSchema } from '../src/schema/mesh';
import { PlacesFileSchema, SnapFileSchema } from '../src/schema/places';
import { RegionPackSchema } from '../src/schema/regionPack';
import { ScenarioSchema } from '../src/schema/scenario';
import { TopologySchema } from '../src/schema/topojson';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/schemas');
const check = process.argv.includes('--check');

const contracts = {
  'mesh.schema.json': MeshFileSchema,
  'attrs.schema.json': AttrsFileSchema,
  'atlas.schema.json': AtlasFileSchema,
  'contact.schema.json': ContactFileSchema,
  'indigenous.schema.json': IndigenousFileSchema,
  'places.schema.json': PlacesFileSchema,
  'snap.schema.json': SnapFileSchema,
  'regionPack.schema.json': RegionPackSchema,
  'scenario.schema.json': ScenarioSchema,
  'topojson.schema.json': TopologySchema,
};

let stale = 0;
mkdirSync(outDir, { recursive: true });
for (const [file, schema] of Object.entries(contracts)) {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12' });
  const text = JSON.stringify(json, null, 2) + '\n';
  const path = resolve(outDir, file);
  if (check) {
    let current = '';
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      // missing counts as stale
    }
    if (current !== text) {
      console.error(`stale: docs/schemas/${file} — run npm run schemas`);
      stale++;
    }
  } else {
    writeFileSync(path, text);
    console.log(`wrote docs/schemas/${file}`);
  }
}
process.exit(stale ? 1 : 0);
