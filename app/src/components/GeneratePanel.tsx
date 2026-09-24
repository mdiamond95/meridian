import { useEffect, useMemo, useState } from 'react';
import { resolveUnits } from '../atlas/resolve';
import { PROVINCE_CODES, type ProvinceCode } from '../schema/mesh';
import type { Scope, SplitMethod } from '../schema/regionPack';
import {
  cancelRun,
  downloadPack,
  ensureSplitterData,
  loadPreset,
  runCurrentSpec,
  shareability,
  shareLink,
} from '../splitter/controller';
import { GDP_CAVEAT } from '../schema/dossier';
import { LENS_PRESETS, lensCandidates, type LensPresetId } from '../splitter/lenses';
import { SNAP_LAYERS } from '../splitter/snap';
import { withLensPreset } from '../splitter/split';
import { useAtlasStore } from '../state/atlasStore';
import { useSplitStore, type MapTool } from '../state/splitStore';

/**
 * The Generate panel (plan Phase 3 Sitting B): scope, method, N, lens, balance, contiguity, seed and
 * constraints; run and cancel; the result's legend, manual painting, sharing and download.
 */

const METHODS: { value: SplitMethod | 'random-cuts'; label: string }[] = [
  { value: 'lens', label: 'Lens split (bisect)' },
  { value: 'balanced', label: 'Balanced partition' },
  { value: 'seeded', label: 'Seeded growth' },
  { value: 'random', label: 'Random (Voronoi)' },
  { value: 'random-cuts', label: 'Random (cuts)' },
];

const BALANCE: { value: string; label: string }[] = [
  { value: 'population', label: 'Equal population' },
  { value: 'gdp_estimate', label: 'Equal GDP (estimate)' },
  { value: 'area', label: 'Equal area' },
  { value: 'cells', label: 'Equal cell count' },
  { value: '', label: 'No balance target' },
];

const fmt = new Intl.NumberFormat('en-CA');

export function GeneratePanel() {
  const dataStatus = useSplitStore((s) => s.dataStatus);
  const error = useSplitStore((s) => s.error);
  const dataSource = useSplitStore((s) => s.dataSource);

  useEffect(() => {
    void ensureSplitterData();
  }, []);

  if (dataStatus === 'loading' || dataStatus === 'idle')
    return <p className="placeholder">Loading the mesh…</p>;
  if (dataStatus === 'error') return <p className="error">The splitter could not load: {error}</p>;
  return (
    <div className="generate" data-testid="generate" data-source={dataSource ?? undefined}>
      <Library />
      <SpecForm />
      <Constraints />
      <RunControls />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Result />
    </div>
  );
}

function Library() {
  const library = useSplitStore((s) => s.library);
  const [id, setId] = useState('');
  if (!library?.packs.length) return null;
  return (
    <section className="gen-section">
      <h3>Presets</h3>
      <div className="row">
        <select
          aria-label="Preset"
          data-testid="preset-select"
          value={id}
          onChange={(e) => setId(e.target.value)}
        >
          <option value="">Choose a preset…</option>
          {library.packs.map((p) => (
            <option key={p.id} value={p.id} title={p.description}>
              {p.name}
            </option>
          ))}
        </select>
        <button disabled={!id} onClick={() => void loadPreset(id)}>
          Load
        </button>
      </div>
    </section>
  );
}

