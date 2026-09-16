import type { AtlasEvent, AtlasFile, AtlasReference, AtlasUnit, TruthLayer } from '../schema/atlas';

/**
 * Resolve a date to the atlas units valid on it (vision §5.1): the event list is the data, a map
 * for any date is derived. Dates are ISO YYYY-MM-DD strings, which compare correctly as strings.
 */

/** Units valid on `date` (validFrom inclusive, validTo exclusive) in the given truth layers. */
export function resolveUnits(
  atlas: Pick<AtlasFile, 'units'>,
  date: string,
  truth: readonly TruthLayer[] = ['dejure'],
): AtlasUnit[] {
  return atlas.units.filter(
    (u) => truth.includes(u.truth) && u.validFrom <= date && (u.validTo === null || date < u.validTo),
  );
}

/** Reference drawings (NRCan's, where the atlas departs from it) valid on `date`. */
export function resolveReferences(atlas: Pick<AtlasFile, 'references'>, date: string): AtlasReference[] {
  return (atlas.references ?? []).filter(
    (r) => r.validFrom <= date && (r.validTo === null || date < r.validTo),
  );
}

/** The latest event on or before `date`, or null before the first event. */
export function currentEvent(atlas: Pick<AtlasFile, 'events'>, date: string): AtlasEvent | null {
  let found: AtlasEvent | null = null;
  for (const event of atlas.events) {
    if (event.date > date) break;
    found = event;
  }
  return found;
}

/**
 * The date the map resolves to for `date`: the latest event on or before it, or "" before the
 * first event. Rows only ever start and end on event dates, so resolving at this date gives the
 * same units as `date` itself — and it is stable across a whole event window, which lets the map
 * skip its work on the slider steps that change nothing.
 */
export function resolvedAt(atlas: Pick<AtlasFile, 'events'>, date: string): string {
  return currentEvent(atlas, date)?.date ?? '';
}

/** The slider works in years; a year shows the map as it stood at the end of that year. */
export function yearToDate(year: number): string {
  return `${String(year).padStart(4, '0')}-12-31`;
}

export function dateToYear(date: string): number {
  return Number(date.slice(0, 4));
}

/** First and last slider years: the first event's year to the current year. */
export function yearRange(atlas: Pick<AtlasFile, 'events'>, today: Date): [number, number] {
  const first = atlas.events.length ? dateToYear(atlas.events[0].date) : today.getUTCFullYear();
  return [first, Math.max(first, today.getUTCFullYear())];
}

/** A unit's full history: every row sharing its id, oldest first. */
export function unitHistory(atlas: Pick<AtlasFile, 'units'>, id: string): AtlasUnit[] {
  return atlas.units.filter((u) => u.id === id).sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "15 Jul 1870" */
export function formatDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
