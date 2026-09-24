import type { MultiPolygon, Polygon } from 'geojson';
import type { LoadedAtlas } from '../atlas/loadAtlas';
import { resolveUnits } from '../atlas/resolve';
import { topologyTools } from '../atlas/topology';
import {
  TRUTH_LAYERS,
  type AtlasEvent,
  type AtlasRequirement,
  type AtlasUnit,
  type TruthLayer,
} from '../schema/atlas';
import type { Scenario, ScenarioChange, ScenarioEvent, ScenarioGeometry } from '../schema/scenario';

/**
 * Divergence mode (vision §8, plan Phase 6 §1): a scenario turns the base atlas into another atlas of
 * the same shape, so the map, the timeline and the Generate panel's atlas scopes work on it unchanged.
 *
 * The event list is replayed. Base and scenario events are merged by date, the scenario's after the
 * base's on the same date. Before each event its preconditions are checked against the scenario's
 * state: the explicit `requires`, and the implicit ones every change carries (an alter or dissolve
 * needs its unit to exist, a create needs it not to). An event that fails is skipped whole and
 * recorded as a notice. A base change is applied as a delta — the fields that differ between the
 * base's rows either side of it — so a unit the scenario has altered keeps the scenario's status when
 * a later base event only redraws its boundary.
 *
 * Replaying the base with no scenario reproduces the base's rows exactly (src/scenario/apply.test.ts).
 */

export interface SkippedEvent {
  date: string;
  title: string;
  /** one clause per unmet condition */
  reasons: string[];
  /** the failed requirements' own explanations (AtlasRequirement.because) */
  because: string[];
}

export interface ScenarioAtlas {
  scenario: Scenario;
  /** the scenario's atlas: same shape as the base, with its own events, rows and merged geometries */
  loaded: LoadedAtlas;
  /** base events the scenario skipped, and why */
  skipped: SkippedEvent[];
  /** `${date}|${title}` of the events that came from the scenario, for the timeline */
  scenarioEvents: Set<string>;
}

const ROW_KEYS = [
  'name',
  'status',
  'sovereign',
  'capital',
  'truth',
  'dispute',
  'geometryRef',
  'note',
  'confidence',
  'instrument',
  'rationale',
] as const satisfies readonly (keyof AtlasUnit)[];

export const eventKey = (event: Pick<AtlasEvent, 'date' | 'title'>) => `${event.date}|${event.title}`;

interface OpenRow {
  row: AtlasUnit;
  /** index of the base row this one was replayed from; scenario rows sort after every base row */
  order: number;
}

type Entry = { from: 'base'; event: AtlasEvent } | { from: 'scenario'; event: ScenarioEvent };

function changeOf(change: ScenarioChange): {
  kind: 'create' | 'alter' | 'rename' | 'dissolve';
  unit: string;
} {
  if ('create' in change) return { kind: 'create', unit: change.create };
  if ('alter' in change) return { kind: 'alter', unit: change.alter };
  if ('rename' in change) return { kind: 'rename', unit: change.rename };
  return { kind: 'dissolve', unit: change.dissolve };
}

/** Why a requirement fails against the current state, or null when it holds. */
export function unmet(
  requirement: AtlasRequirement,
  state: ReadonlyMap<string, { row: AtlasUnit }>,
): string | null {
  const row = state.get(requirement.unit)?.row;
  const exists = requirement.exists ?? true;
  if (!row && exists) return `requires ${requirement.unit}, which does not exist in this scenario`;
  if (row && !exists) return `requires that ${row.name} does not exist, and in this scenario it does`;
  if (row && requirement.status && row.status !== requirement.status)
    return `requires ${row.name} to be ${requirement.status}; in this scenario it is ${row.status}`;
  if (row && requirement.sovereign && row.sovereign !== requirement.sovereign)
    return `requires ${row.name} under ${requirement.sovereign}; in this scenario it is under ${row.sovereign}`;
  return null;
}

