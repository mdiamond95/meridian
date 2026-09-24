import { resolvedAt } from '../atlas/resolve';
import { buildDossiers, buildSetAnalysis } from '../dossier/dossier';
import { SolverClient } from '../engine/client';
import type { Columns } from '../engine/solver';
import { useAtlasStore } from '../state/atlasStore';
import { useSplitStore, type CurrentSplit } from '../state/splitStore';
import { CELLS_URL, SPLITTER_URLS } from './assets';
import { loadCellTopology, loadSplitterData } from './data';
import { actualCanada, compareSplits, type ComparableSplit } from './compare';
import { buildPack, fitPack, loadLibrary, loadPack, specFromPack } from './pack';
import { regionColours } from './palette';
import { cellTopology } from './outline';
import {
  finishSplit,
  nameRegions,
  prepareSplit,
  preparedFromAssignment,
  type PreparedSplit,
  type SplitSpec,
} from './split';
import { encodeHash } from './url';
import { maybeGunzip } from '../data/loadMesh';
import { exportInput } from '../export/build';
import { exportFile, saveFile, type ExportFormat } from '../export/download';
import { getSaved, savePack } from '../import/library';
import { checkPack, MESH_ARCHIVE, refitAssignment } from '../import/pack';
import {
  assignByTemplate,
  parseGeoFile,
  templateFromGeoJSON,
  templateScope,
  templateSnapEdges,
} from '../import/template';
import type { RegionPack } from '../schema/regionPack';
import { IMPORTED_SNAP } from './snap';

/**
 * The splitter's actions: load its data, run a split in the worker, load a pack, paint cells, share
 * and download. Components call these; state lives in useSplitStore.
 */

const BASE = import.meta.env.BASE_URL;
let client: SolverClient | null = null;
let currentRun: { cancel(): void } | null = null;
let loading: Promise<void> | null = null;

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export function ensureSplitterData(): Promise<void> {
  const store = useSplitStore.getState();
  if (store.dataStatus === 'ready') return Promise.resolve();
  if (loading) return loading;
  store.set({ dataStatus: 'loading', error: null });
  loading = Promise.all([loadSplitterData(SPLITTER_URLS), loadCellTopology(CELLS_URL), loadLibrary(BASE)])
    .then(([data, topology, library]) => {
      useSplitStore.getState().set({ data, topology: cellTopology(topology), library, dataStatus: 'ready' });
    })
    .catch((err: unknown) => {
      console.error(err);
      loading = null;
      useSplitStore.getState().set({ dataStatus: 'error', error: message(err) });
    });
  return loading;
}

function context() {
  const { data: atlas } = useAtlasStore.getState();
  const { regionSource, importedSnap } = useSplitStore.getState();
  return {
    atlas: atlas ?? undefined,
    packAssignment: regionSource ?? undefined,
    importedSnap: importedSnap?.edges,
  };
}

/** The columns a run reads, so the worker is not sent all eighty. */
function neededColumns(spec: SplitSpec, columns: Columns): Columns {
  const names = new Set(['population', 'gdp_estimate', ...Object.keys(spec.lens)]);
  if (spec.balance && !['cells', 'area'].includes(spec.balance)) names.add(spec.balance);
  return Object.fromEntries([...names].filter((n) => columns[n]).map((n) => [n, columns[n]]));
}

function show(
  prepared: PreparedSplit,
  assignment: Int32Array,
  source: CurrentSplit['source'],
  /** names chosen elsewhere (an imported map's), by region id */
  names?: Map<number, string>,
) {
  const { data, topology } = useSplitStore.getState();
  if (!data) return;
  const regions = nameRegions(prepared, assignment, countRegions(assignment), data).map((r) => ({
    ...r,
    name: names?.get(r.id) ?? r.name,
  }));
  const split: CurrentSplit = {
    prepared,
    assignment,
    regions,
    colours: regionColours(prepared.scopeGraph, assignment, regions.length),
    edits: [],
    source,
    dossiers: null,
    setAnalysis: null,
  };
  useSplitStore.getState().set({ split, selectedRegion: null });
  if (topology) describeSplit(topology);
}

/**
 * Dossiers and set analysis for the split on screen (plan Phase 4). They are built after the split is
 * drawn: walking every region's boundary takes a moment on a 26-region Canada, and the map should not
 * wait for prose.
 */
