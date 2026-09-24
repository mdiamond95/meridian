import type { SplitterData } from '../splitter/data';

/**
 * Non-geographic overlays (vision §8, plan Phase 6 §3): points and flows drawn from attributes, over
 * whatever partition is on screen, without claiming a single cell. A region's name and colour come
 * from the split; an overlay says something that cuts across it (who lives in a city, who commutes
 * from where), so the two can be read together.
 *
 * An overlay is a definition plus a pure `build` from the splitter's data; OverlayLayer draws any of
 * them. Point overlays ship first; flows have their renderer but no data yet (docs/backlog.md:
 * rotational workforce, waiting for a curated home-to-camp table).
 */

export interface OverlayPoint {
  lng: number;
  lat: number;
  /** 0–1, drawn as the marker's size */
  size: number;
  /** 0–1, drawn as its colour */
  value: number;
  label: string;
  detail: string;
}

export interface OverlayFlow {
  from: [number, number];
  to: [number, number];
  /** 0–1, drawn as the line's weight */
  weight: number;
  label: string;
}

interface OverlayBase {
  id: string;
  label: string;
  /** what size and colour mean, for the legend */
  legend: string;
  source: string;
}

export type OverlayDef =
  | (OverlayBase & { kind: 'point'; build: (data: SplitterData) => OverlayPoint[] })
  | (OverlayBase & { kind: 'flow'; build: (data: SplitterData) => OverlayFlow[] });

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmt = new Intl.NumberFormat('en-CA');

/**
 * Immigrant-share halos over census metropolitan areas: one circle per CMA at its population-weighted
 * centre, sized by population (area proportional to people) and coloured by the share of residents who
 * are immigrants, population-weighted over its cells (2021 census, `immigrant_share`).
 */
export function immigrantHalos(data: SplitterData): OverlayPoint[] {
  const population = data.columns.population;
  const share = data.columns.immigrant_share;
  if (!population || !share) return [];
  const rows = data.cmas.map((cma) => {
    let people = 0;
    let immigrants = 0;
    let x = 0;
    let y = 0;
    for (const cell of cma.cells) {
      const p = population[cell];
      people += p;
      immigrants += p * share[cell];
      x += p * data.arrays.centroids[2 * cell];
      y += p * data.arrays.centroids[2 * cell + 1];
    }
    const first = cma.cells[0];
    return {
      name: cma.name,
      people,
      share: people > 0 ? immigrants / people : 0,
      lng: people > 0 ? x / people : data.arrays.centroids[2 * first],
      lat: people > 0 ? y / people : data.arrays.centroids[2 * first + 1],
    };
  });
  const maxPeople = Math.max(1, ...rows.map((r) => r.people));
  const maxShare = Math.max(1e-9, ...rows.map((r) => r.share));
  return rows
    .sort((a, b) => b.people - a.people) // big halos first, so small ones draw on top
    .map((r) => ({
      lng: r.lng,
      lat: r.lat,
      size: Math.sqrt(r.people / maxPeople),
      value: r.share / maxShare,
      label: r.name,
      detail: `${r.name}: ${pct(r.share)} immigrants, ${fmt.format(Math.round(r.people))} people (2021 census)`,
    }));
}

export const OVERLAYS: OverlayDef[] = [
  {
    id: 'immigrant-halos',
    kind: 'point',
    label: 'Immigrant share (CMAs)',
    legend: 'Circle area: population. Colour: share of residents who are immigrants, darkest = highest.',
    source: 'Statistics Canada, 2021 Census of Population, allocated to the mesh (attrs immigrant_share)',
    build: immigrantHalos,
  },
];
