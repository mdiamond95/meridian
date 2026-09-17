import { DEG, detCos } from '../engine/detmath';
import type { SplitterData } from '../splitter/data';
import { regionBoundary, type BoundaryArc, type CellTopology } from '../splitter/outline';

/**
 * Borders in words (vision §6): walk a region's boundary, say what each run of it follows, merge the
 * runs, and read them off clockwise from the north-west.
 *
 * Each arc of the boundary is one hexagon edge, with a cell on each side, so what it follows is a
 * question about the two cells: a different province, a river crossing between them (from the snap
 * artefact, which carries the river's name), the Continental Divide, a drainage divide, the edge of a
 * treaty area or an ecozone. Runs that follow nothing get one more chance at the run level, where a
 * long stretch at a constant latitude or longitude is a parallel or a meridian; what is left is open
 * country, named by the nearest place. Nothing here invents a feature: every label comes from a
 * column, the gazetteer, or the geometry itself.
 */

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

export type BorderKind =
  | 'province'
  | 'international'
  | 'coast'
  | 'river'
  | 'divide'
  | 'basin'
  | 'treaty'
  | 'ecozone'
  | 'parallel'
  | 'meridian'
  | 'open';

export interface BorderRun {
  kind: BorderKind;
  label: string;
  km: number;
  /** compass position of the run on the region, e.g. "north-west" */
  where: string;
}

const KM_PER_DEG = 111.195;
const PACIFIC = 1;

function km(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dy = points[i][0] - points[i - 1][0];
    const dx = (points[i][1] - points[i - 1][1]) * detCos(((points[i][0] + points[i - 1][0]) / 2) * DEG);
    total += Math.sqrt(dx * dx + dy * dy) * KM_PER_DEG;
  }
  return total;
}

function compass(lat: number, lng: number, centreLat: number, centreLng: number): string {
  const dy = lat - centreLat;
  const dx = (lng - centreLng) * detCos(centreLat * DEG);
  const ns = Math.abs(dy) > Math.abs(dx) / 2 ? (dy > 0 ? 'north' : 'south') : '';
  const ew = Math.abs(dx) > Math.abs(dy) / 2 ? (dx > 0 ? 'east' : 'west') : '';
  return [ns, ew].filter(Boolean).join('-') || 'centre';
}

/** What one boundary arc follows, from the two cells it separates. */
function classifyArc(data: SplitterData, arc: BoundaryArc): { kind: BorderKind; label: string } {
  const { inside, outside } = arc;
  const { columns, lookups } = data;
  const n = data.cellIds.length;
  if (outside < 0) return { kind: 'open', label: '' }; // decided at run level: coast or a border line
  const a = data.provinces[inside];
  const b = data.provinces[outside];
  if (a !== b) {
    const names = [PROVINCE_NAMES[a] ?? a, PROVINCE_NAMES[b] ?? b].sort();
    return { kind: 'province', label: `the ${names[0]}–${names[1]} border` };
  }
  const river = data.riverEdges.get(Math.min(inside, outside) * n + Math.max(inside, outside));
  if (river) return { kind: 'river', label: `the ${river}` };
  const oceanA = columns.ocean_drainage_id?.[inside] ?? 0;
  const oceanB = columns.ocean_drainage_id?.[outside] ?? 0;
  if (oceanA > 0 && oceanB > 0 && oceanA !== oceanB) {
    if ((oceanA === PACIFIC) !== (oceanB === PACIFIC))
      return { kind: 'divide', label: 'the Continental Divide' };
    const names = [
      lookups.ocean_drainage_id?.[String(oceanA)] ?? '',
      lookups.ocean_drainage_id?.[String(oceanB)] ?? '',
    ].sort();
    return { kind: 'divide', label: `the divide between the ${names[0]} and ${names[1]} watersheds` };
  }
  const basinA = columns.basin_id?.[inside] ?? 0;
  const basinB = columns.basin_id?.[outside] ?? 0;
  if (basinA > 0 && basinB > 0 && basinA !== basinB) {
    const names = [lookups.basin_id?.[String(basinA)] ?? '', lookups.basin_id?.[String(basinB)] ?? ''].sort();
    return { kind: 'basin', label: `the divide between the ${names[0]} and ${names[1]} basins` };
  }
  const treatyA = columns.treaty_id?.[inside] ?? 0;
  const treatyB = columns.treaty_id?.[outside] ?? 0;
  if (treatyA !== treatyB && (treatyA > 0 || treatyB > 0)) {
    const label = lookups.treaty_id?.[String(treatyA > 0 ? treatyA : treatyB)];
    if (label) return { kind: 'treaty', label: `the edge of ${label}` };
  }
  const ecoA = columns.ecozone_id?.[inside] ?? 0;
  const ecoB = columns.ecozone_id?.[outside] ?? 0;
  if (ecoA > 0 && ecoB > 0 && ecoA !== ecoB) {
    const label = lookups.ecozone_id?.[String(ecoA)];
    if (label) return { kind: 'ecozone', label: `the edge of the ${label}` };
  }
  return { kind: 'open', label: '' };
}

