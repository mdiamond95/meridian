import type { ScopeGraph } from '../engine/graph';
import type { SplitterData } from './data';

/**
 * Snap layers (plan Phase 3 Sitting B §2): a region boundary that runs along one of these earns the
 * solver's snap bonus. Each layer marks graph edges: a partition layer marks edges whose two cells
 * fall in different parts; the river layer marks edges that cross a river (from snap.v1).
 */

export interface SnapLayer {
  id: string;
  label: string;
  available: boolean;
  note?: string;
}

export const SNAP_LAYERS: SnapLayer[] = [
  { id: 'rivers', label: 'Rivers (Strahler 7+)', available: true },
  { id: 'basins', label: 'Drainage basins', available: true },
  { id: 'continental_divide', label: 'Continental Divide', available: true },
  { id: 'treaties', label: 'Treaty boundaries', available: true },
  {
    id: 'township',
    label: 'Township and range lines',
    available: false,
    note: 'No Dominion Land Survey data in the pipeline yet',
  },
  { id: 'cd', label: 'Census division edges', available: true },
  { id: 'csd', label: 'Census subdivision edges', available: true },
  { id: 'graticule', label: 'Parallels and meridians (0.5°)', available: true },
  { id: 'ridings', label: 'Federal ridings', available: true },
  { id: 'ecozones', label: 'Ecozones', available: true },
];

/** The layer made from an imported GeoJSON or KML file (src/import/template.ts); session only. */
export const IMPORTED_SNAP = 'imported';

const PACIFIC = 1;

/** 1 per graph edge (aligned with graph.targets) lying on any selected layer; undefined for none. */
export function snapEdges(
  graph: ScopeGraph,
  layers: readonly string[],
  data: SplitterData,
  /** edge keys (u * n + v, u < v) of the imported layer, when one is loaded */
  imported?: ReadonlySet<number>,
): Uint8Array | undefined {
  const selected = SNAP_LAYERS.filter((l) => l.available && layers.includes(l.id)).map((l) => l.id);
  if (imported && layers.includes(IMPORTED_SNAP)) selected.push(IMPORTED_SNAP);
  if (!selected.length) return undefined;
  const n = data.cellIds.length;
  const { columns, arrays } = data;
  const differs = (column: ArrayLike<number> | undefined, a: number, b: number) =>
    !!column && column[a] !== column[b];
  const half = (x: number) => Math.floor(x * 2);
  const out = new Uint8Array(graph.targets.length);
  for (let u = 0; u < graph.size; u++) {
    const a = graph.cells[u];
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
      if (graph.crossing[e]) continue;
      const b = graph.cells[graph.targets[e]];
      const on = selected.some((layer) => {
        switch (layer) {
          case 'rivers':
            return data.riverEdges.has(Math.min(a, b) * n + Math.max(a, b));
          case 'basins':
            return differs(columns.basin_id, a, b);
          case 'continental_divide': {
            const oa = columns.ocean_drainage_id?.[a];
            const ob = columns.ocean_drainage_id?.[b];
            return (
              oa !== undefined &&
              ob !== undefined &&
              oa > 0 &&
              ob > 0 &&
              (oa === PACIFIC) !== (ob === PACIFIC)
            );
          }
          case 'treaties':
            return differs(columns.treaty_id, a, b);
          case 'cd':
            return data.cds[a] !== data.cds[b];
          case 'csd':
            return data.csds[a] !== data.csds[b];
          case 'graticule':
            return (
              half(arrays.centroids[2 * a]) !== half(arrays.centroids[2 * b]) ||
              half(arrays.centroids[2 * a + 1]) !== half(arrays.centroids[2 * b + 1])
            );
          case 'ridings':
            return differs(columns.fed_riding_id, a, b);
          case 'ecozones':
            return differs(columns.ecozone_id, a, b);
          case IMPORTED_SNAP:
            return !!imported?.has(Math.min(a, b) * n + Math.max(a, b));
          default:
            return false;
        }
      });
      if (on) out[e] = 1;
    }
  }
  return out;
}
