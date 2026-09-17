import type { SplitterData } from '../splitter/data';

/**
 * Per-region aggregates behind the dossiers (vision §6): one pass over the cells of a scope.
 *
 * Shares are population-weighted, because they describe people, not hexagons; area-like numbers
 * (area, the internal-colony index, distance to the capital) are cell means or sums, and say so.
 * Cities come from cell populations summed by census subdivision, so a city split between regions is
 * counted in each of them by the part it has.
 */

export interface CityCount {
  csd: string;
  name: string;
  population: number;
}

export interface RegionAggregate {
  cells: number;
  population: number;
  population2016: number;
  areaKm2: number;
  gdpCadMillions: number | null;
  /** population-weighted shares */
  english: number;
  french: number;
  indigenousLanguage: number;
  otherLanguage: number;
  indigenousIdentity: number;
  immigrant: number;
  urban: number;
  /** labour-force shares by NAICS sector code */
  industries: Map<string, number>;
  /** population-weighted share by treaty label */
  treaties: Map<string, number>;
  /** population-weighted share by Indigenous language family label */
  languageFamilies: Map<string, number>;
  /** population-weighted share by party label */
  parties: Map<string, number>;
  /** cell means */
  internalColonyIndex: number;
  distanceToCapitalKm: number;
  /** census subdivisions inside the region, most people first */
  cities: CityCount[];
  /** province codes present, most people first */
  provinces: string[];
}

const INDUSTRY_PREFIX = 'industry_share_';

function top(map: Map<string, number>, n: number): [string, number][] {
  return [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
}

/** Aggregates for regions 0..k-1 over the cells of `graphCells` (the scope). */
export function regionAggregates(
  data: SplitterData,
  scopeCells: Int32Array,
  assignment: Int32Array,
  k: number,
): RegionAggregate[] {
  const { columns, lookups, arrays } = data;
  const population = columns.population;
  const population2016 = columns.population_2016;
  const gdp = columns.gdp_estimate;
  const industryCodes = Object.keys(columns)
    .filter((name) => name.startsWith(INDUSTRY_PREFIX))
    .map((name) => name.slice(INDUSTRY_PREFIX.length))
    .sort();

  const out: RegionAggregate[] = Array.from({ length: k }, () => ({
    cells: 0,
    population: 0,
    population2016: 0,
    areaKm2: 0,
    gdpCadMillions: gdp ? 0 : null,
    english: 0,
    french: 0,
    indigenousLanguage: 0,
    otherLanguage: 0,
    indigenousIdentity: 0,
    immigrant: 0,
    urban: 0,
    industries: new Map<string, number>(),
    treaties: new Map<string, number>(),
    languageFamilies: new Map<string, number>(),
    parties: new Map<string, number>(),
    internalColonyIndex: 0,
    distanceToCapitalKm: 0,
    cities: [],
    provinces: [],
  }));
  const weight = new Float64Array(k);
  const byCsd = Array.from({ length: k }, () => new Map<string, number>());
  const byProvince = Array.from({ length: k }, () => new Map<string, number>());

  const add = (map: Map<string, number>, key: string, value: number) =>
    map.set(key, (map.get(key) ?? 0) + value);

  for (const cell of scopeCells) {
    const r = assignment[cell];
    if (r < 0 || r >= k) continue;
    const region = out[r];
    const people = population ? population[cell] : 0;
    region.cells++;
    region.population += people;
    region.population2016 += population2016 ? population2016[cell] : 0;
    region.areaKm2 += arrays.areas[cell];
    if (gdp && region.gdpCadMillions !== null) region.gdpCadMillions += gdp[cell];
    region.internalColonyIndex += columns.internal_colony_index?.[cell] ?? 0;
    region.distanceToCapitalKm += columns.distance_to_capital_km?.[cell] ?? 0;

    // Shares weight people; a cell with nobody in it describes nobody.
    const w = people;
    weight[r] += w;
    region.english += w * (columns.english_share?.[cell] ?? 0);
    region.french += w * (columns.french_share?.[cell] ?? 0);
    region.indigenousLanguage += w * (columns.indigenous_language_share?.[cell] ?? 0);
    region.otherLanguage += w * (columns.other_language_share?.[cell] ?? 0);
    region.indigenousIdentity += w * (columns.indigenous_identity_share?.[cell] ?? 0);
    region.immigrant += w * (columns.immigrant_share?.[cell] ?? 0);
    region.urban += w * ((columns.urban_class?.[cell] ?? 0) >= 2 ? 1 : 0);
    for (const code of industryCodes)
      add(region.industries, code, w * (columns[INDUSTRY_PREFIX + code]?.[cell] ?? 0));
    const treaty = lookups.treaty_code?.[String(columns.treaty_code?.[cell] ?? 0)];
    if (treaty) add(region.treaties, treaty, w);
    const family =
      lookups.indigenous_language_family?.[String(columns.indigenous_language_family?.[cell] ?? 0)];
    if (family && family !== 'unassigned') add(region.languageFamilies, family, w);
    const party = lookups.riding_party_2025?.[String(columns.riding_party_2025?.[cell] ?? 0)];
    if (party) add(region.parties, party, w);

    add(byCsd[r], data.csds[cell], people);
    add(byProvince[r], data.provinces[cell], people);
  }

  out.forEach((region, r) => {
    const w = weight[r];
    const norm = (value: number) => (w > 0 ? value / w : 0);
    region.english = norm(region.english);
    region.french = norm(region.french);
    region.indigenousLanguage = norm(region.indigenousLanguage);
    region.otherLanguage = norm(region.otherLanguage);
    region.indigenousIdentity = norm(region.indigenousIdentity);
    region.immigrant = norm(region.immigrant);
    region.urban = norm(region.urban);
    for (const map of [region.industries, region.treaties, region.languageFamilies, region.parties]) {
      for (const [key, value] of map) map.set(key, norm(value));
    }
    region.internalColonyIndex = region.cells ? region.internalColonyIndex / region.cells : 0;
    region.distanceToCapitalKm = region.cells ? region.distanceToCapitalKm / region.cells : 0;
    region.cities = top(byCsd[r], 8)
      .filter(([csd, people]) => people > 0 && data.placeByCsd.has(csd))
      .map(([csd, people]) => ({
        csd,
        name: data.placeByCsd.get(csd)?.name ?? csd,
        population: Math.round(people),
      }));
    region.provinces = top(byProvince[r], 13).map(([code]) => code);
  });
  return out;
}

/** The top `n` industries of a region, with their labels. */
export function topIndustries(region: RegionAggregate, labels: Record<string, string>, n = 3) {
  return top(region.industries, n)
    .filter(([, share]) => share > 0)
    .map(([code, share]) => ({ code, label: labels[code] ?? `NAICS ${code}`, share }));
}