export function describeSplit(topology = useSplitStore.getState().topology) {
  const { split, data } = useSplitStore.getState();
  if (!split || !data || !topology) return;
  // Names that were chosen rather than generated: a seeded region's capital, and every carved metro.
  const manualNames: Record<number, string> = {};
  const solverRegions = split.regions.length - split.prepared.carved.length;
  split.prepared.carved.forEach((cma, i) => (manualNames[solverRegions + i] = cma.name));
  if (split.source.kind === 'template' || split.prepared.spec.method === 'template')
    split.regions.forEach((r) => (manualNames[r.id] = r.name));
  if (split.prepared.spec.method === 'seeded') {
    split.prepared.spec.capitalNames?.forEach((name, i) => {
      if (i < solverRegions) manualNames[i] = name;
    });
  }
  const input = {
    data,
    topo: topology,
    prepared: split.prepared,
    assignment: split.assignment,
    regionCount: split.regions.length,
    manualNames,
  };
  const { dossiers, aggregates, names } = buildDossiers(input);
  const setAnalysis = buildSetAnalysis({
    ...input,
    aggregates,
    names,
    pieces: split.regions.map((r) => r.pieces),
  });
  if (useSplitStore.getState().split !== split) return; // a newer split arrived while this one was described
  useSplitStore.getState().set({
    split: {
      ...split,
      dossiers,
      setAnalysis,
      regions: split.regions.map((region, i) => ({ ...region, name: dossiers[i]?.name ?? region.name })),
    },
  });
}

function countRegions(assignment: Int32Array) {
  let k = 0;
  for (const r of assignment) if (r + 1 > k) k = r + 1;
  return k;
}

export async function runCurrentSpec(): Promise<void> {
  await ensureSplitterData();
  const store = useSplitStore.getState();
  const { data } = store;
  if (!data || store.running) return;
  const date =
    store.spec.scope.kind === 'atlasUnit'
      ? resolvedAt(useAtlasStore.getState().data?.atlas ?? { events: [] }, useAtlasStore.getState().date) ||
        null
      : store.spec.date;
  const spec = { ...store.spec, date };
  let prepared: PreparedSplit;
  try {
    prepared = prepareSplit(spec, data, context());
  } catch (err) {
    store.set({ error: message(err) });
    return;
  }
  client ??= SolverClient.create();
  client.init(data.arrays, neededColumns(spec, data.columns));
  store.set({ running: true, progress: null, error: null, spec });
  const run = client.run(prepared.solveMask, prepared.params, spec.seed, {
    snapEdges: prepared.snap,
    onProgress: (progress) => useSplitStore.getState().set({ progress }),
  });
  currentRun = run;
  try {
    const result = await run.result;
    const finished = finishSplit(prepared, result, data);
    show(prepared, finished.assignment, { kind: 'run' });
    history.replaceState(null, '', encodeHash({ kind: 'split', spec }));
  } catch (err) {
    useSplitStore.getState().set({ error: message(err) });
  } finally {
    currentRun = null;
    useSplitStore.getState().set({ running: false, progress: null });
  }
}

export function cancelRun() {
  currentRun?.cancel();
}

export async function loadPreset(id: string): Promise<void> {
  await ensureSplitterData();
  const { data, library } = useSplitStore.getState();
  const entry = library?.packs.find((p) => p.id === id);
  if (!data || !entry) {
    useSplitStore.getState().set({ error: `no pack ${id} in the library` });
    return;
  }
  try {
    const pack = await loadPack(BASE, entry.file);
    const fit = fitPack(pack, data.meshVersion);
    if (fit.kind === 'unfittable') {
      useSplitStore.getState().set({ error: `${entry.name}: ${fit.reason}` });
      return;
    }
    const spec = specFromPack(pack);
    useSplitStore.getState().replaceSpec(spec);
    if (fit.kind === 'regenerate') {
      await runCurrentSpec();
      const split = useSplitStore.getState().split;
      if (split) useSplitStore.getState().set({ split: { ...split, source: { kind: 'pack', id, fit } } });
    } else {
      show(prepareSplit(spec, data, context()), pack.assignment, { kind: 'pack', id, fit });
    }
    history.replaceState(null, '', encodeHash({ kind: 'pack', id }));
  } catch (err) {
    useSplitStore.getState().set({ error: message(err) });
  }
}

