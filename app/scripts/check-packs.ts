/**
 * CI: published packs and unit tables are immutable (docs/interop.md, versioning rule 7). Every file
 * under packs/ at the previous release tag must still be there with the same content (canonical JSON),
 * except packs/index.json; so must every unit table under data/build/ and the layer its meta.layer names
 * (gzipped, compared decompressed).
 * The previous release is the newest v<digit>* tag before HEAD; pass a tag to compare with another.
 *
 *   npm run packs:check [-- v1.0.1]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  immutabilityViolations,
  isUnitTable,
  LIBRARY_FILE,
  packContent,
  unitTableLayer,
} from '../src/import/packFiles';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });

const tag = process.argv[2] ?? git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD^').trim();

const released = new Map(
  git('ls-tree', '--name-only', `${tag}:packs`)
    .split('\n')
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, git('show', `${tag}:packs/${f}`)] as const),
);
const now = new Map(
  readdirSync(`${root}packs`)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, readFileSync(`${root}packs/${f}`, 'utf8')] as const),
);

const short = (text: string) => createHash('sha256').update(packContent(text)).digest('hex').slice(0, 12);
const hashes = (files: Map<string, string>) => new Map([...files].map(([f, text]) => [f, short(text)]));
const violations = immutabilityViolations(released, now);
const [was, is] = [hashes(released), hashes(now)];
for (const { file, problem } of violations) {
  console.error(
    problem === 'deleted'
      ? `packs/${file}: deleted, but it was published in ${tag} (${was.get(file)})`
      : `packs/${file}: changed since ${tag} (${was.get(file)} → ${is.get(file)}); ` +
          'write the regeneration to a new numbered file (npm run presets does) and keep this one',
  );
}

// Unit tables: every gzipped JSON under data/build/ at the tag that is one, and the layer each names
// in meta.layer (the h3_r4 table's clipped hexagons). Keyed by repository path, compared decompressed.
const gitBytes = (spec: string) => execFileSync('git', ['show', spec], { cwd: root, maxBuffer: 1 << 30 });
const tables = new Map(
  git('ls-tree', '--name-only', `${tag}:data/build`)
    .split('\n')
    .filter((f) => f.endsWith('.json.gz'))
    .map((f) => [`data/build/${f}`, gunzipSync(gitBytes(`${tag}:data/build/${f}`)).toString('utf8')] as const)
    .filter(([, text]) => isUnitTable(text)),
);
const layers = [...tables.values()].map(unitTableLayer).filter((path): path is string => path !== null);
const immutable = new Map([
  ...tables,
  ...layers.map((path) => [path, gunzipSync(gitBytes(`${tag}:${path}`)).toString('utf8')] as const),
]);
const immutableNow = new Map(
  [...immutable.keys()]
    .filter((path) => existsSync(`${root}${path}`))
    .map((path) => [path, gunzipSync(readFileSync(`${root}${path}`)).toString('utf8')] as const),
);
const tableViolations = immutabilityViolations(immutable, immutableNow);
for (const { file, problem } of tableViolations) {
  console.error(
    problem === 'deleted'
      ? `${file}: deleted, but it was published in ${tag} (a unit table or its layer)`
      : `${file}: changed since ${tag}; write the rebuild to a new numbered file and keep this one`,
  );
}

if (violations.length || tableViolations.length) process.exit(1);
const count = [...released.keys()].filter((f) => f !== LIBRARY_FILE).length;
console.log(`packs/: the ${count} packs published in ${tag} are unchanged`);
console.log(
  `data/build/: the ${tables.size} unit tables and ${layers.length} layers published in ${tag} are unchanged`,
);
