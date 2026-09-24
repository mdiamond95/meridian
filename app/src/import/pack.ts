import { decodePack } from '../splitter/pack';
import type { RegionPack } from '../schema/regionPack';

/**
 * Importing a RegionPack (plan Phase 5 §2): validate it, check its mesh version, and — when it was made
 * on another mesh — re-fit it by giving every cell of this mesh the region of the nearest cell centre
 * of the pack's mesh. Unlike regenerating from the seed, re-fitting keeps hand edits and template
 * splits, which have no recipe to rerun.
 */

export type PackCheck =
  | { kind: 'same-mesh'; pack: RegionPack }
  | { kind: 'other-mesh'; pack: RegionPack; from: string; to: string };

export function checkPack(json: unknown, meshVersion: string): PackCheck {
  const pack = decodePack(json);
  return pack.meta.meshVersion === meshVersion
    ? { kind: 'same-mesh', pack }
    : { kind: 'other-mesh', pack, from: pack.meta.meshVersion, to: meshVersion };
}

/** Where a published mesh version can be fetched (docs/interop.md: mesh versions are never deleted). */
export const MESH_ARCHIVE = 'https://raw.githubusercontent.com/mdiamond95/meridian/main/data/build/';

/**
 * For each cell of the new mesh, the region of the old mesh's nearest cell centre, or -1 when there
 * is none within `maxKm` (land the old mesh did not cover). Centres are [lng, lat] pairs.
 */
export function refitAssignment(
  oldCentroids: ArrayLike<number>,
  oldAssignment: Int32Array,
  newCentroids: ArrayLike<number>,
  maxKm = 30,
): Int32Array {
  const cellDeg = 0.5;
  const key = (gx: number, gy: number) => gx * 100_000 + gy;
  const grid = new Map<number, number[]>();
  for (let i = 0; i < oldAssignment.length; i++) {
    const k = key(Math.floor(oldCentroids[2 * i] / cellDeg), Math.floor(oldCentroids[2 * i + 1] / cellDeg));
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  const n = newCentroids.length / 2;
  const out = new Int32Array(n).fill(-1);
  const KM_PER_DEG = 111.195;
  for (let j = 0; j < n; j++) {
    const lng = newCentroids[2 * j];
    const lat = newCentroids[2 * j + 1];
    const kx = Math.cos((lat * Math.PI) / 180);
    // Search far enough east–west for maxKm at this latitude.
    const rx = Math.ceil(maxKm / (KM_PER_DEG * Math.max(kx, 0.05) * cellDeg));
    const ry = Math.ceil(maxKm / (KM_PER_DEG * cellDeg));
    const gx = Math.floor(lng / cellDeg);
    const gy = Math.floor(lat / cellDeg);
    let best = -1;
    let bestD = (maxKm / KM_PER_DEG) ** 2;
    for (let dx = -rx; dx <= rx; dx++) {
      for (let dy = -ry; dy <= ry; dy++) {
        for (const i of grid.get(key(gx + dx, gy + dy)) ?? []) {
          const ex = (oldCentroids[2 * i] - lng) * kx;
          const ey = oldCentroids[2 * i + 1] - lat;
          const d = ex * ex + ey * ey;
          if (d < bestD || (d === bestD && i < best)) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    if (best >= 0) out[j] = oldAssignment[best];
  }
  return out;
}
