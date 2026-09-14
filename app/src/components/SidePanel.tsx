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
        <p className="placeholder">Nothing selected.</p>
      </div>
    </aside>
  );
}
