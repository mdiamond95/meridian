/// <reference lib="webworker" />
import { loadCellTopology, loadSplitterData } from '../splitter/data';
import { cellTopology } from '../splitter/outline';
import { createSolverHost, type WorkerRequest } from './protocol';

/**
 * The splitter in a Web Worker, so a 40k-cell partition never blocks the map (plan Phase 3), and
 * since release 1.0.1 its dossiers and rings neither. The worker loads its own splitter data and cell
 * topology, from the IndexedDB cache when it is warm, the same way the page does.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
const host = createSolverHost(
  (message, transfer) => scope.postMessage(message, transfer ?? []),
  (task) => setTimeout(task, 0),
  async (urls, cells) => {
    const [{ data }, topology] = await Promise.all([loadSplitterData(urls), loadCellTopology(cells)]);
    return { data, topo: cellTopology(topology) };
  },
);
scope.onmessage = (event: MessageEvent<WorkerRequest>) => void host.handle(event.data);
