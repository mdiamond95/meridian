/**
 * Compile src/dossier/federalism.yaml to federalism.rules.json, which the app imports.
 *
 *   npm run rules          write the file
 *   npm run rules:check    exit 1 if it is stale (CI)
 *
 * The YAML is the source: it is what a reader edits, and it carries a citation per rule. The JSON is
 * generated so the rules load the same way in the app, in Vitest and in the presets script.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const yamlPath = new URL('../src/dossier/federalism.yaml', import.meta.url);
const jsonPath = new URL('../src/dossier/federalism.rules.json', import.meta.url);
const text = JSON.stringify(parse(readFileSync(yamlPath, 'utf8')), null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(jsonPath, 'utf8');
  } catch {
    // missing counts as stale
  }
  if (current !== text) {
    console.error('stale: src/dossier/federalism.rules.json — run npm run rules');
    process.exit(1);
  }
} else {
  writeFileSync(jsonPath, text);
  console.log('wrote src/dossier/federalism.rules.json');
}
