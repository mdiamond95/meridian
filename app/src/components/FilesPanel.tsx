import { useCallback, useEffect, useState } from 'react';
import { EXPORT_FORMATS } from '../export/download';
import { deleteSaved, listSaved, type SavedPackSummary } from '../import/library';
import {
  ensureSplitterData,
  exportCurrent,
  importGeo,
  importPack,
  loadFromLibrary,
  refitPending,
  regeneratePending,
  saveCurrentToLibrary,
  shareability,
  shareLink,
  type ImportUse,
} from '../splitter/controller';
import { useSplitStore } from '../state/splitStore';

/**
 * Files (plan Phase 5): export the split in every format, share a link, keep packs in this browser,
 * and bring packs, GeoJSON and KML back in.
 */
export function FilesPanel() {
  const dataStatus = useSplitStore((s) => s.dataStatus);
  const error = useSplitStore((s) => s.error);
  const notice = useSplitStore((s) => s.notice);

  useEffect(() => {
    void ensureSplitterData();
  }, []);

  if (dataStatus === 'loading' || dataStatus === 'idle')
    return <p className="placeholder">Loading the mesh…</p>;
  if (dataStatus === 'error') return <p className="error">The splitter could not load: {error}</p>;
  return (
    <div className="generate files" data-testid="files">
      <Export />
      <Share />
      <Library />
      <Import />
      {notice && (
        <p className="hint" role="status" data-testid="files-notice">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Export() {
  const split = useSplitStore((s) => s.split);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <section className="gen-section">
      <h3>Export</h3>
      {!split && <p className="hint">Generate or load a split first.</p>}
      <div className="row">
        {EXPORT_FORMATS.map((format) => (
          <button
            key={format.id}
            data-testid={`export-${format.id}`}
            disabled={!split || busy !== null || (format.id === 'markdown' && !split.dossiers)}
            onClick={() => {
              setBusy(format.id);
              void exportCurrent(format.id).finally(() => setBusy(null));
            }}
          >
            {busy === format.id ? 'Preparing…' : format.label}
          </button>
        ))}
      </div>
      <p className="hint">
        GeoJSON, TopoJSON and KML carry each region&apos;s dossier; KML opens in Google My Maps with a folder
        per region and the dividing lines in their own folder.
      </p>
    </section>
  );
}

function Share() {
  const split = useSplitStore((s) => s.split);
  // The split the link was copied for, so a new split resets the button without an effect.
  const [copiedFor, setCopiedFor] = useState<typeof split>(null);
  const copied = copiedFor !== null && copiedFor === split;
  const share = shareability(split);
  return (
    <section className="gen-section">
      <h3>Share link</h3>
      <div className="row">
        <button
          data-testid="share-link"
          disabled={!share.ok}
          onClick={() => {
            const link = shareLink();
            void navigator.clipboard?.writeText(link).then(() => setCopiedFor(split));
            history.replaceState(null, '', link.slice(link.indexOf('#')));
          }}
        >
          {copied ? 'Link copied' : 'Copy share link'}
        </button>
      </div>
      <p className="hint" data-testid="share-hint">
        {share.ok ? 'The link reruns this split from its recipe; nothing is uploaded.' : share.reason}
      </p>
    </section>
  );
}

function Library() {
  const split = useSplitStore((s) => s.split);
  const [saved, setSaved] = useState<SavedPackSummary[]>([]);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [name, setName] = useState('');

  // Bumped after a save or delete; the effect re-reads the library in a callback.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    void listSaved().then((result) => {
      if (!live) return;
      setSaved(result.ok ? result.value : []);
      setUnavailable(result.ok ? null : result.reason);
    });
    return () => {
      live = false;
    };
  }, [version]);

  return (
    <section className="gen-section" data-testid="library">
      <h3>Saved in this browser</h3>
      {unavailable ? (
        <p className="hint" data-testid="library-unavailable">
          Browser storage is not available here ({unavailable}), so packs cannot be saved in this browser.
          Download them instead.
        </p>
      ) : (
        <>
          <div className="row">
            <input
              aria-label="Name for the saved pack"
              placeholder={split ? `${split.regions.length} regions` : 'Name'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              data-testid="library-save"
              disabled={!split}
              onClick={() => {
                const label = name.trim() || `${split?.regions.length ?? 0} regions`;
                void saveCurrentToLibrary(label).then((ok) => {
                  if (ok) setName('');
                  refresh();
                });
              }}
            >
              Save
            </button>
          </div>
          {saved.length === 0 ? (
            <p className="hint">Nothing saved yet.</p>
          ) : (
            <ul className="legend" data-testid="library-list">
              {saved.map((entry) => (
                <li key={entry.id} className="library-row">
                  <span className="legend-name">
                    {entry.name}
                    <span className="hint">
                      {' '}
                      · {entry.regions} regions · mesh {entry.meshVersion}
                      {entry.edited && ' · edited'}
                    </span>
                  </span>
                  <button onClick={() => void loadFromLibrary(entry.id, entry.name)}>Load</button>
                  <button
                    aria-label={`Delete ${entry.name}`}
                    onClick={() => void deleteSaved(entry.id).then(refresh)}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

const USES: { value: ImportUse; label: string }[] = [
  { value: 'template', label: 'as a split (cells by majority overlap)' },
  { value: 'snap', label: 'as a snap layer' },
  { value: 'scope', label: 'as the scope to split' },
];

function Import() {
  const pending = useSplitStore((s) => s.pendingImport);
  const [use, setUse] = useState<ImportUse>('template');

  const onFile = async (file: File) => {
    const text = await file.text();
    useSplitStore.getState().set({ error: null, notice: null });
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON: KML, handled below
    }
    if (json && typeof json === 'object' && (json as { format?: string }).format === 'meridian.regionPack') {
      await importPack(json, file.name);
    } else {
      await importGeo(text, file.name, use);
    }
  };

  return (
    <section className="gen-section">
      <h3>Import</h3>
      <label className="field">
        <span>A GeoJSON or KML file is used</span>
        <select
          aria-label="Use an imported map"
          value={use}
          onChange={(e) => setUse(e.target.value as ImportUse)}
        >
          {USES.map((u) => (
            <option key={u.value} value={u.value}>
              {u.label}
            </option>
          ))}
        </select>
      </label>
      <input
        type="file"
        data-testid="import-file"
        accept=".json,.geojson,.kml,application/json,application/geo+json,application/vnd.google-earth.kml+xml"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void onFile(file);
        }}
      />
      <p className="hint">A region pack (.json) loads as it was saved.</p>
      {pending && (
        <div
          className="pending"
          data-testid="pending-import"
          role="dialog"
          aria-label="Pack from another mesh"
        >
          <p>
            <strong>{pending.name}</strong> was made on mesh {pending.from}; this is mesh {pending.to}.
          </p>
          <div className="row">
            <button onClick={() => void refitPending()}>Re-fit by nearest cell</button>
            <button
              disabled={!!pending.pack.meta.edited || pending.pack.meta.method === 'template'}
              title="Rerun its seed and params on this mesh"
              onClick={() => void regeneratePending()}
            >
              Regenerate from its seed
            </button>
            <button onClick={() => useSplitStore.getState().set({ pendingImport: null })}>Cancel</button>
          </div>
          <p className="hint">
            Re-fitting gives each cell here the region of the nearest cell of mesh {pending.from}, and keeps
            hand edits. Regenerating reruns the recipe, which only an unedited pack has.
          </p>
        </div>
      )}
    </section>
  );
}
