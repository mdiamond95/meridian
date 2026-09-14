import { useUiStore } from '../state/uiStore';

/** Toggleable layers menu; a floating card on wide screens, a sheet on iPad and phones. */
export function LayersMenu() {
  const open = useUiStore((s) => s.layersOpen);
  const toggle = useUiStore((s) => s.toggleLayers);

  return (
    <nav className="layers" data-open={open} data-testid="layers" aria-label="Layers">
      <button className="layers-button" onClick={toggle} aria-expanded={open} aria-controls="layers-body">
        Layers
      </button>
      <div id="layers-body" className="layers-body" hidden={!open}>
        <p className="placeholder">No layers yet.</p>
      </div>
    </nav>
  );
}
