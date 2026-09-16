import type { PathOptions } from 'leaflet';
import type { AtlasUnit, TruthLayer, UnitStatus } from '../schema/atlas';

/** Fill by status (plan Phase 2 §4). Muted so the basemap's labels stay readable. */
export const STATUS_COLOURS: Record<UnitStatus, string> = {
  province: '#d9a441',
  territory: '#7fa7c9',
  district: '#9cc3a0',
  colony: '#c98b8b',
  hbc_charter: '#b58ac4',
  unorganized: '#c8c2b4',
  foreign: '#9a9a9a',
  disputed: '#e0673f',
};

export const STATUS_LABELS: Record<UnitStatus, string> = {
  province: 'Province',
  territory: 'Territory',
  district: 'District',
  colony: 'Colony',
  hbc_charter: 'HBC charter',
  unorganized: 'Unorganized',
  foreign: 'Foreign',
  disputed: 'Disputed',
};

export const TRUTH_LABELS: Record<TruthLayer, string> = {
  dejure: 'De jure',
  defacto: 'De facto',
  disputed: 'Disputed',
};

/** Below this confidence a polygon is drawn as approximate. */
export const APPROXIMATE_BELOW = 0.75;

/** NRCan's drawing: an outline only, so the atlas's own fill stays readable underneath. */
export const REFERENCE_STYLE: PathOptions = {
  color: '#8a1c7c',
  weight: 2,
  opacity: 0.95,
  dashArray: '2 5',
  fill: false,
};

export function unitStyle(unit: AtlasUnit, selected: boolean): PathOptions {
  const approximate =
    (unit.confidence !== undefined && unit.confidence < APPROXIMATE_BELOW) || unit.truth !== 'dejure';
  return {
    color: selected ? '#1f2328' : '#4a4f57',
    weight: selected ? 2.5 : 1,
    opacity: 0.9,
    fillColor: STATUS_COLOURS[unit.status],
    // Approximate polygons and non-de-jure layers render lighter (running rules: confidence to the UI).
    fillOpacity: approximate ? 0.22 : 0.42,
    dashArray: unit.truth === 'disputed' ? '6 4' : undefined,
  };
}

/**
 * The contact frontier's bands, earliest to latest. A sequential ramp, deliberately muted: this
 * layer is context under the atlas, and the years it shows are uneven in kind (see the caveat that
 * ships with the data).
 */
export const BAND_COLOURS = ['#4a2545', '#7b3f5d', '#a76a6a', '#c79a78', '#e0c89a', '#f2e6c7'];

export function bandStyle(band: { geometryRef: string }, index?: number): PathOptions {
  const i = index ?? BAND_INDEX.get(band.geometryRef) ?? 0;
  return {
    color: '#3b3b3b',
    weight: 0.5,
    opacity: 0.5,
    fillColor: BAND_COLOURS[Math.min(i, BAND_COLOURS.length - 1)],
    fillOpacity: 0.45,
  };
}

/** Remembered band order, so a band's colour does not depend on what is drawn this frame. */
export const BAND_INDEX = new Map<string, number>();

/** Country contact had not reached on the current date: hatched, never a flat "empty". */
export function unreachedStyle(): PathOptions {
  return {
    color: '#5b6068',
    weight: 0.5,
    opacity: 0.6,
    fillColor: `url(#${HATCH_ID})`,
    fillOpacity: 1,
  };
}

/** Claim overlaps and other disputed ground (plan Phase 2 Sitting C). */
export function disputedStyle(selected: boolean): PathOptions {
  return {
    color: selected ? '#1f2328' : '#8a3c1f',
    weight: selected ? 2.5 : 1.2,
    opacity: 0.95,
    dashArray: '6 4',
    fillColor: `url(#${CLAIM_HATCH_ID})`,
    fillOpacity: 1,
  };
}

export const HATCH_ID = 'meridian-hatch-unreached';
export const CLAIM_HATCH_ID = 'meridian-hatch-claim';
