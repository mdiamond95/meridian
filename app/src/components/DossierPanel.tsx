import { Fragment, useState } from 'react';
import { BORDERS_HEADING, dossierFacts, KILL_HEADING, nameLine, SAVE_HEADING } from '../dossier/fields';
import { downloadMarkdown, splitRegion } from '../splitter/controller';
import type { RegionScore } from '../schema/regionPack';
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
  return (
    <>
      <Dossier dossier={dossier} onClose={() => selectRegion(null)} />
      {split.scores?.[selected as number] && <Score score={split.scores[selected as number]} />}
      <SplitThisRegion regionId={selected as number} />
    </>
  );
}

/** The game-facing score (plan Phase 6 §5); definitions in docs/interop.md. */
function Score({ score }: { score: RegionScore }) {
  return (
    <section className="gen-section" data-testid="region-score">
      <h3>Score</h3>
      <dl className="facts">
        <dt>Population</dt>
        <dd>{fmt.format(score.population)}</dd>
        <dt>GDP</dt>
        <dd>
          ${fmt.format(score.gdp)}M <span className="hint">— estimate, allocated</span>
        </dd>
        <dt title="Labour-force share in NAICS 11 and 21">Resource index</dt>
        <dd>{score.resource_index.toFixed(3)}</dd>
        <dt title="1 − lens variance, scaled to 0–1">Cohesion</dt>
        <dd>{score.cohesion.toFixed(3)}</dd>
        <dt title="The largest industry's labour-force share">Exposure</dt>
        <dd>{score.exposure.toFixed(3)}</dd>
      </dl>
    </section>
  );
}

/** Nesting (plan Phase 6 §2): this region becomes the scope of the next split. */
function SplitThisRegion({ regionId }: { regionId: number }) {
  const [n, setN] = useState(3);
  const running = useSplitStore((s) => s.running);
  return (
    <section className="gen-section">
      <h3>Split this region</h3>
      <div className="row">
        <label className="field">
          Into
          <input
            type="number"
            min={2}
            max={30}
            value={n}
            aria-label="Regions in the nested split"
            data-testid="nest-n"
            onChange={(e) => setN(Math.max(2, Math.min(30, Number(e.target.value) || 2)))}
          />
        </label>
        <button disabled={running} data-testid="nest-split" onClick={() => void splitRegion(regionId, n)}>
          Split it
        </button>
      </div>
      <p className="hint">The new split keeps this one as its parent; the breadcrumb goes back up.</p>
    </section>
  );
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
