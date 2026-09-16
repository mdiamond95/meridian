// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { scopeMask } from './graph';
import { createSolverHost, type WorkerResponse } from './protocol';
import { defaultParams } from './solver';
import { realData } from './testing/realData';

function host() {
  const messages: WorkerResponse[] = [];
  const queue: (() => void)[] = [];
  const h = createSolverHost(
    (m) => messages.push(m),
    (task) => queue.push(task),
  );
  const drain = (limit = 10_000) => {
    for (let i = 0; i < limit; i++) {
      const task = queue.shift();
      if (!task) break;
      task();
    }
  };
  return { h, messages, queue, drain };
}

describe('solver worker protocol', () => {
  const data = realData();
  const mask = scopeMask(data.mesh, { kind: 'province', province: 'AB' }, { provinces: data.provinces });

  it('reports progress, then the result', () => {
    const { h, messages, drain } = host();
    h.handle({ type: 'init', mesh: data.mesh, columns: data.columns });
    h.handle({
      type: 'run',
      id: 1,
      mask,
      params: { ...defaultParams(5, 'balanced'), iterations: 20_000 },
      seed: 3,
    });
    drain();
    expect(messages.some((m) => m.type === 'progress')).toBe(true);
    const done = messages[messages.length - 1];
    expect(done.type).toBe('done');
    if (done.type === 'done') expect(done.result.regions).toHaveLength(5);
  });

  it('stops at the next chunk when cancelled', () => {
    const { h, messages, drain, queue } = host();
    h.handle({ type: 'init', mesh: data.mesh, columns: data.columns });
    h.handle({
      type: 'run',
      id: 7,
      mask,
      params: { ...defaultParams(5, 'balanced'), iterations: 500_000, plateau: 1e9 },
      seed: 3,
    });
    queue.shift()?.(); // first chunk
    h.handle({ type: 'cancel', id: 7 });
    drain();
    const done = messages[messages.length - 1];
    expect(done.type).toBe('done');
    if (done.type === 'done') {
      expect(done.result.stoppedBy).toBe('cancelled');
      expect(done.result.iterations).toBeLessThan(500_000);
    }
  });

  it('answers errors as messages', () => {
    const { h, messages, drain } = host();
    h.handle({ type: 'run', id: 2, mask, params: defaultParams(3, 'balanced'), seed: 1 });
    expect(messages).toEqual([{ type: 'error', id: 2, message: 'solver worker not initialised' }]);
    h.handle({ type: 'init', mesh: data.mesh, columns: data.columns });
    h.handle({ type: 'run', id: 3, mask, params: { ...defaultParams(3, 'template') }, seed: 1 });
    drain();
    expect(messages.at(-1)).toMatchObject({
      type: 'error',
      id: 3,
      message: expect.stringMatching(/template/),
    });
  });
});
