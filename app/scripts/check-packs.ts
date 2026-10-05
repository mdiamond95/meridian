/**
 * CI: published packs are immutable (docs/interop.md, versioning rule 7). Every file under packs/ at
 * the previous release tag must still be there with the same content (canonical JSON), except
 * packs/index.json. The previous release is the newest v<digit>* tag before HEAD; pass a tag to
 * compare with another.
 *
 *   npm run packs:check [-- v1.0.1]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { immutabilityViolations, LIBRARY_FILE, packContent } from '../src/import/packFiles';

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
if (violations.length) process.exit(1);
const count = [...released.keys()].filter((f) => f !== LIBRARY_FILE).length;
console.log(`packs/: the ${count} packs published in ${tag} are unchanged`);
