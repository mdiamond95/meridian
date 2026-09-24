import { Fragment } from 'react';
import { BORDERS_HEADING, dossierFacts, KILL_HEADING, nameLine, SAVE_HEADING } from '../dossier/fields';
import { downloadMarkdown } from '../splitter/controller';
import type { RegionDossier } from '../schema/dossier';
import { useSplitStore } from '../state/splitStore';

/** The selected region's dossier (vision §6). Every GDP number carries the allocation caveat. */
const fmt = new Intl.NumberFormat('en-CA');

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

/** The panel's order is dossierFacts' order, which the Markdown export follows too. */
export function Dossier({ dossier, onClose }: { dossier: RegionDossier; onClose: () => void }) {
  return (
    <article className="dossier" data-testid="dossier">
      <header className="unit-header">
        <h2>{dossier.name}</h2>
        <button className="link-button" onClick={onClose}>
          Close
        </button>
      </header>
      <p className="hint">{nameLine(dossier)}</p>
      <p className="draft">{dossier.oneSentence.text}</p>
      <p className="draft">{dossier.characterLine.text}</p>
      <dl className="facts">
        {dossierFacts(dossier).map((fact) => (
          <Fragment key={fact.label}>
            <dt title={fact.note}>{fact.label}</dt>
            <dd title={fact.note}>
              {fact.value}
              {fact.note && (
                <span className="hint">
                  {' '}
                  — {fact.note === dossier.gdpCaveat ? 'estimate, allocated' : fact.note}
                </span>
              )}
            </dd>
          </Fragment>
        ))}
      </dl>
      <h3>{BORDERS_HEADING}</h3>
      <ul className="borders" data-testid="borders">
        {dossier.bordersInWords.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <h3>{KILL_HEADING}</h3>
      <p className="draft">{dossier.whatWouldKillIt.text}</p>
      <h3>{SAVE_HEADING}</h3>
      <p className="draft">{dossier.whatWouldSaveIt.text}</p>
      <p className="hint">
        ⟨draft⟩ marks a sentence the tool wrote from the numbers, waiting to be rewritten.
      </p>
    </article>
  );
}
