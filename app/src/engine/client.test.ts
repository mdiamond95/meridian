// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { defaultSpec } from '../splitter/split';
import { SolverClient } from './client';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** A stand-in worker that records what the client posts and what it would transfer. */
function fakeWorker() {
  const posted: { message: WorkerRequest; transfer: Transferable[] }[] = [];
  let listener: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  return {
    posted,
    reply: (message: WorkerResponse) => listener?.({ data: message } as MessageEvent<WorkerResponse>),
    worker: {
      postMessage: (message: WorkerRequest, transfer: Transferable[] = []) =>
        posted.push({ message, transfer }),
      addEventListener: (_: string, l: (event: MessageEvent<WorkerResponse>) => void) => (listener = l),
      terminate: () => {},
    } as unknown as Worker,
  };
}

const urls = { mesh: 'm.gz', attrs: 'a.gz', places: 'p.gz', snap: 's.gz' };

describe('splitter client (release 1.0.1)', () => {
  it('asks the worker to load its own data once per set of artefacts', () => {
    const { worker, posted } = fakeWorker();
    const client = new SolverClient(worker);
    client.load(urls, 'cells.gz');
    client.load(urls, 'cells.gz');
    expect(posted.map((p) => p.message)).toEqual([{ type: 'load', urls, cells: 'cells.gz' }]);
    client.load({ ...urls, attrs: 'a2.gz' }, 'cells.gz');
    expect(posted).toHaveLength(2);
  });

  it('sends a spec and a transferred scope mask, never the mesh, and routes the reply', async () => {
    const { worker, posted, reply } = fakeWorker();
    const client = new SolverClient(worker);
    const scope = new Uint8Array(8);
    const progress: number[] = [];
    const run = client.land(defaultSpec(), scope, { onProgress: (p) => progress.push(p.iteration) });
    expect(posted[0].message.type).toBe('land');
    expect(posted[0].transfer).toEqual([scope.buffer]);
    reply({ type: 'progress', id: run.id, progress: { iteration: 5, iterations: 10, cost: 1, best: 1 } });
    reply({ type: 'landed', id: run.id, prepared: {} as never, landed: { colours: ['#000'] } as never });
    await expect(run.result).resolves.toMatchObject({ landed: { colours: ['#000'] } });
    expect(progress).toEqual([5]);
    run.cancel();
    expect(posted.at(-1)?.message).toEqual({ type: 'cancel', id: run.id });
  });

  it('describes with only what the worker needs of each region, and rejects on error', async () => {
    const { worker, posted, reply } = fakeWorker();
    const client = new SolverClient(worker);
    const described = client.describe(
      {} as never,
      new Int32Array(2),
      [{ id: 0, name: 'A', pieces: 1, population: 9 } as never],
      {},
    );
    const message = posted[0].message;
    expect(message.type === 'describe' && message.regions).toEqual([{ id: 0, name: 'A', pieces: 1 }]);
    reply({ type: 'error', id: 1, message: 'no' });
    await expect(described).rejects.toThrow('no');
  });
});
