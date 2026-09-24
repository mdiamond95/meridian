/**
 * Compile docs/scenarios/*.yaml to src/scenario/scenarios.json, which the app imports.
 *
 *   npm run scenarios          write the file
 *   npm run scenarios:check    exit 1 if it is stale (CI)
 *
 * The YAML is the source: one file per scenario, with its premise and cited overlay events. Each is
 * validated against the Scenario schema here, so a malformed scenario fails the build, not the page.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ScenarioSchema } from '../src/schema/scenario';

const dir = new URL('../../docs/scenarios/', import.meta.url);
const jsonPath = new URL('../src/scenario/scenarios.json', import.meta.url);
const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith('.yaml'))
  .sort()
  .map((file) => {
    const scenario = ScenarioSchema.parse(parse(readFileSync(new URL(file, dir), 'utf8')));
    if (`${scenario.id}.yaml` !== file)
      throw new Error(`${file}: id ${scenario.id} does not match the file name`);
    return scenario;
  });
const text = JSON.stringify(scenarios, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(jsonPath, 'utf8');
  } catch {
    // missing counts as stale
  }
  if (current !== text) {
    console.error('stale: src/scenario/scenarios.json — run npm run scenarios');
    process.exit(1);
  }
} else {
  writeFileSync(jsonPath, text);
  console.log(`wrote src/scenario/scenarios.json (${scenarios.length} scenarios)`);
}