/** A straight run: flat in latitude is a parallel, flat in longitude a meridian. */
function straightLabel(
  points: [number, number][],
  outsideMesh: boolean,
): { kind: BorderKind; label: string } | null {
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  const latSpan = Math.max(...lats) - Math.min(...lats);
  const lngSpan = Math.max(...lngs) - Math.min(...lngs);
  const round = (x: number) => Math.round(x * 4) / 4;
  // On the edge of the mesh a straight run is a surveyed line — the 49th parallel, the 141st
  // meridian — and is named as one. Inside the mesh it is a boundary this split drew that happens to
  // run flat, so it says "about", and does not borrow the authority of a line someone surveyed.
  if (latSpan < 0.25 && lngSpan > 0.6) {
    const lat = round(lats.reduce((a, b) => a + b, 0) / lats.length);
    return {
      kind: 'parallel',
      label: outsideMesh ? `the ${lat}°N parallel (the international boundary)` : `about ${lat}°N`,
    };
  }
  if (lngSpan < 0.25 && latSpan > 0.6) {
    const lng = Math.abs(round(lngs.reduce((a, b) => a + b, 0) / lngs.length));
    return {
      kind: 'meridian',
      label: outsideMesh ? `the ${lng}°W meridian (the international boundary)` : `about ${lng}°W`,
    };
  }
  return null;
}

export interface BordersOptions {
  /** runs shorter than this are folded into their neighbours (km) */
  minRunKm?: number;
}

/** The runs of one region's boundary, merged and in walking order. */
export function borderRuns(
  data: SplitterData,
  topo: CellTopology,
  assignment: Int32Array,
  region: number,
  options: BordersOptions = {},
): BorderRun[] {
  const minRunKm = options.minRunKm ?? 45;
  const rings = regionBoundary(topo, assignment, region);
  if (!rings.length) return [];
  // The region's centre, for the compass position of each run.
  let lat = 0;
  let lng = 0;
  let cells = 0;
  for (let cell = 0; cell < assignment.length; cell++) {
    if (assignment[cell] !== region) continue;
    lat += data.arrays.centroids[2 * cell + 1];
    lng += data.arrays.centroids[2 * cell];
    cells++;
  }
  const centreLat = cells ? lat / cells : 0;
  const centreLng = cells ? lng / cells : 0;

  const runs: BorderRun[] = [];
  // The longest ring is the region's outline; the others are holes and islands, walked after it.
  const ordered = [...rings].sort((a, b) => b.length - a.length);
  for (const ring of ordered) {
    let current: {
      kind: BorderKind;
      label: string;
      points: [number, number][];
      outsideMesh: boolean;
    } | null = null;
    const flush = () => {
      if (!current) return;
      const length = km(current.points);
      let { kind, label } = current;
      if (kind === 'open') {
        const straight = straightLabel(current.points, current.outsideMesh);
        if (straight) ({ kind, label } = straight);
        else if (current.outsideMesh) ({ kind, label } = { kind: 'coast' as const, label: 'the coast' });
        else {
          const near = nearestPlaceName(data, current.points);
          label = near ? `open country near ${near}` : 'open country';
        }
      }
      const mid = current.points[Math.floor(current.points.length / 2)];
      runs.push({
        kind,
        label,
        km: Math.round(length),
        where: compass(mid[0], mid[1], centreLat, centreLng),
      });
      current = null;
    };
    for (const arc of ring) {
      const { kind, label } = classifyArc(data, arc);
      const outsideMesh = arc.outside < 0;
      if (
        current &&
        current.kind === kind &&
        current.label === label &&
        current.outsideMesh === outsideMesh
      ) {
        current.points.push(...arc.points.slice(1));
      } else {
        flush();
        current = { kind, label, points: [...arc.points], outsideMesh };
      }
    }
    flush();
  }
  return mergeShort(runs, minRunKm);
}

/** Fold short runs into the run before them, and merge neighbours that say the same thing. */
function mergeShort(runs: BorderRun[], minRunKm: number): BorderRun[] {
  const kept: BorderRun[] = [];
  for (const run of runs) {
    const last = kept[kept.length - 1];
    if (last && last.label === run.label) {
      last.km += run.km;
      continue;
    }
    if (run.km < minRunKm && kept.length) {
      kept[kept.length - 1].km += run.km;
      continue;
    }
    kept.push({ ...run });
  }
  // A short first run can survive the pass above; fold it into the last if they agree.
  if (kept.length > 1 && kept[0].label === kept[kept.length - 1].label) {
    kept[kept.length - 1].km += kept[0].km;
    kept.shift();
  }
  return kept;
}

// "Athabasca County" and "Division No. 9" name an administrative area, not a place on the ground;
// for "open country near X" a town says more.
const ADMINISTRATIVE = /\b(County|Counties|District|Division|Regional|Municipality|Subd|No\.\s*\d+|Part)\b/i;

function nearestPlaceName(data: SplitterData, points: [number, number][]): string | null {
  const [lat, lng] = points[Math.floor(points.length / 2)];
  const kx = detCos(lat * DEG);
  let best: { name: string; d: number } | null = null;
  for (const place of data.places) {
    if (place.population < 5000 || ADMINISTRATIVE.test(place.name)) continue;
    const dx = (place.lng - lng) * kx;
    const dy = place.lat - lat;
    const d = dx * dx + dy * dy;
    if (!best || d < best.d) best = { name: place.name, d };
  }
  return best && best.d < 4 ? best.name : null;
}

/** The runs as sentences, clockwise from the north-west. */
export function bordersInWords(
  data: SplitterData,
  topo: CellTopology,
  assignment: Int32Array,
  region: number,
  options: BordersOptions = {},
): string[] {
  return borderRuns(data, topo, assignment, region, options).map(
    (run) => `${run.where}: ${run.label} (about ${run.km} km)`,
  );
}
