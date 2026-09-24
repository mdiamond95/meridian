import { useMemo } from 'react';
import { formatDate, resolvedAt } from '../atlas/resolve';
import { STATUS_LABELS } from '../atlas/style';
import { checkScenario, diffAtDate, type UnitDiff } from '../scenario/apply';
import { SCENARIOS, scenarioById } from '../scenario/scenarios';
import { activeTruthLayers, useAtlasStore } from '../state/atlasStore';
import type { AtlasUnit } from '../schema/atlas';

/**
 * Divergence mode (plan Phase 6 §1): choose a scenario, read its premise and cited events, see which
 * base events it skipped and why, and how its map differs from the base on the timeline's date.
 */
export function ScenarioPanel() {
  const base = useAtlasStore((s) => s.base);
  const data = useAtlasStore((s) => s.data);
  const scenario = useAtlasStore((s) => s.scenario);
  const setScenario = useAtlasStore((s) => s.setScenario);
  const date = useAtlasStore((s) => s.date);
  const truth = useAtlasStore((s) => s.truth);
  const baseOutlines = useAtlasStore((s) => s.baseOutlines);
  const toggleBaseOutlines = useAtlasStore((s) => s.toggleBaseOutlines);
  const setDate = useAtlasStore((s) => s.setDate);

  const asOf = data ? resolvedAt(data.atlas, date) : '';
  const diff = useMemo(
    () => (base && data && scenario && asOf ? diffAtDate(base, data, asOf, activeTruthLayers(truth)) : []),
    [base, data, scenario, asOf, truth],
  );
  const check = useMemo(
    () => (base && scenario ? checkScenario(base, scenario, new Date().toISOString().slice(0, 10)) : null),
    [base, scenario],
  );

  if (!base) return <p className="placeholder">Loading atlas…</p>;

  return (
    <section className="scenario" data-testid="scenario-panel">
      <label className="gen-section">
        <span className="eyebrow">Atlas</span>
        <select
          data-testid="scenario-select"
          value={scenario?.scenario.id ?? ''}
          onChange={(e) => setScenario(e.target.value ? (scenarioById(e.target.value) ?? null) : null)}
        >
          <option value="">The record (base atlas)</option>
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              Scenario: {s.name}
            </option>
          ))}
        </select>
      </label>
      {!scenario && (
        <p className="hint">
          A scenario forks the atlas at a date: its own events are applied after the base events of the same
          day, and later base events that no longer apply are skipped, with the reason. A split made while a
          scenario is on saves the scenario in its pack.
        </p>
      )}
      {scenario && (
        <>
          <p className="note" data-testid="scenario-premise">
            {scenario.scenario.premise}
          </p>
          <p className="hint">
            Forks {formatDate(scenario.scenario.fork)}.{' '}
            {check &&
              (check.ok ? (
                <span data-testid="scenario-clean">Resolves cleanly to today.</span>
              ) : (
                <span className="warn">Does not resolve cleanly: {check.problems.join('; ')}</span>
              ))}
          </p>

          <h3>Differences on {asOf ? formatDate(asOf) : 'this date'}</h3>
          {diff.length === 0 ? (
            <p className="placeholder" data-testid="scenario-diff-empty">
              Same as the record on this date.
            </p>
          ) : (
            <ul className="scenario-diff" data-testid="scenario-diff">
              {diff.map((d) => (
                <li key={`${d.kind}:${d.id}`} data-kind={d.kind}>
                  {describe(d)}
                </li>
              ))}
            </ul>
          )}
          <label className="layer-toggle">
            <input type="checkbox" checked={baseOutlines} onChange={toggleBaseOutlines} /> Outline what the
            record had instead
          </label>

          <h3>Skipped base events</h3>
          {scenario.skipped.length === 0 ? (
            <p className="placeholder">None: every base event still applies.</p>
          ) : (
            <ul className="scenario-skipped" data-testid="scenario-skipped">
              {scenario.skipped.map((s) => (
                <li key={`${s.date}|${s.title}`}>
                  <button className="link-button" onClick={() => setDate(s.date)}>
                    {formatDate(s.date)}: {s.title}
                  </button>
                  <span className="hint"> — skipped: it {s.reasons.join('; it ')}.</span>
                  {s.because.map((b) => (
                    <p className="source" key={b}>
                      <span className="eyebrow">Why it depends on that</span> {b}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}

          <h3>Scenario events</h3>
          <ol className="scenario-events">
            {scenario.scenario.events.map((e) => (
              <li key={`${e.date}|${e.title}`}>
                <button className="link-button" onClick={() => setDate(e.date)}>
                  {formatDate(e.date)}: {e.title}
                </button>
                <p className="note">{e.note}</p>
                {e.sources.map((source) => (
                  <p className="source" key={source}>
                    <span className="eyebrow">Source</span> {source}
                  </p>
                ))}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function unitLine(u: AtlasUnit) {
  return `${u.name} (${STATUS_LABELS[u.status].toLowerCase()}, ${u.sovereign}${u.capital ? `, capital ${u.capital}` : ''})`;
}

function describe(d: UnitDiff): string {
  if (d.kind === 'added') return `Only in the scenario: ${unitLine(d.scenario)}`;
  if (d.kind === 'removed') return `Only in the record: ${unitLine(d.base)}`;
  const parts = d.fields.map((f) => {
    if (f === 'boundary') return 'boundary redrawn';
    const key = f as 'name' | 'status' | 'sovereign' | 'capital';
    const show = (u: AtlasUnit) => (key === 'status' ? STATUS_LABELS[u.status] : (u[key] ?? '—'));
    return `${f} ${show(d.base)} → ${show(d.scenario)}`;
  });
  return `${d.base.name}: ${parts.join(', ')}`;
}
