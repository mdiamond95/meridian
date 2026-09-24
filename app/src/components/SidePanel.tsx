import { currentEvent, formatDate, resolveUnits } from '../atlas/resolve';
import { STATUS_LABELS, TRUTH_LABELS } from '../atlas/style';
import { TRUTH_LAYERS } from '../schema/atlas';
import { useAtlasStore } from '../state/atlasStore';
import { useUiStore } from '../state/uiStore';
import { ComparePanel } from './ComparePanel';
import { DossierPanel } from './DossierPanel';
import { FilesPanel } from './FilesPanel';
import { GeneratePanel } from './GeneratePanel';
import { NestBreadcrumb } from './NestBreadcrumb';
import { ScenarioPanel } from './ScenarioPanel';
import { SetPanel } from './SetPanel';

const TABS = [
  ['details', 'Details'],
  ['scenario', 'Scenario'],
  ['generate', 'Generate'],
  ['dossier', 'Region'],
  ['set', 'Set'],
  ['compare', 'Compare'],
  ['files', 'Files'],
] as const;

/** Right-hand panel on wide screens; a bottom sheet on iPad and phones. */
export function SidePanel() {
  const open = useUiStore((s) => s.panelOpen);
  const toggle = useUiStore((s) => s.togglePanel);
  const tab = useUiStore((s) => s.panelTab);
  const setTab = useUiStore((s) => s.setPanelTab);

  // Left and right move to the neighbouring tab (wrapping), Home and End to the ends; the tab is
  // shown as soon as it has focus, and Tab then goes into its panel.
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex(([id]) => id === tab);
    const next =
      e.key === 'ArrowRight'
        ? (at + 1) % TABS.length
        : e.key === 'ArrowLeft'
          ? (at - 1 + TABS.length) % TABS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? TABS.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next][0]);
    document.getElementById(`tab-${TABS[next][0]}`)?.focus();
  };

  return (
    <aside className="panel" data-open={open} data-testid="panel" aria-label="Details">
      <button className="panel-handle" onClick={toggle} aria-expanded={open} aria-controls="panel-body">
        <span className="sheet-grip" aria-hidden="true" />
        <span>Details</span>
      </button>
      <div id="panel-body" className="panel-body" hidden={!open}>
        <div className="tabs" role="tablist" aria-label="Panels" onKeyDown={onTabKey}>
          {TABS.map(([id, label]) => (
            <button
              key={id}
              id={`tab-${id}`}
              role="tab"
              aria-selected={tab === id}
              aria-controls="panel-tabpanel"
              // One tab stop for the row; the arrow keys move between tabs (WAI-ARIA tabs pattern).
              tabIndex={tab === id ? 0 : -1}
              data-testid={`${id}-tab`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div id="panel-tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="tabpanel">
          {tab === 'details' && <PanelContent />}
          {['generate', 'dossier', 'set', 'files'].includes(tab) && <NestBreadcrumb />}
          {tab === 'scenario' && <ScenarioPanel />}
          {tab === 'generate' && <GeneratePanel />}
          {tab === 'dossier' && <DossierPanel />}
          {tab === 'set' && <SetPanel />}
          {tab === 'compare' && <ComparePanel />}
          {tab === 'files' && <FilesPanel />}
        </div>
      </div>
    </aside>
  );
}

function PanelContent() {
  const data = useAtlasStore((s) => s.data);
  const date = useAtlasStore((s) => s.date);
  const selected = useAtlasStore((s) => s.selected);
  const select = useAtlasStore((s) => s.select);
  const scenario = useAtlasStore((s) => s.scenario);

  if (!data) return <p className="placeholder">Nothing selected.</p>;

  const unit = selected
    ? resolveUnits(data.atlas, date, TRUTH_LAYERS).find((u) => u.id === selected)
    : undefined;
  if (unit) {
    return (
      <article className="unit" data-testid="unit-panel">
        <header className="unit-header">
          <h2>{unit.name}</h2>
          <button className="link-button" onClick={() => select(null)}>
            Close
          </button>
        </header>
        <dl className="facts">
          <dt>Status</dt>
          <dd>{STATUS_LABELS[unit.status]}</dd>
          <dt>Sovereign</dt>
          <dd>{unit.sovereign}</dd>
          <dt>Capital</dt>
          <dd>{unit.capital ?? '—'}</dd>
          <dt>Valid</dt>
          <dd>
            {formatDate(unit.validFrom)} – {unit.validTo ? formatDate(unit.validTo) : 'today'}
          </dd>
          <dt>Layer</dt>
          <dd>
            {TRUTH_LABELS[unit.truth]}
            {unit.confidence !== undefined && ` · confidence ${unit.confidence}`}
          </dd>
        </dl>
        {unit.dispute && (
          <p className="source" data-testid="unit-claimants">
            <span className="eyebrow">Claimed by</span>{' '}
            {[unit.sovereign, ...otherClaimants(data.atlas, date, unit)].join(' · ')}
          </p>
        )}
        {unit.note && <p className="note">{unit.note}</p>}
        {unit.instrument && (
          <p className="source">
            <span className="eyebrow">Instrument</span> {unit.instrument}
          </p>
        )}
        {unit.rationale && (
          <p className="source" data-testid="unit-rationale">
            <span className="eyebrow">Departs from NRCan</span> {unit.rationale}
          </p>
        )}
      </article>
    );
  }

  const event = currentEvent(data.atlas, date);
  if (!event) return <p className="placeholder">Before the first event.</p>;
  // Base events the scenario skipped since this event: said here, where the record would have shown them.
  const next = data.atlas.events.find((e) => e.date > event.date)?.date ?? '9999-12-31';
  const skipped = (scenario?.skipped ?? []).filter(
    (s) => s.date >= event.date && s.date < next && s.date <= date,
  );
  return (
    <article className="event" data-testid="event-panel">
      <p className="eyebrow">
        {formatDate(event.date)}
        {event.dateConfidence !== undefined && ' · date uncertain'}
      </p>
      <h2>{event.title}</h2>
      <p className="note">{event.note}</p>
      {skipped.map((s) => (
        <p className="pending" key={s.title} data-testid="skipped-notice">
          <strong>Skipped in this scenario:</strong> {s.title} ({formatDate(s.date)}). It{' '}
          {s.reasons.join('; it ')}.
        </p>
      ))}
      <p className="placeholder">Tap a unit for its details.</p>
    </article>
  );
}

/** The other powers claiming the same ground on this date, so a hatch is never anonymous. */
function otherClaimants(
  atlas: Parameters<typeof resolveUnits>[0],
  date: string,
  unit: { id: string; dispute?: string },
): string[] {
  if (!unit.dispute) return [];
  const claims = resolveUnits(atlas, date, TRUTH_LAYERS).filter(
    (u) => u.dispute === unit.dispute && u.id !== unit.id,
  );
  return [...new Set(claims.map((u) => u.sovereign))];
}