/** Paint one cell into the selected region; stats and names follow. Edits go into the pack meta. */
export function paintCell(cell: number) {
  const { split, selectedRegion, data } = useSplitStore.getState();
  if (!split || !data || selectedRegion === null || cell < 0) return;
  const from = split.assignment[cell];
  if (from < 0 || from === selectedRegion) return;
  const assignment = Int32Array.from(split.assignment);
  assignment[cell] = selectedRegion;
  const regions = nameRegions(split.prepared, assignment, split.regions.length, data);
  useSplitStore.getState().set({
    split: {
      ...split,
      assignment,
      regions,
      edits: [...split.edits, { cell: data.cellIds[cell], from, to: selectedRegion }],
      // The dossiers describe the split as it was; the panel rebuilds them on demand.
      dossiers: null,
      setAnalysis: null,
    },
  });
}

export function currentPack() {
  const { split, data } = useSplitStore.getState();
  if (!split || !data) return null;
  return buildPack(split.prepared.spec, split.assignment, split.regions, data.meshVersion, {
    edits: split.edits,
    dossiers: split.dossiers ?? undefined,
    setAnalysis: split.setAnalysis ?? undefined,
  });
}

export function downloadPack() {
  void exportCurrent('pack');
}

/** The share link for the current split: its pack id if it is an unedited preset, else its spec. */
export function shareLink(): string {
  const { split, spec } = useSplitStore.getState();
  const hash =
    split?.source.kind === 'pack' && !split.edits.length
      ? encodeHash({ kind: 'pack', id: split.source.id })
      : encodeHash({ kind: 'split', spec: split?.prepared.spec ?? spec });
  return `${location.origin}${location.pathname}${hash}`;
}

/** The place nearest a clicked point, within about 30 km. */
export function nearestPlace(lng: number, lat: number) {
  const { data } = useSplitStore.getState();
  if (!data) return null;
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = null;
  let bestD = 0.3 * 0.3;
  for (const place of data.places) {
    const dx = (place.lng - lng) * kx;
    const dy = place.lat - lat;
    const d = dx * dx + dy * dy;
    if (d < bestD || (d === bestD && best && place.population > best.population)) {
      bestD = d;
      best = place;
    }
  }
  return best;
}

/** The whole set as Markdown (vision §7), as a download. */
export function downloadMarkdown() {
  void exportCurrent('markdown');
}

/** Compare the current split with a preset, or with actual Canada. */
export async function loadComparison(id: string): Promise<void> {
  await ensureSplitterData();
  const { data, split, library } = useSplitStore.getState();
  if (!data || !split) return;
  try {
    let other: ComparableSplit;
    let name: string;
    if (id === 'actual-canada') {
      other = actualCanada(data);
      name = 'Actual Canada';
    } else {
      const entry = library?.packs.find((p) => p.id === id);
      if (!entry) throw new Error(`no pack ${id}`);
      const pack = await loadPack(BASE, entry.file);
      const fit = fitPack(pack, data.meshVersion);
      if (fit.kind === 'unfittable') throw new Error(`${entry.name}: ${fit.reason}`);
      other = { assignment: pack.assignment, names: pack.regions.map((r) => r.name) };
      name = entry.name;
    }
    const mine: ComparableSplit = { assignment: split.assignment, names: split.regions.map((r) => r.name) };
    const graph = split.prepared.scopeGraph;
    useSplitStore.getState().set({
      compare: {
        id,
        name,
        assignment: other.assignment,
        names: other.names,
        colours: regionColours(graph, other.assignment, other.names.length),
        difference: compareSplits(mine, other, data),
        divider: useSplitStore.getState().compare?.divider ?? 0.5,
      },
    });
  } catch (err) {
    useSplitStore.getState().set({ error: message(err) });
  }
}

export function setDivider(divider: number) {
  const { compare } = useSplitStore.getState();
  if (compare)
    useSplitStore
      .getState()
      .set({ compare: { ...compare, divider: Math.min(0.95, Math.max(0.05, divider)) } });
}

export function stopComparing() {
  if (useSplitStore.getState().compare) useSplitStore.getState().set({ compare: null });
}

// --- Phase 5: import, export, the pack library, share links ---------------------------------------

/**
 * Whether a share link reproduces the split on screen. A link carries a spec (or a preset's id), so
 * it cannot carry hand edits, an imported map, a re-fit, or an imported snap layer.
 */
