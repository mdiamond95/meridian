import type { ScopeGraph } from '../engine/graph';

/**
 * Region colours. Up to 30 regions but eight categorical hues, so colour cannot identify a region on
 * its own: regions are named on the map and in the legend, and colour only has to keep neighbours
 * apart. Each region, in id order, takes the least-used hue none of its already-coloured neighbours
 * has (or the least-used hue overall when all eight are taken). The same assignment always gets the
 * same colours.
 *
 * Chosen for deuteranopia (plan Phase 7 §3): every pair of the eight stays at least 12 CIEDE2000
 * apart with and without simulated deuteranopia, both at full strength (exports) and as the map draws
 * them (REGION_FILL_OPACITY over the light basemap). palette.test.ts checks all 28 pairs with
 * colourVision.ts; the numbers are in docs/decisions.md.
 */
export const REGION_HUES = [
  '#004eb7', // deep blue
  '#ef8c8c', // salmon
  '#9e4d00', // rust
  '#f2be47', // gold
  '#2dbaff', // sky
  '#80447b', // plum
  '#7fd3d2', // aqua
  '#006334', // forest
];

/** The map's region fill opacity; the palette check measures the hues as drawn at this. */
export const REGION_FILL_OPACITY = 0.5;
/** The light basemap the fills are drawn over (CARTO Positron's land, near enough OSM's). */
export const BASEMAP_LAND = '#f7f7f5';

export function regionColours(graph: ScopeGraph, assignment: Int32Array, k: number): string[] {
  const neighbours = Array.from({ length: k }, () => new Set<number>());
  for (let u = 0; u < graph.size; u++) {
    const a = assignment[graph.cells[u]];
    if (a < 0 || a >= k) continue;
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
      const b = assignment[graph.cells[graph.targets[e]]];
      if (b >= 0 && b < k && b !== a) neighbours[a].add(b);
    }
  }
  const slot = new Array<number>(k).fill(-1);
  const used = new Array<number>(REGION_HUES.length).fill(0);
  for (let r = 0; r < k; r++) {
    const taken = new Set([...neighbours[r]].map((n) => slot[n]).filter((s) => s >= 0));
    let choice = -1;
    for (let h = 0; h < REGION_HUES.length; h++) {
      if (!taken.has(h) && (choice < 0 || used[h] < used[choice])) choice = h;
    }
    if (choice < 0) choice = used.indexOf(Math.min(...used));
    slot[r] = choice;
    used[choice]++;
  }
  return slot.map((s) => REGION_HUES[s]);
}
