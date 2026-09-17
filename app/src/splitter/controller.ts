import { resolvedAt } from '../atlas/resolve';
import { SolverClient } from '../engine/client';
import type { Columns } from '../engine/solver';
import { useAtlasStore } from '../state/atlasStore';
import { useSplitStore, type CurrentSplit } from '../state/splitStore';
import { CELLS_URL, SPLITTER_URLS } from './assets';
import { loadCellTopology, loadSplitterData } from './data';
import { buildPack, fitPack, loadLibrary, loadPack, specFromPack } from './pack';
import { regionColours } from './palette';
import { cellTopology } from './outline';
import { finishSplit, nameRegions, prepareSplit, type PreparedSplit, type SplitSpec } from './split';
import { encodeHash } from './url';

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
  const { regionSource } = useSplitStore.getState();
  return { atlas: atlas ?? undefined, packAssignment: regionSource ?? undefined };
}

/** The columns a run reads, so the worker is not sent all eighty. */
function neededColumns(spec: SplitSpec, columns: Columns): Columns {
  const names = new Set(['population', 'gdp_estimate', ...Object.keys(spec.lens)]);
  if (spec.balance && !['cells', 'area'].includes(spec.balance)) names.add(spec.balance);
  return Object.fromEntries([...names].filter((n) => columns[n]).map((n) => [n, columns[n]]));
}

function show(prepared: PreparedSplit, assignment: Int32Array, source: CurrentSplit['source']) {
  const { data } = useSplitStore.getState();
  if (!data) return;
  const finished = { assignment, regions: nameRegions(prepared, assignment, countRegions(assignment), data) };
  useSplitStore.getState().set({
    split: {
      prepared,
      assignment: finished.assignment,
      regions: finished.regions,
      colours: regionColours(prepared.scopeGraph, finished.assignment, finished.regions.length),
      edits: [],
      source,
    },
    selectedRegion: null,
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
    },
  });
}

export function currentPack() {
  const { split, data } = useSplitStore.getState();
  if (!split || !data) return null;
  return buildPack(split.prepared.spec, split.assignment, split.regions, data.meshVersion, split.edits);
}

export function downloadPack() {
  const pack = currentPack();
  if (!pack) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(pack)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `meridian-${pack.meta.method}-${pack.regions.length}-seed${pack.meta.seed}.json`;
  a.click();
  URL.revokeObjectURL(url);
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
