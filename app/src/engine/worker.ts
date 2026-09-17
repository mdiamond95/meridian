/// <reference lib="webworker" />
import { createSolverHost, type WorkerRequest } from './protocol';

/** The solver in a Web Worker, so a 40k-cell partition never blocks the map (plan Phase 3). */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const host = createSolverHost((message, transfer) => scope.postMessage(message, transfer ?? []));
scope.onmessage = (event: MessageEvent<WorkerRequest>) => host.handle(event.data);
