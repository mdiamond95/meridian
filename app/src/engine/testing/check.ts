import type { ScopeGraph } from '../graph';

/** Pieces of each region in a mesh-indexed assignment, by a search independent of the solver. */
export function piecesByRegion(graph: ScopeGraph, assignment: Int32Array): Map<number, number> {
  const seen = new Uint8Array(graph.size);
  const pieces = new Map<number, number>();
  for (let s = 0; s < graph.size; s++) {
    if (seen[s]) continue;
    const region = assignment[graph.cells[s]];
    pieces.set(region, (pieces.get(region) ?? 0) + 1);
    seen[s] = 1;
    const stack = [s];
    while (stack.length) {
      const u = stack.pop() as number; // the loop checks length
      for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
        const v = graph.targets[e];
        if (!seen[v] && assignment[graph.cells[v]] === region) {
          seen[v] = 1;
          stack.push(v);
        }
      }
    }
  }
  return pieces;
}

export async function sha256(bytes: ArrayBufferView): Promise<string> {
  // Copy into a plain ArrayBuffer: subtle.digest does not take views over shared buffers.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
