import { downloadMarkdown } from '../splitter/controller';
import type { RegionDossier } from '../schema/dossier';
import { useSplitStore } from '../state/splitStore';

/** The selected region's dossier (vision §6). Every GDP number carries the allocation caveat. */
const fmt = new Intl.NumberFormat('en-CA');
const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

export function DossierPanel() {
  const split = useSplitStore((s) => s.split);
  const selected = useSplitStore((s) => s.selectedRegion);
  const selectRegion = useSplitStore((s) => s.selectRegion);

  if (!split) return <p className="placeholder">Generate a split first.</p>;
  if (!split.dossiers) return <p className="placeholder">Describing the regions…</p>;
  const dossier = selected === null ? null : split.dossiers[selected];
  if (!dossier) {
    return (
      <div className="dossier">
        <p className="placeholder">Pick a region on the map or in the legend.</p>
        <ol className="legend">
          {split.dossiers.map((d, id) => (
            <li key={id}>
              <button className="legend-row" onClick={() => selectRegion(id)}>
                <span className="swatch" style={{ background: split.colours[id] }} />
                <span className="legend-name">{d.name}</span>
                <span className="legend-stat">{fmt.format(d.population)}</span>
              </button>
            </li>
          ))}
        </ol>
        <button onClick={downloadMarkdown}>Download the set as Markdown</button>
      </div>
    );
  }
  return <Dossier dossier={dossier} onClose={() => selectRegion(null)} />;
}

function Dossier({ dossier, onClose }: { dossier: RegionDossier; onClose: () => void }) {
  return (
    <article className="dossier" data-testid="dossier">
      <header className="unit-header">
        <h2>{dossier.name}</h2>
        <button className="link-button" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="hint">
        {dossier.nameSource === 'manual' ? 'Named by hand' : 'Named after'} {dossier.nameReason}.
      </p>
      <p className="draft">{dossier.oneSentence.text}</p>
      <p className="draft">{dossier.characterLine.text}</p>
      <dl className="facts">
        <dt>Population</dt>
        <dd>
          {fmt.format(dossier.population)} ({dossier.growth2016to2021 >= 0 ? '+' : ''}
          {pct(dossier.growth2016to2021)} since 2016)
        </dd>
        <dt>Area</dt>
        <dd>
          {fmt.format(dossier.areaKm2)} km² · {dossier.densityPerKm2} per km²
        </dd>
        <dt title={dossier.gdpCaveat}>GDP (estimate)</dt>
        <dd title={dossier.gdpCaveat}>
          {dossier.gdpCadMillions === null ? '—' : `$${fmt.format(dossier.gdpCadMillions)} M`}
          {dossier.gdpPerCapita !== null && ` · $${fmt.format(dossier.gdpPerCapita)} per person`}
          <span className="hint"> — estimate, allocated</span>
        </dd>
        <dt>Capital (largest place)</dt>
        <dd>
          {dossier.capital ? `${dossier.capital.name} (${fmt.format(dossier.capital.population)})` : '—'}
        </dd>
        <dt>Other cities</dt>
        <dd>{[...dossier.mainCities, ...dossier.secondaryCities].map((c) => c.name).join(', ') || '—'}</dd>
        <dt>Industries</dt>
        <dd>{dossier.primaryIndustries.map((i) => `${i.label} ${pct(i.share)}`).join('; ') || '—'}</dd>
        <dt>Urban share</dt>
        <dd>{pct(dossier.urbanShare)}</dd>
        <dt>Internal-colony index</dt>
        <dd>{dossier.internalColonyIndex}</dd>
        <dt>Languages</dt>
        <dd>
          English {pct(dossier.languages.english)} · French {pct(dossier.languages.french)} · Indigenous{' '}
          {pct(dossier.languages.indigenous)} · other {pct(dossier.languages.other)}
        </dd>
        <dt>Indigenous identity</dt>
        <dd>
          {pct(dossier.indigenous.identityShare)}
          {dossier.indigenous.languageFamilies.length > 0 &&
            ` · ${dossier.indigenous.languageFamilies.map((f) => f.label).join(', ')}`}
        </dd>
        <dt>Treaty composition</dt>
        <dd>{dossier.treatyComposition.map((t) => `${t.label} ${pct(t.share)}`).join('; ') || '—'}</dd>
        <dt>Governing party</dt>
        <dd>
          {dossier.governingParty.party} ({pct(dossier.governingParty.share)}){' '}
          <span className="hint">hypothetical</span>
        </dd>
        {dossier.rivalRegion && (
          <>
            <dt>Rival</dt>
            <dd>
              {dossier.rivalRegion.name} (similarity {dossier.rivalRegion.similarity})
            </dd>
          </>
        )}
      </dl>
      <h3>Borders, clockwise from the north-west</h3>
      <ul className="borders" data-testid="borders">
        {dossier.bordersInWords.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h3>What would kill it</h3>
      <p className="draft">{dossier.whatWouldKillIt.text}</p>
      <h3>What would save it</h3>
      <p className="draft">{dossier.whatWouldSaveIt.text}</p>
      <p className="hint">
        ⟨draft⟩ marks a sentence the tool wrote from the numbers, waiting to be rewritten.
      </p>
    </article>
  );
}