export function shareability(split: CurrentSplit | null): { ok: true } | { ok: false; reason: string } {
  if (!split) return { ok: false, reason: 'Generate or load a split first.' };
  if (split.edits.length)
    return { ok: false, reason: 'Edited by hand: download the pack or save it to keep the edits.' };
  if (split.source.kind === 'template' || split.prepared.spec.method === 'template')
    return { ok: false, reason: 'Made from an imported map, which a link cannot carry: download the pack.' };
  if (split.source.kind === 'file' && split.source.refit)
    return { ok: false, reason: 'Re-fitted from another mesh version: download the pack.' };
  if (split.prepared.spec.snap.includes(IMPORTED_SNAP))
    return { ok: false, reason: 'Snaps to an imported layer, which a link cannot carry: download the pack.' };
  return { ok: true };
}

function title(split: CurrentSplit): string {
  switch (split.source.kind) {
    case 'pack':
      return (
        useSplitStore.getState().library?.packs.find((p) => p.id === (split.source as { id: string }).id)
          ?.name ?? split.source.id
      );
    case 'file':
    case 'template':
      return split.source.name;
    default:
      return `${split.regions.length} regions`;
  }
}

export async function exportCurrent(format: ExportFormat): Promise<void> {
  const { split, data, topology } = useSplitStore.getState();
  const pack = currentPack();
  if (!split || !data || !topology || !pack) return;
  try {
    const input = exportInput(
      {
        title: title(split),
        assignment: split.assignment,
        regions: split.regions,
        colours: split.colours,
        dossiers: split.dossiers,
        setAnalysis: split.setAnalysis,
        pack,
      },
      data,
      topology,
    );
    const file = await exportFile(input, format);
    if (!file) {
      useSplitStore
        .getState()
        .set({ notice: 'The dossiers are still being written; try again in a moment.' });
      return;
    }
    saveFile(file, file.name);
  } catch (err) {
    useSplitStore.getState().set({ error: `export failed: ${message(err)}` });
  }
}

/** Show a decoded pack made on this mesh: its own recipe when it has one, its cells as they are. */
function showPack(pack: RegionPack, source: CurrentSplit['source']) {
  const { data } = useSplitStore.getState();
  if (!data) return;
  const spec = specFromPack(pack);
  const template = pack.meta.method === 'template';
  const fromCells = () => preparedFromAssignment({ ...spec, n: pack.regions.length }, pack.assignment, data);
  let prepared: PreparedSplit;
  try {
    // A recipe's own scope, carved metros included; a scope that needs context this page does not
    // have (another pack's region) falls back to the cells the pack assigns.
    prepared =
      template || (source.kind === 'file' && source.refit)
        ? fromCells()
        : prepareSplit(spec, data, context());
  } catch {
    prepared = fromCells();
  }
  useSplitStore.getState().replaceSpec(spec);
  // A template's names were chosen in the map it came from; anything else is named as it was generated.
  show(
    prepared,
    pack.assignment,
    source,
    template ? new Map(pack.regions.map((r) => [r.id, r.name])) : undefined,
  );
  const split = useSplitStore.getState().split;
  if (split && pack.meta.edits?.length) {
    useSplitStore.getState().set({ split: { ...split, edits: pack.meta.edits } });
  }
}

/** A pack from a file or the library. Another mesh version waits for the user's choice. */
export async function importPack(json: unknown, name: string): Promise<void> {
  await ensureSplitterData();
  const { data } = useSplitStore.getState();
  if (!data) return;
  try {
    const check = checkPack(json, data.meshVersion);
    if (check.kind === 'other-mesh') {
      useSplitStore
        .getState()
        .set({ pendingImport: { name, pack: check.pack, from: check.from, to: check.to } });
      return;
    }
    showPack(check.pack, { kind: 'file', name, refit: null });
    useSplitStore.getState().set({ pendingImport: null, error: null, notice: `Loaded ${name}.` });
  } catch (err) {
    useSplitStore.getState().set({ error: `${name}: ${message(err)}` });
  }
}

