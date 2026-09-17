import { useEffect, useState } from 'react';
import { loadComparison, setDivider, stopComparing } from '../splitter/controller';
import { useSplitStore } from '../state/splitStore';

/**
 * Compare mode (vision §6): the current split against another — a preset, or actual Canada — with a
 * swipe divider on the map and a table of what moved.
 */
const fmt = new Intl.NumberFormat('en-CA');

export function ComparePanel() {
  const split = useSplitStore((s) => s.split);
  const library = useSplitStore((s) => s.library);
  const compare = useSplitStore((s) => s.compare);
  const [choice, setChoice] = useState('actual-canada');

  useEffect(() => () => stopComparing(), []);

  if (!split) return <p className="placeholder">Generate a split first, then compare it with another.</p>;

  return (
    <div className="compare" data-testid="compare">
      <div className="row">
        <select
          aria-label="Compare with"
          data-testid="compare-select"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="actual-canada">Actual Canada (provinces and territories)</option>
          {library?.packs.map((pack) => (
            <option key={pack.id} value={pack.id}>
              {pack.name}
            </option>
          ))}
        </select>
        <button data-testid="compare-button" onClick={() => void loadComparison(choice)}>
          Compare
        </button>
        {compare && (
          <button className="link-button" onClick={stopComparing}>
            Stop
          </button>
        )}
      </div>
      {compare && (
        <>
          <label className="slider">
            <span>Divider</span>
            <input
              type="range"
              min={5}
              max={95}
              value={Math.round(compare.divider * 100)}
              aria-label="Swipe divider"
              onChange={(e) => setDivider(Number(e.target.value) / 100)}
            />
            <output>{Math.round(compare.divider * 100)}%</output>
          </label>
          <p className="hint">
            Left of the divider: this split. Right: {compare.name}. Drag the handle on the map, or the slider.
          </p>
          <dl className="facts" data-testid="difference">
            <dt>Cells reassigned</dt>
            <dd>
              {fmt.format(compare.difference.cellsReassigned)} of {fmt.format(compare.difference.cells)} (
              {((compare.difference.cellsReassigned / Math.max(1, compare.difference.cells)) * 100).toFixed(
                1,
              )}
              %)
            </dd>
            <dt>Population moved</dt>
            <dd>{fmt.format(compare.difference.populationMoved)}</dd>
            <dt>Metros split here</dt>
            <dd>{compare.difference.metrosSplitA.join(', ') || 'none'}</dd>
            <dt>Metros split there</dt>
            <dd>{compare.difference.metrosSplitB.join(', ') || 'none'}</dd>
          </dl>
          <h3>Matched regions</h3>
          <table className="rank" data-testid="compare-table">
            <thead>
              <tr>
                <th>This split</th>
                <th>{compare.name}</th>
                <th>Shared people</th>
              </tr>
            </thead>
            <tbody>
              {compare.difference.matches.slice(0, 30).map((match) => (
                <tr key={`${match.a}-${match.b}`}>
                  <td>{match.nameA}</td>
                  <td>{match.nameB}</td>
                  <td>{fmt.format(match.sharedPopulation)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(compare.difference.onlyInA.length > 0 || compare.difference.onlyInB.length > 0) && (
            <p className="hint">
              Unmatched: {compare.difference.onlyInA.join(', ') || 'none'} here;{' '}
              {compare.difference.onlyInB.join(', ') || 'none'} there.
            </p>
          )}
        </>
      )}
    </div>
  );
}
