import { TRUTH_LABELS } from '../atlas/style';
import { TRUTH_LAYERS } from '../schema/atlas';
import { useAtlasStore } from '../state/atlasStore';
import { useUiStore } from '../state/uiStore';

/** Toggleable layers menu; a floating card on wide screens, a sheet on iPad and phones. */
export function LayersMenu() {
  const open = useUiStore((s) => s.layersOpen);
  const toggle = useUiStore((s) => s.toggleLayers);
  const visible = useAtlasStore((s) => s.visible);
  const setVisible = useAtlasStore((s) => s.setVisible);
  const truth = useAtlasStore((s) => s.truth);
  const toggleTruth = useAtlasStore((s) => s.toggleTruth);
  const nrcanVisible = useAtlasStore((s) => s.nrcanVisible);
  const toggleNrcan = useAtlasStore((s) => s.toggleNrcan);

  return (
    <nav className="layers" data-open={open} data-testid="layers" aria-label="Layers">
      <button className="layers-button" onClick={toggle} aria-expanded={open} aria-controls="layers-body">
        Layers
      </button>
      <div id="layers-body" className="layers-body" hidden={!open}>
        <fieldset className="layer-group">
          <legend>Atlas</legend>
          <label>
            <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
            Historical units
          </label>
          {TRUTH_LAYERS.map((layer) => (
            <label key={layer} className="indent">
              <input
                type="checkbox"
                checked={truth[layer]}
                disabled={!visible}
                onChange={() => toggleTruth(layer)}
              />
              {TRUTH_LABELS[layer]}
            </label>
          ))}
          <label className="indent" title="NRCan's map, shown only where the atlas departs from it">
            <input type="checkbox" checked={nrcanVisible} disabled={!visible} onChange={toggleNrcan} />
            NRCan drawing
          </label>
        </fieldset>
      </div>
    </nav>
  );
}