/** The pending pack re-fitted onto this mesh by nearest cell centre (keeps edits and templates). */
export async function refitPending(): Promise<void> {
  const { pendingImport, data } = useSplitStore.getState();
  if (!pendingImport || !data) return;
  try {
    const response = await fetch(`${MESH_ARCHIVE}mesh.${pendingImport.from}.json.gz`);
    if (!response.ok)
      throw new Error(`mesh ${pendingImport.from} is not available (HTTP ${response.status})`);
    const old = JSON.parse(new TextDecoder().decode(await maybeGunzip(await response.arrayBuffer()))) as {
      cells: { centroid: [number, number] }[];
    };
    const oldCentroids = Float64Array.from(old.cells.flatMap((c) => c.centroid));
    const assignment = refitAssignment(oldCentroids, pendingImport.pack.assignment, data.arrays.centroids);
    const pack = {
      ...pendingImport.pack,
      meta: { ...pendingImport.pack.meta, meshVersion: data.meshVersion },
      assignment,
    };
    showPack(pack, { kind: 'file', name: pendingImport.name, refit: pendingImport.from });
    useSplitStore.getState().set({
      pendingImport: null,
      notice: `Re-fitted ${pendingImport.name} from mesh ${pendingImport.from} onto ${data.meshVersion}.`,
    });
  } catch (err) {
    useSplitStore.getState().set({ error: `re-fit failed: ${message(err)}` });
  }
}

/** The pending pack regenerated from its seed and params on this mesh (unedited packs only). */
export async function regeneratePending(): Promise<void> {
  const { pendingImport, data } = useSplitStore.getState();
  if (!pendingImport || !data) return;
  const fit = fitPack(pendingImport.pack, data.meshVersion);
  if (fit.kind !== 'regenerate' || pendingImport.pack.meta.method === 'template') {
    useSplitStore
      .getState()
      .set({ error: `${pendingImport.name} has no recipe to rerun; re-fit it instead.` });
    return;
  }
  useSplitStore.getState().set({ pendingImport: null });
  useSplitStore.getState().replaceSpec(fit.spec);
  await runCurrentSpec();
}

export type ImportUse = 'template' | 'snap' | 'scope';

/** A GeoJSON or KML file as a template split, a snap layer, or the scope of the next run. */
export async function importGeo(text: string, name: string, use: ImportUse): Promise<void> {
  await ensureSplitterData();
  const { data, topology } = useSplitStore.getState();
  if (!data || !topology) return;
  try {
    const template = templateFromGeoJSON(parseGeoFile(text));
    if (use === 'scope') {
      useSplitStore.getState().setSpec({ scope: { kind: 'polygon', geometry: templateScope(template) } });
      useSplitStore.getState().set({ notice: `The scope is now ${name}; run a split to use it.` });
      return;
    }
    const assignment = assignByTemplate(template, data, topology);
    if (use === 'snap') {
      const { spec } = useSplitStore.getState();
      useSplitStore.getState().set({ importedSnap: { name, edges: templateSnapEdges(assignment, data) } });
      if (!spec.snap.includes(IMPORTED_SNAP))
        useSplitStore.getState().setSpec({ snap: [...spec.snap, IMPORTED_SNAP] });
      useSplitStore.getState().set({ notice: `${name} is a snap layer for the next run.` });
      return;
    }
    // Template: region ids must be 0..k-1 for the split; keep the file's order.
    const ids = [...new Set(template.regions.map((r) => r.id))].sort((a, b) => a - b);
    const dense = new Map(ids.map((id, i) => [id, i]));
    const cells = assignment.map((r) => (r < 0 ? -1 : (dense.get(r) ?? -1)));
    if (!cells.some((r) => r >= 0)) throw new Error('the polygons cover no mesh cell');
    const spec = {
      ...useSplitStore.getState().spec,
      method: 'template' as const,
      n: ids.length,
      scope: { kind: 'polygon' as const, geometry: templateScope(template) },
    };
    const names = new Map(template.regions.map((r) => [dense.get(r.id) ?? -1, r.name]));
    show(preparedFromAssignment(spec, cells, data), cells, { kind: 'template', name }, names);
    useSplitStore.getState().set({ notice: `${name}: ${ids.length} regions from the file.` });
  } catch (err) {
    useSplitStore.getState().set({ error: `${name}: ${message(err)}` });
  }
}

export async function saveCurrentToLibrary(name: string): Promise<boolean> {
  const pack = currentPack();
  if (!pack) return false;
  const result = await savePack(name, pack);
  useSplitStore
    .getState()
    .set(
      result.ok
        ? { notice: `Saved ${name} in this browser.` }
        : { error: `Could not save: ${result.reason}` },
    );
  return result.ok;
}

export async function loadFromLibrary(id: string, name: string): Promise<void> {
  const result = await getSaved(id);
  if (!result.ok) {
    useSplitStore.getState().set({ error: `Could not load ${name}: ${result.reason}` });
    return;
  }
  await importPack(result.value, name);
}
