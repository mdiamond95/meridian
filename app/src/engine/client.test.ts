// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SolverClient } from './client';
import type { MeshArrays } from './graph';
import { scopeMask } from './graph';
import { createSolverHost, type WorkerRequest, type WorkerResponse } from './protocol';
import { defaultParams } from './solver';
import { realData } from './testing/realData';

/** A stand-in worker that records what the client posts and what it would transfer. */
function fakeWorker() {
  const posted: { message: WorkerRequest; transfer: Transferable[] }[] = [];
  return {
    posted,
    worker: {
      postMessage: (message: WorkerRequest, transfer: Transferable[] = []) =>
        posted.push({ message, transfer }),
      addEventListener: () => {},
      terminate: () => {},
    } as unknown as Worker,
  };
}

const mesh = (): MeshArrays => ({
  offsets: new Int32Array([0, 1, 2]),
  targets: new Int32Array([1, 0]),
  centroids: new Float64Array(4),
  areas: new Float64Array(2),
});

describe('solver client: what crosses to the worker (plan Phase 7 §1)', () => {
  it('sends the mesh once and each column the first time a run needs it', () => {
    const { worker, posted } = fakeWorker();
    const client = new SolverClient(worker);
    const m = mesh();
    const population = new Float32Array(2);
    const gdp = new Float32Array(2);
    client.init(m, { population });
    client.init(m, { population });
    client.init(m, { population, gdp });
    expect(posted.map((p) => p.message)).toEqual([
      { type: 'init', mesh: m, columns: { population } },
      { type: 'init', columns: { gdp } },
    ]);
    // A new mesh (another version) starts over.
    const other = mesh();
    client.init(other, { population });
    expect(posted[2].message).toEqual({ type: 'init', mesh: other, columns: { population } });
  });

  it('transfers a template assignment instead of copying it, and clones the mask', () => {
    const { worker, posted } = fakeWorker();
    const client = new SolverClient(worker);
    const template = new Int32Array(8);
    const mask = new Uint8Array(8);
    client.run(mask, defaultParams(2, 'balanced'), 1, { template });
    expect(posted[0].transfer).toEqual([template.buffer]);
    client.run(mask, defaultParams(2, 'balanced'), 1);
    expect(posted[1].transfer).toEqual([]);
  });
});

describe('solver host: columns arrive in parts', () => {
  const data = realData();
  const mask = scopeMask(data.mesh, { kind: 'province', province: 'PE' }, { provinces: data.provinces });

  it('runs on columns sent after the mesh, and transfers the assignment back', () => {
    const messages: { message: WorkerResponse; transfer?: Transferable[] }[] = [];
    const queue: (() => void)[] = [];
    const h = createSolverHost(
      (message, transfer) => messages.push({ message, transfer }),
      (task) => queue.push(task),
    );
    h.handle({ type: 'init', mesh: data.mesh, columns: {} });
    h.handle({ type: 'init', columns: { population: data.columns.population } });
    h.handle({
      type: 'run',
      id: 1,
      mask,
      params: { ...defaultParams(2, 'balanced'), iterations: 2_000 },
      seed: 1,
    });
    for (let i = 0; i < 10_000 && queue.length; i++) queue.shift()?.();
    const last = messages[messages.length - 1];
    expect(last.message.type).toBe('done');
    if (last.message.type === 'done') expect(last.transfer).toEqual([last.message.result.assignment.buffer]);
  });
});
