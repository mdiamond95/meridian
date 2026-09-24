import type { RegionPackWire } from '../schema/regionPack';
import type { SplitSpec } from './split';

/**
 * Nesting (vision §8, plan Phase 6 §2): a region of one split becomes the scope of the next, "split
 * Canada into 5, then any of those into 4, then any of those into 3". Each pack records its parent in
 * meta.parentPack and meta.parentRegionId (and its scope is `{kind: 'region', pack, region}` with the
 * same two values); a tree travels as one JSON, the root pack with its children nested under
 * `children`, recursively.
 */

/** FNV-1a, 32 bits: a short, stable id for a split, from its recipe and its cells. */
function fnv1a(bytes: Uint8Array, hash = 0x811c9dc5): number {
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** JSON with object keys sorted and undefined values dropped, so equal specs hash equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v ?? null)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function packId(spec: SplitSpec, assignment: Int32Array): string {
  const recipe = fnv1a(new TextEncoder().encode(canonical(spec)));
  const cells = fnv1a(
    new Uint8Array(assignment.buffer, assignment.byteOffset, assignment.byteLength),
    recipe,
  );
  return `split-${cells.toString(16).padStart(8, '0')}`;
}

export interface TreeNode {
  id: string;
  parent: { id: string; regionId: number } | null;
}

/** The parent a spec implies: a region scope names the pack and region it splits. */
export function parentOf(spec: Pick<SplitSpec, 'scope'>): TreeNode['parent'] {
  return spec.scope.kind === 'region' ? { id: spec.scope.pack, regionId: spec.scope.region } : null;
}

/** The path from the root to `id`, root first. */
export function pathTo<T extends TreeNode>(nodes: Record<string, T>, id: string): T[] {
  const path: T[] = [];
  const seen = new Set<string>();
  for (
    let node: T | undefined = nodes[id];
    node && !seen.has(node.id);
    node = node.parent ? nodes[node.parent.id] : undefined
  ) {
    seen.add(node.id);
    path.unshift(node);
  }
  return path;
}

/** Children of `id`, by the region they split. */
export function childrenOf<T extends TreeNode>(nodes: Record<string, T>, id: string): T[] {
  return Object.values(nodes)
    .filter((n) => n.parent?.id === id)
    .sort((a, b) => (a.parent?.regionId ?? 0) - (b.parent?.regionId ?? 0));
}

/** `id` and everything under it. */
export function subtree<T extends TreeNode>(nodes: Record<string, T>, id: string): string[] {
  return [id, ...childrenOf(nodes, id).flatMap((child) => subtree(nodes, child.id))];
}

/** One JSON for the tree under `rootId`: each node's pack with its children nested. */
export function assembleTree<T extends TreeNode>(
  nodes: Record<string, T>,
  rootId: string,
  packOf: (node: T) => RegionPackWire,
): RegionPackWire {
  const node = nodes[rootId];
  const pack = packOf(node);
  const children = childrenOf(nodes, rootId).map((child) => assembleTree(nodes, child.id, packOf));
  return children.length ? { ...pack, children } : pack;
}

/** A tree pack as a flat list, parents before children. */
export function flattenTree(pack: RegionPackWire): RegionPackWire[] {
  const { children, ...self } = pack;
  return [self, ...(children ?? []).flatMap(flattenTree)];
}
