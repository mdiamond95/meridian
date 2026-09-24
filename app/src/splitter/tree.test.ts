// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyScenario } from '../scenario/apply';
import { scenarioById } from '../scenario/scenarios';
import { decodeColumn } from '../schema/columns';
import { RegionPackSchema, type RegionPackWire } from '../schema/regionPack';
import { buildPack, decodePack, specFromPack } from './pack';
import { defaultSpec, runSplit, type SplitSpec } from './split';
import { realAtlas, realSplitterData } from './testing/realSplitterData';
import { assembleTree, flattenTree, packId, pathTo, type TreeNode } from './tree';

/**
 * Nesting (plan Phase 6 §2, and its gate): three levels deep — a province into 4, one of those into 3,
 * one of those into 2 — exported as one JSON and read back to the same cells, with every link intact.
 */
describe('nesting three levels deep', () => {
  const data = realSplitterData();
  const base = defaultSpec();

  interface Node extends TreeNode {
    pack: RegionPackWire;
    assignment: Int32Array;
  }
  const nodes: Record<string, Node> = {};
  const level = (spec: SplitSpec, parent: Node | null) => {
    const { finished } = runSplit(spec, data, { packAssignment: parent?.assignment });
    const pack = buildPack(spec, finished.assignment, finished.regions, data.meshVersion);
    const id = pack.meta.id as string;
    nodes[id] = {
      id,
      parent: parent
        ? { id: parent.id, regionId: spec.scope.kind === 'region' ? spec.scope.region : -1 }
        : null,
      pack,
      assignment: finished.assignment,
    };
    return nodes[id];
  };
  const root = level({ ...base, scope: { kind: 'province', province: 'NS' }, n: 4, seed: 6 }, null);
  const child = level({ ...base, scope: { kind: 'region', pack: root.id, region: 1 }, n: 3, seed: 6 }, root);
  const grandchild = level(
    { ...base, scope: { kind: 'region', pack: child.id, region: 0 }, n: 2, seed: 6 },
    child,
  );

  it('each level splits one region of the level above, and records it', () => {
    expect(child.pack.meta).toMatchObject({ parentPack: root.id, parentRegionId: 1 });
    expect(grandchild.pack.meta).toMatchObject({ parentPack: child.id, parentRegionId: 0 });
    expect(root.pack.meta.parentPack).toBeUndefined();
    for (const [upper, lower, region] of [
      [root, child, 1],
      [child, grandchild, 0],
    ] as const) {
      const cells = lower.assignment.reduce((list, r, i) => (r >= 0 ? [...list, i] : list), [] as number[]);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.every((i) => upper.assignment[i] === region)).toBe(true);
      expect(cells.length).toBe(upper.assignment.filter((r) => r === region).length);
    }
    expect(pathTo(nodes, grandchild.id).map((n) => n.id)).toEqual([root.id, child.id, grandchild.id]);
  }, 60_000);

  it('round-trips as one JSON', () => {
    const tree = assembleTree(nodes, root.id, (n) => n.pack);
    const text = JSON.stringify(tree);
    const parsed = RegionPackSchema.parse(JSON.parse(text));
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children?.[0].children).toHaveLength(1);
    const flat = flattenTree(parsed);
    expect(flat.map((p) => p.meta.id)).toEqual([root.id, child.id, grandchild.id]);
    flat.forEach((pack, i) => {
      const original = [root, child, grandchild][i];
      expect(decodeColumn(pack.assignment)).toEqual(original.assignment);
      expect(pack).toEqual(original.pack);
      // Each level is still its own recipe: rerun it and the cells come back.
      const parent = i === 0 ? undefined : [root, child][i - 1].assignment;
      expect(runSplit(specFromPack(pack), data, { packAssignment: parent }).finished.assignment).toEqual(
        original.assignment,
      );
    });
    expect(decodePack(parsed).assignment).toEqual(root.assignment);
  }, 60_000);

  it('ids are stable and differ between splits', () => {
    const spec = specFromPack(root.pack);
    expect(packId(spec, root.assignment)).toBe(root.id);
    expect(new Set([root.id, child.id, grandchild.id]).size).toBe(3);
    expect(root.id).toMatch(/^split-[0-9a-f]{8}$/);
  });
});

describe('a split made in a scenario', () => {
  it('carries the scenario in its pack, and its atlas scope resolves in the scenario', () => {
    const data = realSplitterData();
    const scenario = scenarioById('buffalo-1905');
    if (!scenario) throw new Error('no buffalo');
    const atlas = applyScenario(realAtlas(), scenario).loaded;
    const spec: SplitSpec = {
      ...defaultSpec(),
      scope: { kind: 'atlasUnit', unit: 'buffalo' },
      date: '1950-01-01',
      n: 3,
      seed: 3,
    };
    const { finished } = runSplit(spec, data, { atlas });
    const provinces = new Set<string>();
    finished.assignment.forEach((r, i) => r >= 0 && provinces.add(data.provinces[i]));
    expect([...provinces].sort()).toEqual(['AB', 'SK']);
    const pack = decodePack(
      JSON.parse(
        JSON.stringify(
          buildPack(spec, finished.assignment, finished.regions, data.meshVersion, { scenario }),
        ),
      ),
    );
    expect(pack.meta.scenario).toEqual(scenario);
    expect(() => runSplit(spec, data, { atlas: realAtlas() })).toThrow(/buffalo does not exist/);
  }, 60_000);
});
