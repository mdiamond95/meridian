/**
 * Compile the attribution strings in docs/data-sources.md into src/licences/licences.json, which the
 * app's Licences panel shows (plan Phase 7 §5).
 *
 *   npm run licences          write the file
 *   npm run licences:check    exit 1 if it is stale (CI)
 *
 * docs/data-sources.md is the source: every row of its "Pipeline inputs" and "Displayed in the app"
 * tables, with the row's licence and attribution columns. Rows that share an attribution string are
 * grouped under it, so the panel lists each string once with every source it covers.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const docPath = new URL('../../docs/data-sources.md', import.meta.url);
const jsonPath = new URL('../src/licences/licences.json', import.meta.url);

interface Source {
  id: string;
  name: string;
  licence: string;
  licenceUrl: string | null;
}

export interface Attribution {
  attribution: string;
  /** where the data is used: built into the artefacts, or displayed live */
  use: 'built' | 'displayed';
  sources: Source[];
}

/** The rows of the table under `heading`, as trimmed cells keyed by the header row's names. */
function table(markdown: string, heading: string): Record<string, string>[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`docs/data-sources.md: no "## ${heading}" section`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|')) {
      if (rows.length) break;
      continue;
    }
    const inner = line.replace(/^\|/, '').replace(/\|\s*$/, '');
    // The separator row is |---|---|; cells elsewhere are split on " | ", since URLs hold no spaces.
    rows.push((/^[-|: ]+$/.test(inner) ? inner.split('|') : inner.split(' | ')).map((c) => c.trim()));
  }
  const [header, rule, ...body] = rows;
  if (!header || !rule?.every((c) => /^-+$/.test(c))) throw new Error(`${heading}: not a table`);
  return body.map((cells, i) => {
    if (cells.length !== header.length)
      throw new Error(`${heading}, row ${i + 1}: ${cells.length} cells, header has ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, cells[j]]));
  });
}

const plain = (cell: string) => cell.replace(/`/g, '').replace(/\*\*/g, '').trim();

function licence(cell: string): { licence: string; licenceUrl: string | null } {
  const url = cell.match(/https?:\/\/\S+/)?.[0] ?? null;
  return { licence: plain(cell.replace(/,?\s*https?:\/\/\S+/, '')), licenceUrl: url };
}

function build(markdown: string): Attribution[] {
  const groups = new Map<string, Attribution>();
  const add = (use: Attribution['use'], attribution: string, source: Source) => {
    const key = `${use}|${attribution}`;
    const group = groups.get(key) ?? { attribution, use, sources: [] };
    group.sources.push(source);
    groups.set(key, group);
  };
  for (const row of table(markdown, 'Pipeline inputs')) {
    const id = plain(row.id);
    // The name is the source column's first sentence, without the reason it is fetched a certain way.
    const name = plain(row.source).split(/(?<=[a-z0-9)])\. /)[0];
    add('built', plain(row.attribution), { id, name, ...licence(row.licence) });
  }
  for (const row of table(markdown, 'Displayed in the app')) {
    const name = plain(row.Layer);
    add('displayed', plain(row.attribution), { id: name, name, ...licence(row.licence) });
  }
  // The Notes name one more string: the credit shown with NRCan's drawing where the atlas departs from it.
  const overlay = markdown.match(/attributed in the app: "([^"]+)"/)?.[1];
  if (!overlay) throw new Error("docs/data-sources.md: the NRCan drawing overlay's attribution is missing");
  add('displayed', overlay, {
    id: 'nrcan_te_*',
    name: "NRCan's Territorial Evolution drawing, shown where the atlas departs from it",
    licence: 'Open Government Licence – Canada',
    licenceUrl: null,
  });
  // A licence named with its URL on one row carries it on every row.
  const urls = new Map<string, string>();
  for (const group of groups.values())
    for (const source of group.sources) if (source.licenceUrl) urls.set(source.licence, source.licenceUrl);
  for (const group of groups.values())
    for (const source of group.sources) source.licenceUrl ??= urls.get(source.licence) ?? null;
  for (const group of groups.values()) {
    if (!group.attribution)
      throw new Error(`${group.sources.map((s) => s.id).join(', ')}: no attribution string`);
  }
  return [...groups.values()];
}

const text = JSON.stringify(build(readFileSync(docPath, 'utf8')), null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(jsonPath, 'utf8');
  } catch {
    // missing counts as stale
  }
  if (current !== text) {
    console.error('stale: src/licences/licences.json — run npm run licences');
    process.exit(1);
  }
} else {
  writeFileSync(jsonPath, text);
  console.log(`wrote src/licences/licences.json (${JSON.parse(text).length} attribution strings)`);
}