export function applyScenario(base: LoadedAtlas, scenario: Scenario): ScenarioAtlas {
  const { atlas } = base;
  const baseIndex = new Map<AtlasUnit, number>(atlas.units.map((u, i) => [u, i]));
  const starting = new Map<string, AtlasUnit>();
  const ending = new Map<string, AtlasUnit>();
  for (const unit of atlas.units) {
    starting.set(`${unit.id}@${unit.validFrom}`, unit);
    if (unit.validTo) ending.set(`${unit.id}@${unit.validTo}`, unit);
  }

  const geometries = new Map(base.geometries);
  const tools = base.topology ? topologyTools(base.topology) : null;
  const geometryRef = (expr: ScenarioGeometry): string => {
    if ('unit' in expr) {
      const row = atlas.units.find(
        (u) => u.id === expr.unit && u.validFrom <= expr.at && (u.validTo === null || expr.at < u.validTo),
      );
      if (!row) throw new Error(`scenario ${scenario.id}: no base unit ${expr.unit} on ${expr.at}`);
      return row.geometryRef;
    }
    const refs = [...new Set(expr.union.map(geometryRef))].sort();
    const key = `scenario:${refs.join('+')}`;
    if (!geometries.has(key)) {
      if (!tools) throw new Error('merging drawings needs the atlas topology');
      geometries.set(key, tools.merge(refs) as Polygon | MultiPolygon);
    }
    return key;
  };

  const entries: Entry[] = [
    ...atlas.events.map((event) => ({ from: 'base' as const, event })),
    ...scenario.events.map((event) => ({ from: 'scenario' as const, event })),
  ];
  // Stable: base events keep their order, and on a shared date the scenario's follow the base's.
  entries.sort((a, b) => (a.event.date < b.event.date ? -1 : a.event.date > b.event.date ? 1 : 0));

  const state = new Map<string, OpenRow>();
  const rows: OpenRow[] = [];
  const events: AtlasEvent[] = [];
  const skipped: SkippedEvent[] = [];
  const scenarioEvents = new Set<string>();
  const close = (id: string, date: string) => {
    const open = state.get(id);
    if (!open) return;
    state.delete(id);
    // A row created and ended on one date (a scenario undoing a base event of the same day) never existed.
    if (open.row.validFrom < date) rows.push({ ...open, row: { ...open.row, validTo: date } });
  };

  for (const entry of entries) {
    const { event } = entry;
    const kinds = entry.from === 'base' ? entry.event.changes : entry.event.changes.map((c) => changeOf(c));
    const failed = (event.requires ?? []).filter((r) => unmet(r, state));
    const reasons = failed.map((r) => unmet(r, state) as string);
    for (const { unit, kind } of kinds) {
      const exists = state.has(unit);
      if (kind === 'create' && exists) reasons.push(`creates ${unit}, which already exists in this scenario`);
      if (kind !== 'create' && !exists)
        reasons.push(`acts on ${unit}, which does not exist in this scenario`);
    }
    if (reasons.length) {
      if (entry.from === 'scenario')
        throw new Error(
          `scenario ${scenario.id}: its own event ${event.date} ${event.title} cannot apply: ${reasons.join('; ')}`,
        );
      skipped.push({
        date: event.date,
        title: event.title,
        reasons: [...new Set(reasons)],
        because: failed.map((r) => r.because),
      });
      continue;
    }

    if (entry.from === 'base') {
      for (const { unit, kind } of entry.event.changes) {
        const next = starting.get(`${unit}@${event.date}`);
        if (kind === 'create') {
          if (!next) throw new Error(`base atlas: no row for ${unit} created ${event.date}`);
          state.set(unit, { row: { ...next, validTo: null }, order: baseIndex.get(next) ?? 0 });
          continue;
        }
        const current = state.get(unit) as OpenRow; // checked above
        close(unit, event.date);
        if (kind === 'dissolve') continue;
        const previous = ending.get(`${unit}@${event.date}`);
        if (!next || !previous)
          throw new Error(`base atlas: no rows either side of ${unit} on ${event.date}`);
        const merged: Record<string, unknown> = { ...current.row, validFrom: event.date, validTo: null };
        for (const key of ROW_KEYS) if (previous[key] !== next[key]) merged[key] = next[key];
        // A field the base's next row drops (an annotation not carried forward) is dropped here too.
        const row = Object.fromEntries(
          Object.entries(merged).filter(([, value]) => value !== undefined),
        ) as AtlasUnit;
        state.set(unit, { row, order: baseIndex.get(next) ?? 0 });
      }
      events.push(entry.event);
      continue;
    }

    for (const change of entry.event.changes) {
      const { unit, kind } = changeOf(change);
      const current = state.get(unit);
      close(unit, event.date);
      if (kind === 'dissolve') continue;
      const fields = change as Partial<Record<string, unknown>>;
      const row: AtlasUnit =
        kind === 'create'
          ? {
              id: unit,
              name: fields.name as string,
              status: fields.status as AtlasUnit['status'],
              sovereign: fields.sovereign as string,
              capital: (fields.capital as string | null | undefined) ?? null,
              truth: 'dejure',
              geometryRef: '',
              validFrom: event.date,
              validTo: null,
            }
          : { ...(current as OpenRow).row, validFrom: event.date, validTo: null };
      for (const key of [
        'name',
        'status',
        'sovereign',
        'capital',
        'note',
        'confidence',
        'instrument',
        'rationale',
      ] as const) {
        if (fields[key] !== undefined) (row as Record<string, unknown>)[key] = fields[key];
      }
      if ('geometry' in change && change.geometry) row.geometryRef = geometryRef(change.geometry);
      state.set(unit, { row, order: kind === 'create' ? Infinity : (current as OpenRow).order });
    }
    const out: AtlasEvent = {
      date: event.date,
      title: event.title,
      note: event.note,
      changes: entry.event.changes.map((c) => changeOf(c)),
    };
    events.push(out);
    scenarioEvents.add(eventKey(out));
  }
  for (const [, open] of state) rows.push(open);

  rows.sort((a, b) => a.order - b.order || (a.row.validFrom < b.row.validFrom ? -1 : 1));
  return {
    scenario,
    loaded: {
      atlas: { ...atlas, events, units: rows.map((r) => r.row) },
      geometries,
      topology: base.topology,
    },
    skipped,
    scenarioEvents,
  };
}

