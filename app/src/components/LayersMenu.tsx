import { TRUTH_LABELS } from '../atlas/style';
import { TRUTH_LAYERS } from '../schema/atlas';
import { START_OPTIONS, useAtlasStore, type StartOption } from '../state/atlasStore';
import { useUiStore } from '../state/uiStore';

const START_LABELS: Record<string, string> = {
  '1000': '1000 — the Norse',
  '1497': '1497 — Cabot',
  frontier: 'Contact frontier',
};

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
  const contactVisible = useAtlasStore((s) => s.contactVisible);
  const toggleContact = useAtlasStore((s) => s.toggleContact);
  const start = useAtlasStore((s) => s.start);
  const setStart = useAtlasStore((s) => s.setStart);

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
        <fieldset className="layer-group">
          <legend>Before the atlas</legend>
          <label title="The earliest documented European presence, by area">
            <input type="checkbox" checked={contactVisible} onChange={toggleContact} />
            Contact frontier
          </label>
          <label className="indent" htmlFor="start-select">
            Timeline starts
          </label>
          <select
            id="start-select"
            className="indent"
            data-testid="start-select"
            value={String(start)}
            onChange={(e) => {
              const raw = e.target.value;
              const next: StartOption = raw === 'frontier' ? 'frontier' : (Number(raw) as StartOption);
              setStart(next);
            }}
          >
            {START_OPTIONS.map((option) => (
              <option key={String(option)} value={String(option)}>
                {START_LABELS[String(option)]}
              </option>
            ))}
          </select>
        </fieldset>
      </div>
    </nav>
  );
}
