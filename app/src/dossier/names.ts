import { mulberry32 } from '../engine/prng';
import type { SplitterData } from '../splitter/data';
import type { RegionAggregate } from './stats';

/**
 * Region names, generated the same way every time (plan Phase 4).
 *
 * Names come from what is on the ground: drainage basins, ecozones, the rivers a region's cells sit
 * on, Inuit regions, and the province, with a direction when a bare feature is taken. The seed is the
 * pack's seed and the region's id, so the same split always gets the same names, and a manual rename
 * always wins and is kept in the pack.
 *
 * **Indigenous names are never applied to a region without an Indigenous majority.** That is a hard
 * rule, not a weighting: `indigenousCandidates` is only consulted when over half the region's people
 * report an Indigenous identity, and `namesRespectIndigenousRule` is asserted in the tests.
 */

export interface GeneratedName {
  name: string;
  /** why this name, in a few words */
  reason: string;
  indigenous: boolean;
}

const DIRECTIONS: [string, (dx: number, dy: number) => boolean][] = [
  ['Northern', (dx, dy) => dy > 0.35 && Math.abs(dy) >= Math.abs(dx)],
  ['Southern', (dx, dy) => dy < -0.35 && Math.abs(dy) >= Math.abs(dx)],
  ['Eastern', (dx, dy) => dx > 0.35 && Math.abs(dx) > Math.abs(dy)],
  ['Western', (dx, dy) => dx < -0.35 && Math.abs(dx) > Math.abs(dy)],
  ['Central', () => true],
];

const PROVINCE_NAMES: Record<string, string> = {
  NL: 'Newfoundland and Labrador',
  PE: 'Prince Edward Island',
  NS: 'Nova Scotia',
  NB: 'New Brunswick',
  QC: 'Quebec',
  ON: 'Ontario',
  MB: 'Manitoba',
  SK: 'Saskatchewan',
  AB: 'Alberta',
  BC: 'British Columbia',
  YT: 'Yukon',
  NT: 'Northwest Territories',
  NU: 'Nunavut',
};

/** "05DD Battle" and "North Saskatchewan" alike come back as a plain feature name. */
function tidy(label: string): string {
  return label
    .replace(/^\d+[A-Z]*\s+/, '')
    .replace(/\s*\(.*\)$/, '')
    .trim();
}

function dominant(counts: Map<string, number>): string | null {
  let best: [string, number] | null = null;
  for (const entry of counts) {
    if (!best || entry[1] > best[1] || (entry[1] === best[1] && entry[0] < best[0])) best = entry;
  }
  return best && best[1] > 0 ? best[0] : null;
}

interface Features {
  basin: string | null;
  ecozone: string | null;
  river: string | null;
  inuitRegion: string | null;
  languageFamily: string | null;
  province: string | null;
  direction: string;
}

/** What a region is made of, for naming: its dominant features by cell count, and where it sits. */
function features(
  data: SplitterData,
  scopeCells: Int32Array,
  assignment: Int32Array,
  region: number,
  aggregate: RegionAggregate,
): Features {
  const { columns, lookups, arrays } = data;
  const basins = new Map<string, number>();
  const ecozones = new Map<string, number>();
  const inuit = new Map<string, number>();
  const rivers = new Map<string, number>();
  const n = data.cellIds.length;
  let lng = 0;
  let lat = 0;
  let cells = 0;
  const count = (map: Map<string, number>, key: string | undefined) => {
    if (key && key !== 'none') map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const cell of scopeCells) {
    if (assignment[cell] !== region) continue;
    cells++;
    lng += arrays.centroids[2 * cell];
    lat += arrays.centroids[2 * cell + 1];
    count(basins, lookups.basin_id?.[String(columns.basin_id?.[cell] ?? 0)]);
    count(ecozones, lookups.ecozone_id?.[String(columns.ecozone_id?.[cell] ?? 0)]);
    count(inuit, lookups.inuit_region?.[String(columns.inuit_region?.[cell] ?? 0)]);
    for (let e = arrays.offsets[cell]; e < arrays.offsets[cell + 1]; e++) {
      const other = arrays.targets[e];
      const name = data.riverEdges.get(Math.min(cell, other) * n + Math.max(cell, other));
      // A river that runs through the region, not only along its edge.
      if (name && assignment[other] === region) count(rivers, name);
    }
  }
  const centre: [number, number] = cells ? [lng / cells, lat / cells] : [0, 0];
  const province = aggregate.provinces[0] ?? null;
  // Where the region sits inside its province, in degrees from the province's own centre.
  let px = 0;
  let py = 0;
  let pcells = 0;
  for (const cell of scopeCells) {
    if (data.provinces[cell] !== province) continue;
    px += arrays.centroids[2 * cell];
    py += arrays.centroids[2 * cell + 1];
    pcells++;
  }
  const dx = pcells ? centre[0] - px / pcells : 0;
  const dy = pcells ? centre[1] - py / pcells : 0;
  const direction = (DIRECTIONS.find(([, test]) => test(dx, dy)) ?? DIRECTIONS[4])[0];
  return {
    basin: dominant(basins),
    ecozone: dominant(ecozones),
    river: dominant(rivers),
    inuitRegion: dominant(inuit),
    languageFamily: dominant(aggregate.languageFamilies),
    province,
    direction,
  };
}

