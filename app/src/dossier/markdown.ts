import type { RegionDossier, SetAnalysis } from '../schema/dossier';

/**
 * The whole set as Markdown (vision §7), so a split drops straight into a writing project. Phase 5
 * exports it to a file; the panel offers it as a download.
 *
 * Draft lines keep their ⟨draft⟩ mark: a reader should see at a glance which sentences are templates.
 */

const fmt = new Intl.NumberFormat('en-CA');
const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

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

export function dossierMarkdown(dossier: RegionDossier): string {
  const lines: string[] = [];
  lines.push(`## ${dossier.name}`);
  lines.push('');
  lines.push(dossier.oneSentence.text);
  lines.push('');
  lines.push(`**Character.** ${dossier.characterLine.text}`);
  lines.push('');
  lines.push(
    table([
      ['', ''],
      ['Population', fmt.format(dossier.population)],
      ['Area', `${fmt.format(dossier.areaKm2)} km²`],
      ['Density', `${dossier.densityPerKm2} per km²`],
      [
        'GDP (estimate)',
        dossier.gdpCadMillions === null
          ? '—'
          : `$${fmt.format(dossier.gdpCadMillions)} M — ${dossier.gdpCaveat}`,
      ],
      [
        'GDP per person (estimate)',
        dossier.gdpPerCapita === null ? '—' : `$${fmt.format(dossier.gdpPerCapita)}`,
      ],
      ['Growth 2016–2021', pct(dossier.growth2016to2021)],
      ['Urban share', pct(dossier.urbanShare)],
      ['Internal-colony index', String(dossier.internalColonyIndex)],
      ['Mean distance to the provincial capital', `${fmt.format(dossier.distanceToCapitalKmMean)} km`],
      [
        'Capital (largest place)',
        dossier.capital ? `${dossier.capital.name} (${fmt.format(dossier.capital.population)})` : '—',
      ],
      [
        'Other cities',
        [...dossier.mainCities, ...dossier.secondaryCities].map((c) => c.name).join(', ') || '—',
      ],
      [
        'Hypothetical governing party',
        `${dossier.governingParty.party} (${pct(dossier.governingParty.share)} of people)`,
      ],
      ['Name', `${dossier.name} — ${dossier.nameReason} (${dossier.nameSource})`],
    ]),
  );
  lines.push('');
  lines.push(
    '**Industries.** ' +
      (dossier.primaryIndustries.map((i) => `${i.label} ${pct(i.share)}`).join('; ') || '—'),
  );
  lines.push('');
  lines.push(
    '**Language and identity.** ' +
      `English ${pct(dossier.languages.english)}, French ${pct(dossier.languages.french)}, ` +
      `Indigenous languages ${pct(dossier.languages.indigenous)}, other ${pct(dossier.languages.other)}. ` +
      `Indigenous identity ${pct(dossier.indigenous.identityShare)}` +
      (dossier.indigenous.languageFamilies.length
        ? ` (${dossier.indigenous.languageFamilies.map((f) => `${f.label} ${pct(f.share)}`).join(', ')})`
        : '') +
      '.',
  );
  lines.push('');
  lines.push(
    '**Treaty composition.** ' +
      (dossier.treatyComposition.map((t) => `${t.label} ${pct(t.share)}`).join('; ') ||
        'no treaty areas recorded'),
  );
  lines.push('');
  lines.push('**Borders, clockwise from the north-west.**');
  lines.push('');
  for (const line of dossier.bordersInWords) lines.push(`- ${line}`);
  lines.push('');
  if (dossier.rivalRegion) {
    lines.push(`**Rival.** ${dossier.rivalRegion.name} (similarity ${dossier.rivalRegion.similarity}).`);
    lines.push('');
  }
  lines.push(`**What would kill it.** ${dossier.whatWouldKillIt.text}`);
  lines.push('');
  lines.push(`**What would save it.** ${dossier.whatWouldSaveIt.text}`);
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
