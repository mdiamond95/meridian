import type { RegionDossier } from '../schema/dossier';

/**
 * The dossier's facts in the order the Region panel shows them. The panel and the Markdown export both
 * render this list, so the two cannot drift apart (plan Phase 5: the export reproduces the panel).
 */

const fmt = new Intl.NumberFormat('en-CA');
export const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

export interface DossierFact {
  label: string;
  value: string;
  /** a qualifier shown after the value: the GDP caveat, "hypothetical" */
  note?: string;
}

export function dossierFacts(d: RegionDossier): DossierFact[] {
  const facts: DossierFact[] = [
    {
      label: 'Population',
      value: `${fmt.format(d.population)} (${d.growth2016to2021 >= 0 ? '+' : ''}${pct(d.growth2016to2021)} since 2016)`,
    },
    { label: 'Area', value: `${fmt.format(d.areaKm2)} km² · ${d.densityPerKm2} per km²` },
    {
      label: 'GDP (estimate)',
      value:
        (d.gdpCadMillions === null ? '—' : `$${fmt.format(d.gdpCadMillions)} M`) +
        (d.gdpPerCapita === null ? '' : ` · $${fmt.format(d.gdpPerCapita)} per person`),
      note: d.gdpCaveat,
    },
    {
      label: 'Capital (largest place)',
      value: d.capital ? `${d.capital.name} (${fmt.format(d.capital.population)})` : '—',
    },
    {
      label: 'Other cities',
      value: [...d.mainCities, ...d.secondaryCities].map((c) => c.name).join(', ') || '—',
    },
    {
      label: 'Industries',
      value: d.primaryIndustries.map((i) => `${i.label} ${pct(i.share)}`).join('; ') || '—',
    },
    { label: 'Urban share', value: pct(d.urbanShare) },
    { label: 'Internal-colony index', value: String(d.internalColonyIndex) },
    {
      label: 'Mean distance to the provincial capital',
      value: `${fmt.format(d.distanceToCapitalKmMean)} km`,
    },
    {
      label: 'Languages',
      value:
        `English ${pct(d.languages.english)} · French ${pct(d.languages.french)} · ` +
        `Indigenous ${pct(d.languages.indigenous)} · other ${pct(d.languages.other)}`,
    },
    {
      label: 'Indigenous identity',
      value:
        pct(d.indigenous.identityShare) +
        (d.indigenous.languageFamilies.length
          ? ` · ${d.indigenous.languageFamilies.map((f) => `${f.label} ${pct(f.share)}`).join(', ')}`
          : ''),
    },
    {
      label: 'Treaty composition',
      value: d.treatyComposition.map((t) => `${t.label} ${pct(t.share)}`).join('; ') || '—',
    },
    {
      label: 'Governing party',
      value: `${d.governingParty.party} (${pct(d.governingParty.share)})`,
      note: 'hypothetical',
    },
  ];
  if (d.rivalRegion) {
    facts.push({ label: 'Rival', value: `${d.rivalRegion.name} (similarity ${d.rivalRegion.similarity})` });
  }
  return facts;
}

export const nameLine = (d: RegionDossier) =>
  `${d.nameSource === 'manual' ? 'Named by hand' : 'Named after'} ${d.nameReason}.`;

export const BORDERS_HEADING = 'Borders, clockwise from the north-west';
export const KILL_HEADING = 'What would kill it';
export const SAVE_HEADING = 'What would save it';
