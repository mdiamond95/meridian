import type { SplitterData, SplitterUrls } from '../splitter/data';
import { describe, land, type Described, type Landed } from '../splitter/land';
import { ringBuffers, type CellTopology } from '../splitter/outline';
import { prepareFromScope, type NamedRegion, type PreparedSplit, type SplitSpec } from '../splitter/split';
import { solveSteps, type Progress, type SolveResult } from './solver';

/**
 * Messages between the app and the splitter worker, and the host that answers them.
 *
 * Since release 1.0.1 the worker holds its own copy of the splitter data and the cell topology
 * (`load`), so everything after the scope is known happens here: preparing the split, solving it,
 * naming and colouring the regions, writing the dossiers, the set analysis and the scores, and
 * dissolving the rings to draw (`land`). Splits made elsewhere (presets, files, nested trees) are
 * described here too (`describe`). The main thread computes only the scope mask, which needs the
 * atlas or a parent pack, and stores what comes back.
 *
 * The host is plain code with an injected `post`, `schedule` and data loader, so it runs the same in
 * the Web Worker (src/engine/worker.ts) and in a unit test. A solve advances in chunks, each scheduled
 * as its own task, which is what lets a `cancel` message arrive between chunks.
 */

export type WorkerRequest =
  | { type: 'load'; urls: SplitterUrls; cells: string }
  | {
      type: 'land';
      id: number;
      spec: SplitSpec;
      /** 1 per mesh cell in the scope */
      scope: Uint8Array;
      importedSnap?: ReadonlySet<number>;
    }
  | {
      type: 'describe';
      id: number;
      prepared: PreparedSplit;
      assignment: Int32Array;
      regions: Pick<NamedRegion, 'id' | 'name' | 'pieces'>[];
      manualNames: Record<number, string>;
    }
  | { type: 'cancel'; id: number };

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: Progress }
  | { type: 'landed'; id: number; prepared: PreparedSplit; landed: Landed }
  | { type: 'described'; id: number; described: Described }
  | { type: 'error'; id: number; message: string };

export type Post = (message: WorkerResponse, transfer?: Transferable[]) => void;

export interface WorkerData {
  data: SplitterData;
  topo: CellTopology;
}

export type LoadWorkerData = (urls: SplitterUrls, cells: string) => Promise<WorkerData>;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createSolverHost(
  post: Post,
  schedule: (task: () => void) => void = (task) => setTimeout(task, 0),
  loadData: LoadWorkerData = () => Promise.reject(new Error('no data loader')),
) {
  let ready: Promise<WorkerData> | null = null;
  const cancelled = new Set<number>();

  function loaded(id: number): Promise<WorkerData | null> {
    if (!ready) {
      post({ type: 'error', id, message: 'splitter worker has no data yet' });
      return Promise.resolve(null);
    }
    return ready.catch((err: unknown) => {
      post({ type: 'error', id, message: `splitter worker could not load its data: ${messageOf(err)}` });
      return null;
    });
  }

  async function landRequest(request: Extract<WorkerRequest, { type: 'land' }>) {
    const { id } = request;
    const worker = await loaded(id);
    if (!worker) return;
    const { data, topo } = worker;
    let prepared: PreparedSplit;
    let steps: Generator<Progress, SolveResult, boolean | undefined>;
    try {
      prepared = prepareFromScope(request.spec, request.scope, data, request.importedSnap);
      steps = solveSteps({
        mesh: data.arrays,
        graph: prepared.solveGraph,
        columns: data.columns,
        params: prepared.params,
        seed: request.spec.seed,
        snapEdges: prepared.snap,
      });
    } catch (err) {
      post({ type: 'error', id, message: messageOf(err) });
      return;
    }
    const step = () => {
      try {
        const next = steps.next(cancelled.has(id));
        if (!next.done) {
          post({ type: 'progress', id, progress: next.value });
          schedule(step);
          return;
        }
        cancelled.delete(id);
        const landed = land(data, topo, prepared, next.value);
        // The assignment and the rings are made for this message alone, so they are transferred. The
        // prepared split is cloned: its scope graphs stay in this worker's cache.
        post({ type: 'landed', id, prepared, landed }, [
          landed.assignment.buffer,
          ...ringBuffers(landed.rings),
        ]);
      } catch (err) {
        post({ type: 'error', id, message: messageOf(err) });
      }
    };
    schedule(step);
  }

  async function describeRequest(request: Extract<WorkerRequest, { type: 'describe' }>) {
    const worker = await loaded(request.id);
    if (!worker) return;
    try {
      const described = describe(
        worker.data,
        worker.topo,
        request.prepared,
        request.assignment,
        request.regions,
        request.manualNames,
      );
      post({ type: 'described', id: request.id, described });
    } catch (err) {
      post({ type: 'error', id: request.id, message: messageOf(err) });
    }
  }

  return {
    handle(message: WorkerRequest): Promise<void> {
      switch (message.type) {
        case 'load':
          ready ??= loadData(message.urls, message.cells);
          return ready.then(() => undefined).catch(() => undefined);
        case 'land':
          return landRequest(message);
        case 'describe':
          return describeRequest(message);
        case 'cancel':
          cancelled.add(message.id);
          return Promise.resolve();
      }
    },
  };
}
