import { downloadMarkdown } from '../splitter/controller';
import { useSplitStore } from '../state/splitStore';

/** The set: power ranking, ratios, reconciliation, contiguity compromises, and the federalism panel. */
const fmt = new Intl.NumberFormat('en-CA');
const pct = (share: number) => `${(share * 100).toFixed(1)}%`;

export function SetPanel() {
  const split = useSplitStore((s) => s.split);
  if (!split) return <p className="placeholder">Generate a split first.</p>;
  const set = split.setAnalysis;
  if (!set) return <p className="placeholder">Analysing the set…</p>;

  return (
    <div className="set-analysis" data-testid="set-analysis">
      <h2>
        {set.regions} regions over {set.scope}
      </h2>
      <h3>Power ranking</h3>
      <table className="rank" data-testid="power-ranking">
        <thead>
          <tr>
            <th>#</th>
            <th>Region</th>
            <th title="Share of the set's GDP estimate">GDP</th>
            <th title="Boundary runs a major river or a provincial border crosses">Choke</th>
            <th title="Share of the set's extractive labour force">Resource</th>
          </tr>
        </thead>
        <tbody>
          {set.powerRanking.map((row) => (
            <tr key={row.id}>
              <td>{row.rank}</td>
              <td>{row.name}</td>
              <td>{pct(row.economicLeverage)}</td>
              <td>{row.chokepoints}</td>
              <td>{pct(row.resourceOwnership)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{set.gdpCaveat}</p>

      <h3>The set</h3>
      <dl className="facts">
        <dt>Largest to smallest population</dt>
        <dd>{set.ratios.population ?? '—'}</dd>
        <dt>Largest to smallest area</dt>
        <dd>{set.ratios.area ?? '—'}</dd>
        <dt>Metros split</dt>
        <dd>{set.metrosSplit.map((m) => `${m.name} (${m.regions.length})`).join(', ') || 'none'}</dd>
        <dt>Population reconciliation</dt>
        <dd>
          {fmt.format(set.reconciliation.population.regions)} against{' '}
          {fmt.format(set.reconciliation.population.scope)} in the scope
          <span className={set.reconciliation.ok ? '' : 'warn'}>
            {' '}
            (difference {set.reconciliation.population.difference})
          </span>
        </dd>
        <dt>GDP reconciliation (estimate)</dt>
        <dd>
          ${fmt.format(set.reconciliation.gdp.regions)} M against ${fmt.format(set.reconciliation.gdp.scope)}{' '}
          M
        </dd>
      </dl>
      {set.contiguityLog.length > 0 && (
        <>
          <h3>Contiguity compromises</h3>
          <ul>
            {set.contiguityLog.map((row) => (
              <li key={row.id}>
                {row.name}: {row.note}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>What it would break in the federation</h3>
      <ul className="federalism" data-testid="federalism">
        {set.federalism.map((finding) => (
          <li key={finding.id} data-verdict={finding.verdict}>
            <strong>{finding.title}</strong>{' '}
            <span className={`verdict ${finding.verdict}`}>{finding.verdict}</span>
            <p>{finding.detail}</p>
            <p className="hint">
              {finding.citation} —{' '}
              <a href={finding.url} target="_blank" rel="noreferrer">
                text
              </a>
            </p>
          </li>
        ))}
      </ul>
      <button onClick={downloadMarkdown}>Download the set as Markdown</button>
    </div>
  );
}