/** Candidate names for a region, best first, each with its reason. */
export function candidates(f: Features, indigenousMajority: boolean): GeneratedName[] {
  const out: GeneratedName[] = [];
  const push = (name: string | null, reason: string, indigenous = false) => {
    if (name) out.push({ name, reason, indigenous });
  };
  // The hard rule: Indigenous names only where Indigenous people are the majority.
  if (indigenousMajority) {
    push(f.inuitRegion, 'Inuit region covering most of it, and an Indigenous-majority population', true);
    push(
      f.languageFamily,
      'dominant Indigenous language family, and an Indigenous-majority population',
      true,
    );
  }
  if (f.river) push(tidy(f.river).replace(/ River$/, ''), 'the river running through it');
  if (f.basin) push(tidy(f.basin), 'the drainage basin it sits in');
  if (f.ecozone) push(tidy(f.ecozone), 'the ecozone it sits in');
  if (f.river) push(`${f.direction} ${tidy(f.river).replace(/ River$/, '')}`, 'its river, and where it sits');
  if (f.basin) push(`${f.direction} ${tidy(f.basin)}`, 'its basin, and where it sits');
  if (f.province)
    push(`${f.direction} ${PROVINCE_NAMES[f.province] ?? f.province}`, 'where it sits in its province');
  if (f.ecozone) push(`${f.direction} ${tidy(f.ecozone)}`, 'its ecozone, and where it sits');
  return out;
}

export interface NameOptions {
  /** manual names by region id always win and are kept */
  manual?: Record<number, string>;
}

/** One name per region, unique within the set, deterministic from the seed. */
export function generateNames(
  data: SplitterData,
  scopeCells: Int32Array,
  assignment: Int32Array,
  aggregates: RegionAggregate[],
  seed: number,
  options: NameOptions = {},
): (GeneratedName & { source: 'generated' | 'manual' })[] {
  const taken = new Set<string>();
  const out: (GeneratedName & { source: 'generated' | 'manual' })[] = [];
  for (let region = 0; region < aggregates.length; region++) {
    const manual = options.manual?.[region];
    if (manual) {
      taken.add(manual);
      out.push({ name: manual, reason: 'named by hand', indigenous: false, source: 'manual' });
      continue;
    }
    const aggregate = aggregates[region];
    const majority = aggregate.indigenousIdentity > 0.5;
    const f = features(data, scopeCells, assignment, region, aggregate);
    const options_ = candidates(f, majority);
    // The seed decides only between candidates that are equally good: the rng picks the starting
    // point among the first two, so two sets from different seeds do not always read the same.
    const rng = mulberry32((seed >>> 0) + region * 7919);
    const start = options_.length > 1 ? rng.int(2) : 0;
    const ordered = [...options_.slice(start), ...options_.slice(0, start)];
    const pick = ordered.find((candidate) => !taken.has(candidate.name));
    if (pick) {
      taken.add(pick.name);
      out.push({ ...pick, source: 'generated' });
      continue;
    }
    // Everything its features suggest is taken: number it after the first candidate.
    const base = options_[0]?.name ?? `Region ${region + 1}`;
    let k = 2;
    while (taken.has(`${base} (${k})`)) k++;
    taken.add(`${base} (${k})`);
    out.push({
      name: `${base} (${k})`,
      reason: `${options_[0]?.reason ?? 'no feature to name it after'}, already used by another region`,
      indigenous: options_[0]?.indigenous ?? false,
      source: 'generated',
    });
  }
  return out;
}

/** The hard rule, as a predicate the tests assert: no Indigenous name without an Indigenous majority. */
export function namesRespectIndigenousRule(
  names: GeneratedName[],
  aggregates: RegionAggregate[],
): { ok: boolean; offenders: number[] } {
  const offenders = names
    .map((name, region) => (name.indigenous && aggregates[region].indigenousIdentity <= 0.5 ? region : -1))
    .filter((region) => region >= 0);
  return { ok: offenders.length === 0, offenders };
}