function SpecForm() {
  const spec = useSplitStore((s) => s.spec);
  const setSpec = useSplitStore((s) => s.setSpec);
  const replaceSpec = useSplitStore((s) => s.replaceSpec);
  const data = useSplitStore((s) => s.data);
  const [addColumn, setAddColumn] = useState('');
  const candidates = useMemo(() => (data ? lensCandidates(data.columns, data.kinds) : []), [data]);
  const methodValue = spec.method === 'random' && spec.random === 'cuts' ? 'random-cuts' : spec.method;

  return (
    <section className="gen-section">
      <h3>Split</h3>
      <ScopePicker />
      <label className="field">
        Method
        <select
          data-testid="method-select"
          value={methodValue}
          onChange={(e) => {
            const value = e.target.value;
            if (value === 'random-cuts') setSpec({ method: 'random', random: 'cuts' });
            else
              setSpec({ method: value as SplitMethod, random: value === 'random' ? 'voronoi' : undefined });
          }}
        >
          {METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <label className="field">
          Regions (N)
          <input
            type="number"
            data-testid="n-input"
            min={1}
            max={60}
            value={spec.n}
            onChange={(e) =>
              setSpec({ n: Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 1))) })
            }
          />
        </label>
        <label className="field">
          Seed
          <input
            type="number"
            data-testid="seed-input"
            min={0}
            max={4294967295}
            value={spec.seed}
            onChange={(e) =>
              setSpec({ seed: Math.max(0, Math.min(4294967295, Math.floor(Number(e.target.value) || 0))) })
            }
          />
        </label>
        <button
          className="link-button"
          title="A new random seed"
          onClick={() => setSpec({ seed: crypto.getRandomValues(new Uint32Array(1))[0] })}
        >
          New seed
        </button>
      </div>
      <label className="field">
        Balance target
        <select value={spec.balance ?? ''} onChange={(e) => setSpec({ balance: e.target.value || null })}>
          {BALANCE.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="field">
        <legend>Contiguity</legend>
        {(['hard', 'soft', 'off'] as const).map((c) => (
          <label key={c} className="inline">
            <input
              type="radio"
              name="contiguity"
              checked={spec.contiguity === c}
              onChange={() => setSpec({ contiguity: c })}
            />
            {c}
          </label>
        ))}
      </fieldset>

      <label className="field">
        Lens
        <select
          data-testid="lens-select"
          value={spec.lensPreset ?? ''}
          onChange={(e) => replaceSpec(withLensPreset(spec, (e.target.value || null) as LensPresetId | null))}
        >
          <option value="">No lens</option>
          {Object.entries(LENS_PRESETS).map(([id, preset]) => (
            <option key={id} value={id} title={preset.description}>
              {preset.label}
            </option>
          ))}
        </select>
      </label>
      {spec.lensPreset && <p className="hint">{LENS_PRESETS[spec.lensPreset].description}</p>}
      {Object.keys(spec.lens).length > 0 && (
        <div className="lens-weights">
          <label className="slider">
            <span>Lens weight in the cost</span>
            <input
              type="range"
              min={0}
              max={5}
              step={0.1}
              value={spec.weights.lens}
              onChange={(e) => setSpec({ weights: { ...spec.weights, lens: Number(e.target.value) } })}
            />
            <output>{spec.weights.lens.toFixed(1)}</output>
          </label>
          {Object.entries(spec.lens).map(([column, weight]) => (
            <label key={column} className="slider">
              <span>{column}</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={weight}
                aria-label={`Weight of ${column}`}
                onChange={(e) =>
                  setSpec({ lens: { ...spec.lens, [column]: Number(e.target.value) }, lensPreset: null })
                }
              />
              <output>{weight.toFixed(1)}</output>
            </label>
          ))}
        </div>
      )}
      <div className="row">
        <select
          aria-label="Add a lens column"
          value={addColumn}
          onChange={(e) => setAddColumn(e.target.value)}
        >
          <option value="">Add a column to the lens…</option>
          {candidates
            .filter((c) => !(c in spec.lens))
            .map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
        </select>
        <button
          disabled={!addColumn}
          onClick={() => {
            setSpec({
              lens: { ...spec.lens, [addColumn]: 1 },
              lensPreset: null,
              weights: spec.weights.lens > 0 ? spec.weights : { ...spec.weights, lens: 1 },
            });
            setAddColumn('');
          }}
        >
          Add
        </button>
      </div>
      <label className="slider">
        <span>Compactness weight</span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={spec.weights.compactness}
          onChange={(e) => setSpec({ weights: { ...spec.weights, compactness: Number(e.target.value) } })}
        />
        <output>{spec.weights.compactness.toFixed(2)}</output>
      </label>
    </section>
  );
}

type ScopeKind = Scope['kind'];

