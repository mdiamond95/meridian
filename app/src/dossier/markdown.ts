import type { RegionDossier, SetAnalysis } from '../schema/dossier';
import { BORDERS_HEADING, dossierFacts, KILL_HEADING, nameLine, pct, SAVE_HEADING } from './fields';

/**
 * The whole set as Markdown (vision §7), so a split drops straight into a writing project: the set
 * analysis, then every region's dossier in the Region panel's order.
 *
 * Draft lines keep their ⟨draft⟩ mark: a reader should see at a glance which sentences are templates.
 */

const fmt = new Intl.NumberFormat('en-CA');

function table(rows: string[][]): string {
  if (!rows.length) return '';
  const header = rows[0];
  const body = rows.slice(1);
  return [
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/** One region, in the order the Region panel shows it (src/dossier/fields.ts). */
export function dossierMarkdown(dossier: RegionDossier): string {
  const lines: string[] = [];
  lines.push(`## ${dossier.name}`);
  lines.push('');
  lines.push(`*${nameLine(dossier)}*`);
  lines.push('');
  lines.push(dossier.oneSentence.text);
  lines.push('');
  lines.push(dossier.characterLine.text);
  lines.push('');
  lines.push(
    table([
      ['', ''],
      ...dossierFacts(dossier).map((f) => [f.label, f.note ? `${f.value} — ${f.note}` : f.value]),
    ]),
  );
  lines.push('');
  lines.push(`**${BORDERS_HEADING}.**`);
  lines.push('');
  for (const line of dossier.bordersInWords) lines.push(`- ${line}`);
  lines.push('');
  lines.push(`**${KILL_HEADING}.** ${dossier.whatWouldKillIt.text}`);
  lines.push('');
  lines.push(`**${SAVE_HEADING}.** ${dossier.whatWouldSaveIt.text}`);
  lines.push('');
  return lines.join('\n');
}

export function setMarkdown(set: SetAnalysis, dossiers: RegionDossier[], title = 'Meridian split'): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`${set.regions} regions over ${set.scope}. ${set.gdpCaveat}`);
  lines.push('');
  lines.push('## Power ranking');
  lines.push('');
  lines.push(
    table([
      ['Rank', 'Region', 'Economic leverage', 'Chokepoints', 'Resource ownership', 'Score'],
      ...set.powerRanking.map((row) => [
        String(row.rank),
        row.name,
        pct(row.economicLeverage),
        String(row.chokepoints),
        pct(row.resourceOwnership),
        String(row.score),
      ]),
    ]),
  );
  lines.push('');
  lines.push('## The set');
  lines.push('');
  lines.push(
    table([
      ['', ''],
      [
        'Largest to smallest population',
        set.ratios.population === null ? '—' : String(set.ratios.population),
      ],
      ['Largest to smallest area', set.ratios.area === null ? '—' : String(set.ratios.area)],
      ['Largest to smallest GDP (estimate)', set.ratios.gdp === null ? '—' : String(set.ratios.gdp)],
      [
        'Metros split',
        set.metrosSplit.length
          ? set.metrosSplit.map((m) => `${m.name} (${m.regions.length} regions)`).join('; ')
          : 'none',
      ],
      [
        'Population reconciliation',
        `${fmt.format(set.reconciliation.population.regions)} against ${fmt.format(set.reconciliation.population.scope)} in the scope (difference ${set.reconciliation.population.difference})`,
      ],
      [
        'GDP reconciliation',
        `${fmt.format(set.reconciliation.gdp.regions)} against ${fmt.format(set.reconciliation.gdp.scope)} (difference ${set.reconciliation.gdp.difference})`,
      ],
      ['Reconciles', set.reconciliation.ok ? 'yes' : 'no'],
    ]),
  );
  lines.push('');
  if (set.contiguityLog.length) {
    lines.push('## Contiguity compromises');
    lines.push('');
    for (const row of set.contiguityLog) lines.push(`- ${row.name}: ${row.note}`);
    lines.push('');
  }
  lines.push('## What it would break in the federation');
  lines.push('');
  for (const finding of set.federalism) {
    lines.push(`### ${finding.title} — ${finding.verdict}`);
    lines.push('');
    lines.push(finding.detail);
    lines.push('');
    lines.push(`*${finding.citation}* — <${finding.url}>`);
    lines.push('');
  }
  lines.push('## Regions');
  lines.push('');
  for (const dossier of dossiers) lines.push(dossierMarkdown(dossier));
  return lines.join('\n');
}
