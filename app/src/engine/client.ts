import type { MeshArrays } from './graph';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { Columns, Params, Progress, SolveResult } from './solver';

/** Main-thread handle on the solver worker: one worker, runs identified by id, each cancellable. */
export interface SolveRun {
  id: number;
  result: Promise<SolveResult>;
  cancel(): void;
}

export class SolverClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (r: SolveResult) => void; reject: (e: Error) => void; onProgress?: (p: Progress) => void }
  >();

  /** What the worker already holds, so each array crosses the thread boundary once. */
  private sentMesh: MeshArrays | null = null;
  private readonly sentColumns = new Map<string, Columns[string]>();

  constructor(private readonly worker: Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'>) {
    worker.addEventListener('message', (event) => this.receive((event as MessageEvent<WorkerResponse>).data));
  }

  static create(): SolverClient {
    return new SolverClient(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
  }

  /**
   * Give the worker the mesh and the columns a run needs. Only what it does not hold yet is sent: the
   * mesh once, and each column the first time it is needed (the main thread keeps its copies, so these
   * are structured-cloned, not transferred).
   */
  init(mesh: MeshArrays, columns: Columns) {
    const fresh = this.sentMesh !== mesh;
    if (fresh) {
      this.sentMesh = mesh;
      this.sentColumns.clear();
    }
    const missing = Object.fromEntries(
      Object.entries(columns).filter(([name, column]) => this.sentColumns.get(name) !== column),
    );
    if (!fresh && Object.keys(missing).length === 0) return;
    for (const [name, column] of Object.entries(missing)) this.sentColumns.set(name, column);
    this.post(fresh ? { type: 'init', mesh, columns: missing } : { type: 'init', columns: missing });
  }

  run(
    mask: Uint8Array,
    params: Params,
    seed: number,
    options: { template?: Int32Array; snapEdges?: Uint8Array; onProgress?: (p: Progress) => void } = {},
  ): SolveRun {
    const id = this.nextId++;
    const result = new Promise<SolveResult>((resolve, reject) =>
      this.pending.set(id, { resolve, reject, onProgress: options.onProgress }),
    );
    // The template is an assignment made for this run alone, so its buffer is transferred, not copied.
    // The mask and snap edges stay with the prepared split on the main thread, so they are cloned.
    this.post(
      { type: 'run', id, mask, params, seed, template: options.template, snapEdges: options.snapEdges },
      options.template ? [options.template.buffer] : [],
    );
    return { id, result, cancel: () => this.post({ type: 'cancel', id }) };
  }

  terminate() {
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(new Error('solver terminated'));
    this.pending.clear();
  }

  private post(message: WorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer);
  }

  private receive(message: WorkerResponse) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (message.type === 'progress') {
      entry.onProgress?.(message.progress);
      return;
    }
    this.pending.delete(message.id);
    if (message.type === 'done') entry.resolve(message.result);
    else entry.reject(new Error(message.message));
  }
}
