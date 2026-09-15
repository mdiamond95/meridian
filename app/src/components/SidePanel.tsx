import { currentEvent, formatDate, resolveUnits } from '../atlas/resolve';
import { STATUS_LABELS, TRUTH_LABELS } from '../atlas/style';
import { TRUTH_LAYERS } from '../schema/atlas';
import { useAtlasStore } from '../state/atlasStore';
import { useUiStore } from '../state/uiStore';

/** Right-hand panel on wide screens; a bottom sheet on iPad and phones. */
export function SidePanel() {
  const open = useUiStore((s) => s.panelOpen);
  const toggle = useUiStore((s) => s.togglePanel);

  return (
    <aside className="panel" data-open={open} data-testid="panel" aria-label="Details">
      <button className="panel-handle" onClick={toggle} aria-expanded={open} aria-controls="panel-body">
        <span className="sheet-grip" aria-hidden="true" />
        <span>Details</span>
      </button>
      <div id="panel-body" className="panel-body" hidden={!open}>
        <PanelContent />
      </div>
    </aside>
  );
}

function PanelContent() {
  const data = useAtlasStore((s) => s.data);
  const date = useAtlasStore((s) => s.date);
  const selected = useAtlasStore((s) => s.selected);
  const select = useAtlasStore((s) => s.select);

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
            {unit.confidence !== undefined && ` · approximate (confidence ${unit.confidence})`}
          </dd>
        </dl>
        {unit.note && <p className="note">{unit.note}</p>}
      </article>
    );
  }

  const event = currentEvent(data.atlas, date);
  if (!event) return <p className="placeholder">Before the first event.</p>;
  return (
    <article className="event" data-testid="event-panel">
      <p className="eyebrow">{formatDate(event.date)}</p>
      <h2>{event.title}</h2>
      <p className="note">{event.note}</p>
      <p className="placeholder">Tap a unit for its details.</p>
    </article>
  );
}