// --- Diff against the base ----------------------------------------------------------------------

export type UnitDiff =
  | { kind: 'added'; id: string; scenario: AtlasUnit }
  | { kind: 'removed'; id: string; base: AtlasUnit }
  | { kind: 'changed'; id: string; base: AtlasUnit; scenario: AtlasUnit; fields: string[] };

const COMPARED = ['name', 'status', 'sovereign', 'capital', 'geometryRef'] as const;

/** How the scenario's map differs from the base's on `date`, unit by unit. */
export function diffAtDate(
  base: Pick<LoadedAtlas, 'atlas'>,
  scenario: Pick<LoadedAtlas, 'atlas'>,
  date: string,
  truth: readonly TruthLayer[] = TRUTH_LAYERS,
): UnitDiff[] {
  const before = new Map(resolveUnits(base.atlas, date, truth).map((u) => [u.id, u]));
  const after = new Map(resolveUnits(scenario.atlas, date, truth).map((u) => [u.id, u]));
  const out: UnitDiff[] = [];
  for (const [id, unit] of after) {
    const was = before.get(id);
    if (!was) {
      out.push({ kind: 'added', id, scenario: unit });
      continue;
    }
    const fields = COMPARED.filter((k) => was[k] !== unit[k]).map((k) =>
      k === 'geometryRef' ? 'boundary' : k,
    );
    if (fields.length) out.push({ kind: 'changed', id, base: was, scenario: unit, fields });
  }
  for (const [id, unit] of before) if (!after.has(id)) out.push({ kind: 'removed', id, base: unit });
  const rank = { added: 0, removed: 1, changed: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.id < b.id ? -1 : 1));
}

// --- Resolving cleanly --------------------------------------------------------------------------

/** Area of a polygon geometry on the sphere, km² (the ring-area formula d3 and turf use). */
export function sphericalAreaKm2(geometry: Polygon | MultiPolygon): number {
  const R = 6371.0088;
  const rad = Math.PI / 180;
  const ringArea = (ring: number[][]) => {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      sum += (ring[i][0] - ring[j][0]) * rad * (2 + Math.sin(ring[j][1] * rad) + Math.sin(ring[i][1] * rad));
    }
    return Math.abs((sum * R * R) / 2);
  };
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let area = 0;
  for (const [outer, ...holes] of polygons) {
    area += ringArea(outer);
    for (const hole of holes) area -= ringArea(hole);
  }
  return area;
}

export interface CleanCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Whether a scenario resolves cleanly (the Phase 6 gate): every row has a drawing; no unit has two rows
 * at once; and at every event date, and today, the de jure units cover the same area as the base's
 * (within 0.5%), so the branch leaves no land unassigned and none counted twice.
 */
export function checkScenario(base: LoadedAtlas, result: ScenarioAtlas, today: string): CleanCheck {
  const problems: string[] = [];
  const { atlas, geometries } = result.loaded;
  for (const row of atlas.units) {
    if (!geometries.has(row.geometryRef)) problems.push(`${row.id} from ${row.validFrom} has no drawing`);
  }
  const dates = [
    ...new Set([...atlas.events.map((e) => e.date), ...base.atlas.events.map((e) => e.date), today]),
  ].sort();
  // Both atlases share their drawings (a scenario only adds merged ones), so areas are cached by ref.
  const areas = new Map<string, number>();
  const refArea = (loaded: LoadedAtlas, ref: string) => {
    let a = areas.get(ref);
    if (a === undefined) {
      const g = loaded.geometries.get(ref);
      areas.set(ref, (a = g ? sphericalAreaKm2(g) : 0));
    }
    return a;
  };
  const area = (loaded: LoadedAtlas, date: string) =>
    resolveUnits(loaded.atlas, date, ['dejure']).reduce((sum, u) => sum + refArea(loaded, u.geometryRef), 0);
  for (const date of dates) {
    const units = resolveUnits(atlas, date, TRUTH_LAYERS);
    const ids = units.map((u) => `${u.truth}:${u.id}`);
    if (new Set(ids).size !== ids.length) problems.push(`${date}: a unit has two rows`);
    const a = area(result.loaded, date);
    const b = area(base, date);
    if (b > 0 && Math.abs(a - b) / b > 0.005)
      problems.push(`${date}: de jure units cover ${Math.round(a)} km², the base ${Math.round(b)} km²`);
  }
  return { ok: problems.length === 0, problems };
}
