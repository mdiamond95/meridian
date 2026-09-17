import type { Columns } from '../engine/solver';

/**
 * Lens columns and presets (vision §4, plan Phase 3 Sitting B).
 *
 * A lens is a weighted set of numeric per-cell columns. The attrs file has shares, measures and
 * money, which are used as they are, and categorical ids (ecozone, treaty, party, ...), which a lens
 * cannot average; those are expanded here into 0/1 indicator columns. A few ratios and ranks are
 * derived too. Everything uses only + − × ÷ and sorting, so the same columns come out on every
 * engine (the determinism gate covers splits made with them).
 */

export type LensPresetId =
  'economic' | 'demographic' | 'linguistic' | 'indigenous' | 'physical' | 'political' | 'internal_colony';

export interface LensPreset {
  label: string;
  description: string;
  weights: Record<string, number>;
}

export interface LensInputs {
  columns: Columns;
  lookups: Record<string, Record<string, string>>;
  /** province code per mesh cell */
  provinces: readonly string[];
  /** km² per mesh cell */
  areas: Float64Array;
}

const INDUSTRY = (code: string) => `industry_share_${code}`;

/** Ranks in [0, 1] over `values` (ties by index), optionally within groups. */
export function rank(values: ArrayLike<number>, groups?: readonly string[]): Float32Array {
  const out = new Float32Array(values.length);
  const byGroup = new Map<string, number[]>();
  for (let i = 0; i < values.length; i++) {
    const g = groups ? groups[i] : '';
    const list = byGroup.get(g);
    if (list) list.push(i);
    else byGroup.set(g, [i]);
  }
  for (const members of byGroup.values()) {
    members.sort((a, b) => values[a] - values[b] || a - b);
    const denominator = Math.max(1, members.length - 1);
    members.forEach((cell, r) => (out[cell] = r / denominator));
  }
  return out;
}

function indicator(column: ArrayLike<number>, code: number): Float32Array {
  const out = new Float32Array(column.length);
  for (let i = 0; i < column.length; i++) out[i] = column[i] === code ? 1 : 0;
  return out;
}

/** attrs columns plus the derived ones the presets use. Derived names never collide with attrs. */
export function lensColumns(inputs: LensInputs): Columns {
  const { columns, lookups, provinces, areas } = inputs;
  const n = areas.length;
  const out: Columns = { ...columns };
  const population = columns.population;
  const gdp = columns.gdp_estimate;

  const density = new Float64Array(n);
  const gdpPerCapita = new Float32Array(n);
  const growth = new Float32Array(n);
  const primary = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const people = population ? population[i] : 0;
    density[i] = areas[i] > 0 ? people / areas[i] : 0;
    // GDP is in millions of dollars; per capita in thousands.
    gdpPerCapita[i] = gdp && people > 0 ? (gdp[i] * 1000) / people : 0;
    const before = columns.population_2016?.[i] ?? 0;
    growth[i] = before > 0 ? (people - before) / before : 0;
    primary[i] = (columns[INDUSTRY('11')]?.[i] ?? 0) + (columns[INDUSTRY('21')]?.[i] ?? 0);
  }
  out.gdp_per_capita = gdpPerCapita;
  out.population_growth = growth;
  out.primary_industry_share = primary;
  out.density_rank = rank(density);

  for (const [column, prefix] of [
    ['treaty_code', 'treaty'],
    ['ecozone_id', 'ecozone'],
    ['riding_party_2025', 'party'],
    ['ocean_drainage_id', 'ocean'],
    ['urban_class', 'urban'],
  ] as const) {
    const values = columns[column];
    if (!values) continue;
    for (const code of Object.keys(lookups[column] ?? {})) {
      // Code 0 means "none" or "unknown" everywhere except urban_class, where it is "remote".
      if (code === '0' && column !== 'urban_class') continue;
      out[`${prefix}_${code}`] = indicator(values, Number(code));
    }
  }
  for (const column of ['inuit_region', 'metis_settlement'] as const) {
    const values = columns[column];
    if (!values) continue;
    const any = new Float32Array(n);
    for (let i = 0; i < n; i++) any[i] = values[i] > 0 ? 1 : 0;
    out[`${column}_any`] = any;
  }

  // Internal-colony index (vision §4): distance from the provincial capital, resource outflow and a
  // small share of the province's people, each as a rank within the province, averaged. Ranks keep
  // any one term from dominating and make provinces comparable.
  const distance = columns.distance_to_capital_km;
  if (distance) {
    const distanceRank = rank(distance, provinces);
    const primaryRank = rank(primary, provinces);
    const densityRank = rank(density, provinces);
    const index = new Float32Array(n);
    for (let i = 0; i < n; i++) index[i] = (distanceRank[i] + primaryRank[i] + (1 - densityRank[i])) / 3;
    out.internal_colony_index = index;
  }
  return out;
}

export const LENS_PRESETS: Record<LensPresetId, LensPreset> = {
  economic: {
    label: 'Economic',
    description:
      'GDP per capita, primary industry, manufacturing, finance and professional services, public administration',
    weights: {
      gdp_per_capita: 1,
      primary_industry_share: 1,
      [INDUSTRY('31_33')]: 0.5,
      [INDUSTRY('52')]: 0.5,
      [INDUSTRY('54')]: 0.5,
      [INDUSTRY('91')]: 0.5,
    },
  },
  demographic: {
    label: 'Demographic',
    description: 'Density, growth since 2016, immigrant share, urban–rural–remote',
    weights: {
      density_rank: 1,
      population_growth: 1,
      immigrant_share: 1,
      urban_3: 0.5,
      urban_2: 0.5,
      urban_0: 0.5,
    },
  },
  linguistic: {
    label: 'Linguistic',
    description: 'Mother tongue: English, French, Indigenous languages, other',
    weights: { english_share: 1, french_share: 1, indigenous_language_share: 1, other_language_share: 0.5 },
  },
  indigenous: {
    label: 'Indigenous-constitutional',
    description:
      'Numbered, historic and modern treaties vs unceded land; reserves, Métis settlements, Inuit Nunangat; Indigenous identity',
    weights: {
      treaty_1: 1,
      treaty_2: 1,
      treaty_3: 1,
      treaty_4: 1,
      reserve_share: 0.5,
      metis_settlement_any: 0.5,
      inuit_region_any: 1,
      indigenous_identity_share: 1,
    },
  },
  physical: {
    label: 'Physical',
    description: 'Ecozones and ocean drainage (which carries the Continental Divide)',
    weights: {
      ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`ecozone_${i + 1}`, 1])),
      ocean_1: 1,
      ocean_2: 1,
      ocean_3: 1,
      ocean_4: 1,
      ocean_5: 1,
    },
  },
  political: {
    label: 'Political',
    description: 'Party that won the riding at the 2025 general election',
    weights: { party_1: 1, party_2: 1, party_3: 1, party_4: 1, party_5: 1 },
  },
  internal_colony: {
    label: 'Internal-colony index',
    description:
      'Mean of three ranks within the province: distance from the provincial capital, primary-industry share (NAICS 11 + 21), and sparseness (1 − population-density rank). 0 = closest, densest, least extractive; 1 = furthest, sparsest, most extractive.',
    weights: { internal_colony_index: 1 },
  },
};

/** Columns a lens can weight: numeric attrs columns and derived columns, not ids. */
export function lensCandidates(columns: Columns, kinds: Record<string, string>): string[] {
  return Object.keys(columns)
    .filter((name) => kinds[name] === undefined || !['id', 'count'].includes(kinds[name]))
    .filter((name) => !name.endsWith('_confidence'))
    .sort();
}
