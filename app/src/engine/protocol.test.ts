// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { describe as describeSplit, manualNamesFor } from '../splitter/land';
import { decodeRings, regionRings } from '../splitter/outline';
import { defaultSpec, runSplit, scopeOf, type SplitSpec } from '../splitter/split';
import { realCellTopology, realSplitterData } from '../splitter/testing/realSplitterData';
import { regionColours } from '../splitter/palette';
import { createSolverHost, type WorkerResponse } from './protocol';

/** The splitter worker's host (release 1.0.1): it loads its own data, then lands and describes splits. */

const data = realSplitterData();
const topo = realCellTopology();
const urls = { mesh: 'm', attrs: 'a', places: 'p', snap: 's' };

function host() {
  const messages: { message: WorkerResponse; transfer?: Transferable[] }[] = [];
  const queue: (() => void)[] = [];
  const h = createSolverHost(
    (message, transfer) => messages.push({ message, transfer }),
    (task) => queue.push(task),
    async () => ({ data, topo }),
  );
  const drain = (limit = 100_000) => {
    for (let i = 0; i < limit; i++) {
      const task = queue.shift();
      if (!task) break;
      task();
    }
  };
  const last = () => messages[messages.length - 1];
  return { h, messages, queue, drain, last };
}

const spec = (over: Partial<SplitSpec> = {}): SplitSpec => ({
  ...defaultSpec(),
  scope: { kind: 'province', province: 'NS' },
  method: 'balanced',
  n: 3,
  seed: 3,
  iterations: 20_000,
  ...over,
});

describe('splitter worker protocol', () => {
  it('lands a split with everything the main thread used to compute, identical to the old path', async () => {
    const { h, messages, drain, last } = host();
    await h.handle({ type: 'load', urls, cells: 'c' });
    const s = spec();
    await h.handle({ type: 'land', id: 1, spec: s, scope: scopeOf(s, data) });
    drain();
    expect(messages.some((m) => m.message.type === 'progress')).toBe(true);
    const done = last();
    expect(done.message.type).toBe('landed');
    if (done.message.type !== 'landed') return;
    const { landed, prepared } = done.message;

    // The pre-1.0.1 path, on one thread: runSplit, then the controller's colours and describeSplit.
    const reference = runSplit(s, data);
    expect(landed.assignment).toEqual(reference.finished.assignment);
    expect(landed.colours).toEqual(
      regionColours(
        reference.prepared.scopeGraph,
        reference.finished.assignment,
        reference.finished.regions.length,
      ),
    );
    const described = describeSplit(
      data,
      topo,
      reference.prepared,
      reference.finished.assignment,
      reference.finished.regions,
      manualNamesFor(reference.prepared, reference.finished.regions, false),
    );
    expect(landed.dossiers).toEqual(described.dossiers);
    expect(landed.setAnalysis).toEqual(described.setAnalysis);
    expect(landed.scores).toEqual(described.scores);
    expect(landed.regions.map((r) => r.name)).toEqual(described.names);
    expect(decodeRings(landed.rings)).toEqual(regionRings(topo, reference.finished.assignment));
    expect(prepared.solveMask).toEqual(reference.prepared.solveMask);

    // The assignment and the rings are transferred, not copied.
    expect(done.transfer).toContain(landed.assignment.buffer);
    expect(done.transfer).toContain(landed.rings.coords.buffer);
  }, 60_000);

  it('stops at the next chunk when cancelled', async () => {
    const { h, drain, queue, last } = host();
    await h.handle({ type: 'load', urls, cells: 'c' });
    const s = spec({ iterations: 500_000 });
    await h.handle({ type: 'land', id: 7, spec: { ...s }, scope: scopeOf(s, data) });
    queue.shift()?.(); // first chunk
    await h.handle({ type: 'cancel', id: 7 });
    drain();
    expect(last().message.type).toBe('landed');
  }, 60_000);

  it('describes a split made on the main thread', async () => {
    const { h, last } = host();
    await h.handle({ type: 'load', urls, cells: 'c' });
    const { prepared, finished } = runSplit(
      spec({ scope: { kind: 'province', province: 'PE' }, n: 2 }),
      data,
    );
    const manualNames = manualNamesFor(prepared, finished.regions, false);
    await h.handle({
      type: 'describe',
      id: 4,
      prepared,
      assignment: finished.assignment,
      regions: finished.regions,
      manualNames,
    });
    expect(last().message).toEqual({
      type: 'described',
      id: 4,
      described: describeSplit(data, topo, prepared, finished.assignment, finished.regions, manualNames),
    });
  }, 60_000);

  it('answers errors as messages', async () => {
    const { h, messages, drain, last } = host();
    const s = spec();
    await h.handle({ type: 'land', id: 2, spec: s, scope: scopeOf(s, data) });
    expect(messages.map((m) => m.message)).toEqual([
      { type: 'error', id: 2, message: 'splitter worker has no data yet' },
    ]);
    await h.handle({ type: 'load', urls, cells: 'c' });
    const template = spec({ method: 'template' });
    await h.handle({ type: 'land', id: 3, spec: template, scope: scopeOf(template, data) });
    drain();
    expect(last().message).toMatchObject({
      type: 'error',
      id: 3,
      message: expect.stringMatching(/template/),
    });
  }, 60_000);

  it('reports a data load that failed', async () => {
    const messages: WorkerResponse[] = [];
    const h = createSolverHost(
      (m) => messages.push(m),
      (t) => t(),
      async () => {
        throw new Error('offline');
      },
    );
    await h.handle({ type: 'load', urls, cells: 'c' });
    const s = spec();
    await h.handle({ type: 'land', id: 5, spec: s, scope: scopeOf(s, data) });
    expect(messages).toEqual([
      { type: 'error', id: 5, message: 'splitter worker could not load its data: offline' },
    ]);
  });
});
