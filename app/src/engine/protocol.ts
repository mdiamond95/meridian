import { buildScopeGraph, type MeshArrays } from './graph';
import { solveSteps, type Columns, type Params, type Progress, type SolveResult } from './solver';

/**
 * Messages between the app and the solver worker, and the host that answers them.
 *
 * The host is plain code with an injected `post` and `schedule`, so it runs the same in a Web
 * Worker (src/engine/worker.ts) and in a unit test. A run advances in chunks, each scheduled as its
 * own task, which is what lets a `cancel` message arrive between chunks.
 */

export type WorkerRequest =
  /**
   * The mesh once, then columns as runs first need them: the worker keeps both, so a run sends only
   * its mask, parameters and (transferred) template, never the mesh again.
   */
  | { type: 'init'; mesh?: MeshArrays; columns: Columns }
  | {
      type: 'run';
      id: number;
      /** 1 per mesh cell in the scope */
      mask: Uint8Array;
      params: Params;
      seed: number;
      template?: Int32Array;
      snapEdges?: Uint8Array;
    }
  | { type: 'cancel'; id: number };

export type WorkerResponse =
  | { type: 'progress'; id: number; progress: Progress }
  | { type: 'done'; id: number; result: SolveResult; crossings: number }
  | { type: 'error'; id: number; message: string };

export type Post = (message: WorkerResponse, transfer?: Transferable[]) => void;

export function createSolverHost(
  post: Post,
  schedule: (task: () => void) => void = (task) => setTimeout(task, 0),
) {
  let mesh: MeshArrays | null = null;
  let columns: Columns = {};
  const cancelled = new Set<number>();

  function run(request: Extract<WorkerRequest, { type: 'run' }>) {
    const { id } = request;
    if (!mesh) {
      post({ type: 'error', id, message: 'solver worker not initialised' });
      return;
    }
    let steps: Generator<Progress, SolveResult, boolean | undefined>;
    let crossings = 0;
    try {
      const graph = buildScopeGraph(mesh, request.mask);
      crossings = graph.crossings;
      steps = solveSteps({
        mesh,
        graph,
        columns,
        params: request.params,
        seed: request.seed,
        template: request.template,
        snapEdges: request.snapEdges,
      });
    } catch (err) {
      post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const step = () => {
      try {
        const next = steps.next(cancelled.has(id));
        if (next.done) {
          cancelled.delete(id);
          post({ type: 'done', id, result: next.value, crossings }, [next.value.assignment.buffer]);
          return;
        }
        post({ type: 'progress', id, progress: next.value });
        schedule(step);
      } catch (err) {
        post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
      }
    };
    schedule(step);
  }

  return {
    handle(message: WorkerRequest) {
      switch (message.type) {
        case 'init':
          if (message.mesh) {
            mesh = message.mesh;
            columns = {};
          }
          columns = { ...columns, ...message.columns };
          break;
        case 'run':
          run(message);
          break;
        case 'cancel':
          cancelled.add(message.id);
          break;
      }
    },
  };
}
