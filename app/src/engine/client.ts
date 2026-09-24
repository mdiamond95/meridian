import type { SplitterUrls } from '../splitter/data';
import type { Described, Landed } from '../splitter/land';
import type { NamedRegion, PreparedSplit, SplitSpec } from '../splitter/split';
import type { WorkerRequest, WorkerResponse } from './protocol';
import type { Progress } from './solver';

/** Main-thread handle on the splitter worker: one worker, requests identified by id, runs cancellable. */
export interface LandRun {
  id: number;
  result: Promise<{ prepared: PreparedSplit; landed: Landed }>;
  cancel(): void;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  onProgress?: (p: Progress) => void;
}

export class SolverClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private loadedFrom: string | null = null;

  constructor(private readonly worker: Pick<Worker, 'postMessage' | 'addEventListener' | 'terminate'>) {
    worker.addEventListener('message', (event) => this.receive((event as MessageEvent<WorkerResponse>).data));
  }

  static create(): SolverClient {
    return new SolverClient(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
  }

  /** Have the worker load its own copy of the splitter data and the cell topology (once per URLs). */
  load(urls: SplitterUrls, cells: string) {
    const key = JSON.stringify([urls, cells]);
    if (this.loadedFrom === key) return;
    this.loadedFrom = key;
    this.post({ type: 'load', urls, cells });
  }

  /** Prepare, solve and describe a split in the worker, from its spec and the scope mask. */
  land(
    spec: SplitSpec,
    scope: Uint8Array,
    options: { importedSnap?: ReadonlySet<number>; onProgress?: (p: Progress) => void } = {},
  ): LandRun {
    const id = this.nextId++;
    const result = this.expect<{ prepared: PreparedSplit; landed: Landed }>(id, options.onProgress);
    // The mask is made for this request alone, so its buffer is transferred rather than copied.
    this.post({ type: 'land', id, spec, scope, importedSnap: options.importedSnap }, [scope.buffer]);
    return { id, result, cancel: () => this.post({ type: 'cancel', id }) };
  }

  /** Dossiers, set analysis and scores for a split made on the main thread (a preset, a file). */
  describe(
    prepared: PreparedSplit,
    assignment: Int32Array,
    regions: Pick<NamedRegion, 'id' | 'name' | 'pieces'>[],
    manualNames: Record<number, string>,
  ): Promise<Described> {
    const id = this.nextId++;
    const result = this.expect<Described>(id);
    this.post({
      type: 'describe',
      id,
      prepared,
      assignment,
      regions: regions.map(({ id, name, pieces }) => ({ id, name, pieces })),
      manualNames,
    });
    return result;
  }

  terminate() {
    this.worker.terminate();
    for (const { reject } of this.pending.values()) reject(new Error('splitter worker terminated'));
    this.pending.clear();
  }

  private expect<T>(id: number, onProgress?: (p: Progress) => void): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (value: never) => void, reject, onProgress }),
    );
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
    if (message.type === 'landed')
      entry.resolve({ prepared: message.prepared, landed: message.landed } as never);
    else if (message.type === 'described') entry.resolve(message.described as never);
    else entry.reject(new Error(message.message));
  }
}
