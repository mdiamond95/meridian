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

  constructor(private readonly worker: Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'>) {
    worker.addEventListener('message', (event) => this.receive((event as MessageEvent<WorkerResponse>).data));
  }

  static create(): SolverClient {
    return new SolverClient(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
  }

  init(mesh: MeshArrays, columns: Columns) {
    this.post({ type: 'init', mesh, columns });
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
    this.post({
      type: 'run',
      id,
      mask,
      params,
      seed,
      template: options.template,
      snapEdges: options.snapEdges,
    });
    return { id, result, cancel: () => this.post({ type: 'cancel', id }) };
  }

  terminate() {
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(new Error('solver terminated'));
    this.pending.clear();
  }

  private post(message: WorkerRequest) {
    this.worker.postMessage(message);
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
