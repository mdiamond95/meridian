import type { Feature, FeatureCollection, MultiPolygon, Position } from 'geojson';
import { dossierFacts } from '../dossier/fields';
import { setMarkdown } from '../dossier/markdown';
import type { RegionDossier, SetAnalysis } from '../schema/dossier';
import type { RegionPackWire } from '../schema/regionPack';
import type { CellTopology } from '../splitter/outline';
import { dividingLines, inRing, regionMultiPolygons, regionTopology, type RegionTopology } from './geometry';

/**
 * A split in every format the other projects need (plan Phase 5 §1): the pack, GeoJSON and TopoJSON
 * of the dissolved regions with their dossier properties, KML laid out for Google My Maps (one folder
 * per region with its polygon and capital pin, the dividing lines in a folder of their own), SVG (and
 * PNG from it, in png.ts), and the Markdown dossier.
 */

export interface ExportRegion {
  id: number;
  name: string;
  colour: string;
  population: number;
  areaKm2: number;
  /** the capital's name and position, when the region has one */
  capital: { name: string; point: [number, number] } | null;
  /** where the region's label goes: a cell centre inside it */
  labelPoint: [number, number];
  dossier: RegionDossier | null;
}

export interface ExportInput {
  title: string;
  topo: CellTopology;
  assignment: Int32Array;
  regions: ExportRegion[];
  pack: RegionPackWire;
  setAnalysis: SetAnalysis | null;
  /** when the export was made, YYYY-MM-DD */
  made: string;
}

const ATTRIBUTION_LINES = [
  'Contains information licensed under the Open Government Licence – Canada',
  '(Statistics Canada, Natural Resources Canada). Regions: Meridian.',
] as const;
export const ATTRIBUTION = ATTRIBUTION_LINES.join(' ');

const fmt = new Intl.NumberFormat('en-CA');

/** Flat properties for GeoJSON, TopoJSON and KML: the numbers every GIS can show, then the dossier. */
export function regionProperties(region: ExportRegion) {
  const d = region.dossier;
  return {
    regionId: region.id,
    name: region.name,
    capital: region.capital?.name ?? null,
    colour: region.colour,
    population: region.population,
    areaKm2: Math.round(region.areaKm2),
    ...(d
      ? {
          gdpCadMillions: d.gdpCadMillions,
          gdpCaveat: d.gdpCaveat,
          growth2016to2021: d.growth2016to2021,
          urbanShare: d.urbanShare,
          internalColonyIndex: d.internalColonyIndex,
          governingParty: d.governingParty.party,
          oneSentence: d.oneSentence.text,
          dossier: d,
        }
      : {}),
  };
}

export function regionsGeoJSON(input: ExportInput): FeatureCollection<MultiPolygon> {
  const polygons = regionMultiPolygons(input.topo, input.assignment);
  const features: Feature<MultiPolygon>[] = input.regions
    .filter((r) => polygons.has(r.id))
    .map((region) => ({
      type: 'Feature',
      id: region.id,
      properties: regionProperties(region),
      geometry: polygons.get(region.id) as MultiPolygon,
    }));
  return { type: 'FeatureCollection', features };
}

export function regionsTopoJSON(input: ExportInput): RegionTopology {
  const byId = new Map(input.regions.map((r) => [r.id, r]));
  return regionTopology(input.topo, input.assignment, (id) => {
    const region = byId.get(id);
    return region ? regionProperties(region) : { regionId: id };
  });
}

// ---------------------------------------------------------------------------------------------- KML

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** KML colours are aabbggrr. */
function kmlColour(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2));
  return `${alpha.toString(16).padStart(2, '0')}${b}${g}${r}`.toLowerCase();
}

const coords = (ring: Position[]) => ring.map((p) => `${p[0]},${p[1]}`).join(' ');

function kmlPolygon(polygon: Position[][]): string {
  const [outer, ...holes] = polygon;
  return (
    `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(outer)}</coordinates></LinearRing></outerBoundaryIs>` +
    holes
      .map(
        (h) =>
          `<innerBoundaryIs><LinearRing><coordinates>${coords(h)}</coordinates></LinearRing></innerBoundaryIs>`,
      )
      .join('') +
    '</Polygon>'
  );
}

function kmlData(values: Record<string, string | number | null>): string {
  return (
    '<ExtendedData>' +
    Object.entries(values)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `<Data name="${xml(k)}"><value>${xml(String(v))}</value></Data>`)
      .join('') +
    '</ExtendedData>'
  );
}

function kmlDescription(region: ExportRegion): string {
  const d = region.dossier;
  if (!d)
    return `Population ${fmt.format(region.population)}; ${fmt.format(Math.round(region.areaKm2))} km².`;
  return [d.oneSentence.text, ...dossierFacts(d).map((f) => `${f.label}: ${f.value}`)].join('\n');
}

/**
 * KML 2.2, valid against the OGC schema: styles first, then a folder per region (its polygon and its
 * capital pin), then a folder of the lines dividing neighbouring regions — the layout used for the
 * Alberta map in Google My Maps.
 */