function ScopePicker() {
  const spec = useSplitStore((s) => s.spec);
  const setSpec = useSplitStore((s) => s.setSpec);
  const setTool = useSplitStore((s) => s.setTool);
  const tool = useSplitStore((s) => s.tool);
  const drawPoints = useSplitStore((s) => s.drawPoints);
  const split = useSplitStore((s) => s.split);
  const nodeId = useSplitStore((s) => s.nodeId);
  const set = useSplitStore((s) => s.set);
  const atlas = useAtlasStore((s) => s.data);
  const date = useAtlasStore((s) => s.date);
  const units = useMemo(() => (atlas ? resolveUnits(atlas.atlas, date, ['dejure']) : []), [atlas, date]);
  const sovereigns = useMemo(() => [...new Set(units.map((u) => u.sovereign))].sort(), [units]);
  const scope = spec.scope;

  const choose = (kind: ScopeKind) => {
    if (kind === 'canada') setSpec({ scope: { kind } });
    if (kind === 'province') setSpec({ scope: { kind, province: 'AB' } });
    if (kind === 'provinces') setSpec({ scope: { kind, provinces: ['NB', 'NS', 'PE'] } });
    if (kind === 'atlasUnit' && units.length) setSpec({ scope: { kind, unit: units[0].id } });
    if (kind === 'atlasSovereign')
      setSpec({ scope: { kind, sovereign: sovereigns.includes('Canada') ? 'Canada' : sovereigns[0] } });
    if (kind === 'region' && split && nodeId) {
      // The region's split becomes this one's parent in the nesting tree (plan Phase 6 §2).
      set({ regionSource: split.assignment });
      setSpec({ scope: { kind, pack: nodeId, region: 0 } });
    }
    if (kind === 'polygon') setTool('draw');
  };

  return (
    <div className="scope">
      <label className="field">
        Scope
        <select
          data-testid="scope-select"
          value={scope.kind}
          onChange={(e) => choose(e.target.value as ScopeKind)}
        >
          <option value="canada">Canada</option>
          <option value="province">A province or territory</option>
          <option value="provinces">Several provinces or territories</option>
          <option value="atlasUnit">An atlas unit at the current date</option>
          <option value="atlasSovereign">A country in the atlas at the current date</option>
          <option value="region" disabled={!split}>
            A region of the current split
          </option>
          <option value="polygon">A polygon drawn on the map</option>
        </select>
      </label>
      {scope.kind === 'province' && (
        <select
          aria-label="Province"
          data-testid="province-select"
          value={scope.province}
          onChange={(e) => setSpec({ scope: { kind: 'province', province: e.target.value as ProvinceCode } })}
        >
          {PROVINCE_CODES.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      )}
      {scope.kind === 'provinces' && (
        <fieldset className="province-picks" data-testid="provinces-picker">
          <legend>Provinces and territories in the scope</legend>
          {PROVINCE_CODES.map((code) => (
            <label key={code}>
              <input
                type="checkbox"
                checked={scope.provinces.includes(code)}
                // At least one stays ticked: an empty scope has nothing to split.
                disabled={scope.provinces.length === 1 && scope.provinces[0] === code}
                onChange={(e) =>
                  setSpec({
                    scope: {
                      kind: 'provinces',
                      provinces: e.target.checked
                        ? PROVINCE_CODES.filter((c) => c === code || scope.provinces.includes(c))
                        : scope.provinces.filter((c) => c !== code),
                    },
                  })
                }
              />
              {code}
            </label>
          ))}
        </fieldset>
      )}
      {scope.kind === 'atlasUnit' && (
        <select
          aria-label="Atlas unit"
          value={scope.unit}
          onChange={(e) => setSpec({ scope: { kind: 'atlasUnit', unit: e.target.value } })}
        >
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      )}
      {scope.kind === 'atlasSovereign' && (
        <select
          aria-label="Sovereign"
          data-testid="sovereign-select"
          value={scope.sovereign}
          onChange={(e) => setSpec({ scope: { kind: 'atlasSovereign', sovereign: e.target.value } })}
        >
          {sovereigns.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}
      {scope.kind === 'region' && split && (
        <select
          aria-label="Region"
          value={scope.region}
          onChange={(e) => setSpec({ scope: { ...scope, region: Number(e.target.value) } })}
        >
          {split.regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      {(scope.kind === 'polygon' || tool === 'draw') && (
        <div className="row">
          {tool === 'draw' ? (
            <>
              <span className="hint">Click the map to add corners ({drawPoints.length}).</span>
              <button
                disabled={drawPoints.length < 3}
                onClick={() => {
                  const ring = [...drawPoints, drawPoints[0]];
                  setSpec({ scope: { kind: 'polygon', geometry: { type: 'Polygon', coordinates: [ring] } } });
                  setTool('none');
                }}
              >
                Finish
              </button>
              <button className="link-button" onClick={() => setTool('none')}>
                Cancel
              </button>
            </>
          ) : (
            <button onClick={() => setTool('draw')}>Redraw</button>
          )}
        </div>
      )}
    </div>
  );
}

function Constraints() {
  const spec = useSplitStore((s) => s.spec);
  const setSpec = useSplitStore((s) => s.setSpec);
  const data = useSplitStore((s) => s.data);
  const tool = useSplitStore((s) => s.tool);
  const setTool = useSplitStore((s) => s.setTool);
  const pinDraft = useSplitStore((s) => s.pinDraft);
  const set = useSplitStore((s) => s.set);
  const [search, setSearch] = useState('');
  const placeName = (csd: string) => data?.placeByCsd.get(csd)?.name ?? csd;
  const matches = useMemo(() => {
    if (!data || search.length < 2) return [];
    const q = search.toLowerCase();
    return data.places
      .filter((p) => p.name.toLowerCase().startsWith(q))
      .sort((a, b) => b.population - a.population)
      .slice(0, 8);
  }, [data, search]);
  const picking = tool === 'together' || tool === 'apart';

  const limit = (key: 'minPopulation' | 'maxPopulation', raw: string) =>
    setSpec({ [key]: raw === '' ? undefined : Math.max(0, Math.round(Number(raw))) });

  return (
    <details className="gen-section">
      <summary>Constraints and snapping</summary>
      <div className="row">
        <label className="field">
          Min population
          <input
            type="number"
            min={0}
            value={spec.minPopulation ?? ''}
            onChange={(e) => limit('minPopulation', e.target.value)}
          />
        </label>
        <label className="field">
          Max population
          <input
            type="number"
            min={0}
            value={spec.maxPopulation ?? ''}
            onChange={(e) => limit('maxPopulation', e.target.value)}
          />
        </label>
      </div>

      <h4>Pins</h4>
      {(['together', 'apart'] as const).map((kind) => (
        <ul key={kind} className="pins">
          {spec[kind].map((group, i) => (
            <li key={i}>
              {kind === 'together' ? 'Together: ' : 'Apart: '}
              {group.map(placeName).join(', ')}{' '}
              <button
                className="link-button"
                onClick={() => setSpec({ [kind]: spec[kind].filter((_, j) => j !== i) })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ))}
      {picking ? (
        <div className="pin-draft">
          <p className="hint">
            Click places on the map or search, then save the{' '}
            {tool === 'together' ? 'keep-together' : 'keep-apart'} group:{' '}
            {pinDraft.map(placeName).join(', ') || 'none yet'}
          </p>
          <input placeholder="Search places" value={search} onChange={(e) => setSearch(e.target.value)} />
          <ul className="matches">
            {matches.map((p) => (
              <li key={p.csd}>
                <button
                  className="link-button"
                  onClick={() => set({ pinDraft: [...new Set([...pinDraft, p.csd])] })}
                >
                  {p.name} ({fmt.format(p.population)})
                </button>
              </li>
            ))}
          </ul>
          <div className="row">
            <button
              disabled={pinDraft.length < 2}
              onClick={() => {
                setSpec({ [tool]: [...spec[tool as MapTool & ('together' | 'apart')], pinDraft] });
                setTool('none');
              }}
            >
              Save group
            </button>
            <button className="link-button" onClick={() => setTool('none')}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <button onClick={() => setTool('together')}>Keep together…</button>
          <button onClick={() => setTool('apart')}>Keep apart…</button>
        </div>
      )}

      <h4>Metros</h4>
      <label className="inline">
        <input
          type="checkbox"
          checked={spec.carveCmas.enabled}
          onChange={(e) => setSpec({ carveCmas: { ...spec.carveCmas, enabled: e.target.checked } })}
        />
        Carve each CMA of at least
        <input
          type="number"
          className="short"
          min={0}
          step={100000}
          value={spec.carveCmas.minPopulation}
          onChange={(e) =>
            setSpec({ carveCmas: { ...spec.carveCmas, minPopulation: Math.max(0, Number(e.target.value)) } })
          }
        />
        people out first, as its own region
      </label>

      <h4>Snap boundaries to</h4>
      {SNAP_LAYERS.map((layer) => (
        <label key={layer.id} className="inline" title={layer.note}>
          <input
            type="checkbox"
            disabled={!layer.available}
            checked={spec.snap.includes(layer.id)}
            onChange={(e) =>
              setSpec({
                snap: e.target.checked ? [...spec.snap, layer.id] : spec.snap.filter((id) => id !== layer.id),
                weights:
                  e.target.checked && spec.weights.snap === 0 ? { ...spec.weights, snap: 0.5 } : spec.weights,
              })
            }
          />
          {layer.label}
          {!layer.available && <span className="hint"> — {layer.note}</span>}
        </label>
      ))}
      {spec.snap.length > 0 && (
        <label className="slider">
          <span>Snap weight</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={spec.weights.snap}
            onChange={(e) => setSpec({ weights: { ...spec.weights, snap: Number(e.target.value) } })}
          />
          <output>{spec.weights.snap.toFixed(2)}</output>
        </label>
      )}
    </details>
  );
}

function RunControls() {
  const running = useSplitStore((s) => s.running);
  const progress = useSplitStore((s) => s.progress);
  return (
    <section className="gen-section run">
      {running ? (
        <>
          <button onClick={cancelRun} data-testid="cancel-button">
            Cancel
          </button>
          <progress
            max={progress?.iterations ?? 1}
            value={progress?.iteration ?? 0}
            aria-label="Solver progress"
          />
        </>
      ) : (
        <button className="primary" data-testid="run-button" onClick={() => void runCurrentSpec()}>
          Run
        </button>
      )}
    </section>
  );
}

function Result() {
  const split = useSplitStore((s) => s.split);
  const selected = useSplitStore((s) => s.selectedRegion);
  const selectRegion = useSplitStore((s) => s.selectRegion);
  const tool = useSplitStore((s) => s.tool);
  const setTool = useSplitStore((s) => s.setTool);
  const [copied, setCopied] = useState(false);
  if (!split) return null;
  const share = shareability(split);
  const pops = split.regions.map((r) => r.population);
  const ratio = Math.min(...pops) > 0 ? Math.max(...pops) / Math.min(...pops) : Infinity;

  return (
    <section className="gen-section" data-testid="split-result">
      <h3>
        {split.regions.length} regions
        {split.edits.length > 0 && <span className="badge"> edited ({split.edits.length})</span>}
      </h3>
      <p className="hint">
        Largest to smallest population: {Number.isFinite(ratio) ? ratio.toFixed(2) : '—'}
        {split.source.kind === 'pack' &&
          split.source.fit.kind === 'regenerate' &&
          ` · ${split.source.fit.reason}`}
      </p>
      <ol className="legend" data-testid="split-legend">
        {split.regions.map((r) => (
          <li key={r.id} data-selected={selected === r.id}>
            <button className="legend-row" onClick={() => selectRegion(selected === r.id ? null : r.id)}>
              <span className="swatch" style={{ background: split.colours[r.id] }} />
              <span className="legend-name">{r.name}</span>
              <span className="legend-stat">{fmt.format(r.population)}</span>
            </button>
            {selected === r.id && (
              <dl className="facts small">
                <dt>Area</dt>
                <dd>{fmt.format(Math.round(r.areaKm2))} km²</dd>
                {r.gdp !== null && (
                  <>
                    <dt title={GDP_CAVEAT}>GDP (estimate)</dt>
                    <dd title={GDP_CAVEAT}>
                      ${fmt.format(Math.round(r.gdp))} M <span className="hint">allocated, not measured</span>
                    </dd>
                  </>
                )}
                <dt>Compactness</dt>
                <dd>{r.compactness.toFixed(3)}</dd>
                <dt>Cells</dt>
                <dd>{r.cells}</dd>
                {r.pieces > 1 && (
                  <>
                    <dt>Pieces</dt>
                    <dd className="warn">{r.pieces} (not contiguous)</dd>
                  </>
                )}
              </dl>
            )}
          </li>
        ))}
      </ol>
      <div className="row">
        <button
          aria-pressed={tool === 'paint'}
          disabled={selected === null}
          title={
            selected === null
              ? 'Select a region in the legend first'
              : 'Click or drag on the map to paint cells'
          }
          onClick={() => setTool(tool === 'paint' ? 'none' : 'paint')}
        >
          {tool === 'paint' ? 'Stop painting' : 'Paint cells'}
        </button>
        <button onClick={downloadPack}>Download pack</button>
        <button
          disabled={!share.ok}
          title={share.ok ? 'Copy a link that reruns this split' : share.reason}
          onClick={() => {
            const link = shareLink();
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
            history.replaceState(null, '', link.slice(link.indexOf('#')));
          }}
        >
          {copied ? 'Link copied' : 'Share link'}
        </button>
      </div>
      {!share.ok && <p className="hint">{share.reason}</p>}
    </section>
  );
}
