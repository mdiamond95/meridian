import type { RegionDossier, SetAnalysis } from '../schema/dossier';
import { encodeColumn } from '../schema/columns';
import type { RegionPack, RegionPackWire } from '../schema/regionPack';
import type { SplitterData } from '../splitter/data';
import type { CellTopology } from '../splitter/outline';
import type { ExportInput, ExportRegion } from './formats';

/** What the exporters need from a split on screen, a preset, or a test. */
export interface ExportSource {
  title: string;
  assignment: Int32Array;
  regions: { id: number; name: string; capital: string | null; population: number; areaKm2: number }[];
  colours: string[];
  dossiers: RegionDossier[] | null;
  setAnalysis: SetAnalysis | null;
  pack: RegionPackWire;
}

export function exportInput(
  source: ExportSource,
  data: SplitterData,
  topo: CellTopology,
  made = new Date().toISOString().slice(0, 10),
): ExportInput {
  const { centroids } = data.arrays;
  const k = source.regions.length;
  // Label point: the region's cell nearest its mean cell centre, so the label sits inside the region.
  const sums = new Float64Array(3 * k);
  source.assignment.forEach((r, cell) => {
    if (r < 0 || r >= k) return;
    sums[3 * r] += centroids[2 * cell];
    sums[3 * r + 1] += centroids[2 * cell + 1];
    sums[3 * r + 2] += 1;
  });
  const label = new Int32Array(k).fill(-1);
  const best = new Float64Array(k).fill(Infinity);
  source.assignment.forEach((r, cell) => {
    if (r < 0 || r >= k) return;
    const dx = centroids[2 * cell] - sums[3 * r] / sums[3 * r + 2];
    const dy = centroids[2 * cell + 1] - sums[3 * r + 1] / sums[3 * r + 2];
    const d = dx * dx + dy * dy;
    if (d < best[r]) {
      best[r] = d;
      label[r] = cell;
    }
  });
  const regions: ExportRegion[] = source.regions.map((region) => {
    const dossier = source.dossiers?.[region.id] ?? null;
    const capitalName = dossier?.capital?.name ?? region.capital;
    // The capital pin: the place of that name inside the region (or anywhere, for a seeded capital).
    const places = capitalName ? data.places.filter((p) => p.name === capitalName) : [];
    const place = places.find((p) => source.assignment[p.cell] === region.id) ?? places[0];
    const cell = label[region.id];
    return {
      id: region.id,
      name: dossier?.name ?? region.name,
      colour: source.colours[region.id] ?? '#888888',
      population: region.population,
      areaKm2: region.areaKm2,
      capital: place ? { name: place.name, point: [place.lng, place.lat] } : null,
      labelPoint: cell >= 0 ? [centroids[2 * cell], centroids[2 * cell + 1]] : [0, 0],
      dossier,
    };
  });
  return {
    title: source.title,
    topo,
    assignment: source.assignment,
    regions,
    pack: source.pack,
    setAnalysis: source.setAnalysis,
    made,
  };
}

/** An export source for a decoded pack, coloured by region id (tests and the pack file itself). */
export function packExportSource(pack: RegionPack, title: string, colours: readonly string[]): ExportSource {
  const dossiers = pack.regions.map((r) => ('name' in r.dossier ? (r.dossier as RegionDossier) : null));
  const { assignment, ...rest } = pack;
  return {
    title,
    assignment,
    regions: pack.regions.map((r) => ({
      id: r.id,
      name: r.name,
      capital: r.capital,
      population: r.stats.population ?? 0,
      areaKm2: r.stats.areaKm2 ?? 0,
    })),
    colours: pack.regions.map((r) => colours[r.id % colours.length]),
    dossiers: dossiers.every((d) => d) ? (dossiers as RegionDossier[]) : null,
    setAnalysis: 'scope' in pack.setAnalysis ? (pack.setAnalysis as SetAnalysis) : null,
    pack: { ...rest, assignment: encodeColumn(assignment, { kind: 'id' }) } as RegionPackWire,
  };
}