export function regionsKML(input: ExportInput): string {
  const polygons = regionMultiPolygons(input.topo, input.assignment);
  const names = new Map(input.regions.map((r) => [r.id, r.name]));
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
  out.push('<Document>');
  out.push(`<name>${xml(input.title)}</name>`);
  out.push(
    `<description>${xml(`${input.regions.length} regions, made ${input.made} on mesh ${input.pack.meta.meshVersion}. ${ATTRIBUTION}`)}</description>`,
  );
  for (const region of input.regions) {
    out.push(
      `<Style id="region-${region.id}"><LineStyle><color>${kmlColour(region.colour, 255)}</color><width>1.5</width></LineStyle>` +
        `<PolyStyle><color>${kmlColour(region.colour, 0x80)}</color></PolyStyle></Style>`,
    );
  }
  out.push(
    '<Style id="dividing-line"><LineStyle><color>ff333333</color><width>2.5</width></LineStyle></Style>',
  );
  for (const region of input.regions) {
    const polygon = polygons.get(region.id);
    if (!polygon) continue;
    out.push(`<Folder><name>${xml(region.name)}</name>`);
    out.push(
      `<Placemark><name>${xml(region.name)}</name><description>${xml(kmlDescription(region))}</description>` +
        `<styleUrl>#region-${region.id}</styleUrl>` +
        kmlData({
          regionId: region.id,
          population: region.population,
          areaKm2: Math.round(region.areaKm2),
          capital: region.capital?.name ?? null,
        }) +
        `<MultiGeometry>${polygon.coordinates.map(kmlPolygon).join('')}</MultiGeometry></Placemark>`,
    );
    if (region.capital) {
      const [lng, lat] = region.capital.point;
      out.push(
        `<Placemark><name>${xml(region.capital.name)}</name><description>${xml(`Capital of ${region.name}`)}</description>` +
          kmlData({ regionId: region.id, role: 'capital' }) +
          `<Point><coordinates>${lng},${lat}</coordinates></Point></Placemark>`,
      );
    }
    out.push('</Folder>');
  }
  const lines = dividingLines(input.topo, input.assignment);
  if (lines.length) {
    out.push('<Folder><name>Dividing lines</name>');
    for (const line of lines) {
      const [a, b] = line.regions.map((r) => names.get(r) ?? `Region ${r + 1}`);
      out.push(
        `<Placemark><name>${xml(`${a} | ${b}`)}</name><styleUrl>#dividing-line</styleUrl>` +
          kmlData({ between: `${line.regions[0]},${line.regions[1]}` }) +
          `<MultiGeometry>${line.lines.map((l) => `<LineString><coordinates>${coords(l)}</coordinates></LineString>`).join('')}</MultiGeometry></Placemark>`,
      );
    }
    out.push('</Folder>');
  }
  out.push('</Document>');
  out.push('</kml>');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------- SVG

/**
 * Statistics Canada Lambert (EPSG:3347's parameters) on the sphere: standard parallels 49° and 77°,
 * centred at 63.390675°N, 91.866667°W. Returns metres.
 */
export function lambert(lng: number, lat: number): [number, number] {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const [p1, p2, p0, l0] = [49 * rad, 77 * rad, 63.390675 * rad, -91.866667 * rad];
  const t = (p: number) => Math.tan(Math.PI / 4 + p / 2);
  const n = Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(p2) / t(p1));
  const F = (Math.cos(p1) * Math.pow(t(p1), n)) / n;
  const rho = (R * F) / Math.pow(t(lat * rad), n);
  const rho0 = (R * F) / Math.pow(t(p0), n);
  const theta = n * (lng * rad - l0);
  return [rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
}

/** A scale-bar length near a target, from 1, 2 and 5 times a power of ten. */
export function niceKm(target: number): number {
  const power = Math.pow(10, Math.floor(Math.log10(target)));
  return [5, 2, 1].map((m) => m * power).find((km) => km <= target) ?? power;
}

export interface SvgOptions {
  /** width of the map area in px; the legend adds 320 */
  width?: number;
}

/** The regions, their names, a legend, a scale bar, a date stamp and the attribution, as one SVG. */
export function regionsSVG(input: ExportInput, options: SvgOptions = {}): string {
  const mapWidth = options.width ?? 960;
  const legendWidth = 320;
  const margin = 24;
  const polygons = regionMultiPolygons(input.topo, input.assignment);
  const all: [number, number][] = [];
  for (const mp of polygons.values()) {
    for (const polygon of mp.coordinates) for (const p of polygon[0]) all.push(lambert(p[0], p[1]));
  }
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = (mapWidth - 2 * margin) / Math.max(x1 - x0, 1);
  const mapHeight = Math.max(360, Math.round((y1 - y0) * scale + 2 * margin));
  const height = Math.max(mapHeight + 60, 110 + input.regions.length * 22);
  const px = (lng: number, lat: number) => {
    const [x, y] = lambert(lng, lat);
    return [(x - x0) * scale + margin, (y1 - y) * scale + margin].map((v) => Math.round(v * 10) / 10);
  };
  const path = (mp: MultiPolygon) =>
    mp.coordinates
      .map((polygon) =>
        polygon.map((ring) => 'M' + ring.map((p) => px(p[0], p[1]).join(',')).join('L') + 'Z').join(''),
      )
      .join('');

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${mapWidth + legendWidth}" height="${height}" viewBox="0 0 ${mapWidth + legendWidth} ${height}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif">`,
  );
  out.push(`<title>${xml(input.title)}</title>`);
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  out.push('<g id="regions" stroke="#ffffff" stroke-width="0.8" stroke-linejoin="round">');
  for (const region of input.regions) {
    const mp = polygons.get(region.id);
    if (!mp) continue;
    out.push(
      `<path data-region="${region.id}" fill="${region.colour}" fill-rule="evenodd" d="${path(mp)}"><title>${xml(region.name)}</title></path>`,
    );
  }
  out.push('</g>');
  out.push(
    '<g id="labels" font-size="11" font-weight="600" text-anchor="middle" fill="#1a1a1a" stroke="#ffffff" stroke-width="3" paint-order="stroke">',
  );
  for (const region of input.regions) {
    const [x, y] = px(region.labelPoint[0], region.labelPoint[1]);
    out.push(`<text x="${x}" y="${y}">${xml(region.name)}</text>`);
  }
  out.push('</g>');

  // Scale bar, true at the latitude of the map's centre.
  const mid = inverseCentre(polygons);
  const kmPerDegree = 111.32 * Math.cos((mid[1] * Math.PI) / 180);
  const [ax] = px(mid[0], mid[1]);
  const [bx] = px(mid[0] + 100 / kmPerDegree, mid[1]);
  const pxPerKm = Math.abs(bx - ax) / 100;
  const km = niceKm(160 / pxPerKm);
  const bar = Math.round(km * pxPerKm);
  const sy = mapHeight - margin;
  out.push(
    `<g id="scale-bar" font-size="11" fill="#1a1a1a"><rect x="${margin}" y="${sy - 6}" width="${bar}" height="6" fill="#1a1a1a"/>` +
      `<text x="${margin}" y="${sy - 10}">${fmt.format(km)} km</text>` +
      `<text x="${margin + bar + 8}" y="${sy}" fill="#666">at ${mid[1].toFixed(0)}°N</text></g>`,
  );

  // Legend, date stamp and attribution in the right-hand column.
  const lx = mapWidth + 8;
  out.push(`<g id="legend" font-size="12" fill="#1a1a1a">`);
  out.push(`<text x="${lx}" y="${margin + 4}" font-size="15" font-weight="700">${xml(input.title)}</text>`);
  input.regions.forEach((region, i) => {
    const y = margin + 30 + i * 22;
    out.push(
      `<rect x="${lx}" y="${y - 11}" width="14" height="14" rx="2" fill="${region.colour}"/>` +
        `<text x="${lx + 22}" y="${y}">${xml(region.name)}</text>` +
        `<text x="${lx + legendWidth - 16}" y="${y}" text-anchor="end" fill="#555">${fmt.format(region.population)}</text>`,
    );
  });
  out.push('</g>');
  const date = input.pack.meta.date ?? 'present day';
  out.push(
    `<text id="date-stamp" x="${lx}" y="${height - 40}" font-size="11" fill="#555">Made ${input.made} · atlas date ${xml(date)} · mesh ${xml(input.pack.meta.meshVersion)} · seed ${input.pack.meta.seed}</text>`,
  );
  const [first, second] = ATTRIBUTION_LINES;
  out.push(
    `<text id="attribution" x="${lx}" y="${height - 20}" font-size="10" fill="#666">${xml(first)}<tspan x="${lx}" dy="13">${xml(second)}</tspan></text>`,
  );
  out.push('</svg>');
  return out.join('\n') + '\n';
}

function inverseCentre(polygons: Map<number, MultiPolygon>): [number, number] {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const mp of polygons.values()) {
    for (const polygon of mp.coordinates) {
      for (const [x, y] of polygon[0]) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

// ------------------------------------------------------------------------------------------ helpers

export function setMarkdownFor(input: ExportInput): string | null {
  const dossiers = input.regions.map((r) => r.dossier);
  if (!input.setAnalysis || dossiers.some((d) => !d)) return null;
  return setMarkdown(input.setAnalysis, dossiers as RegionDossier[], input.title);
}

/** Which exported region polygon holds a point, by regionId; -1 for none. */
export function regionAt(features: Feature[], lng: number, lat: number): number {
  for (const feature of features) {
    const g = feature.geometry;
    const polygons = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : [];
    for (const [outer, ...holes] of polygons) {
      if (inRing(outer, lng, lat) && !holes.some((h) => inRing(h, lng, lat))) {
        return Number(feature.properties?.regionId ?? -1);
      }
    }
  }
  return -1;
}
