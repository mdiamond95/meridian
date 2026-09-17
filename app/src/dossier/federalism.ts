import type { FederalismFinding } from '../schema/dossier';
import rules from './federalism.rules.json';
import type { RegionAggregate } from './stats';

/**
 * The federalism panel: what a redrawn map breaks (vision §6).
 *
 * The rules and their citations live in federalism.yaml, one entry per rule, so the reasoning can be
 * read and argued with in one place; `npm run rules` compiles it to federalism.rules.json, which is
 * what loads here (the same file in the app, in Vitest and in the presets script). Each rule names an
 * `evaluator`; the functions here are the only thing that computes, and each returns a verdict and a
 * sentence of detail. Nothing here is legal advice: a verdict says what the instrument requires and
 * what the set does.
 */

interface RuleSpec {
  id: string;
  title: string;
  citation: string;
  url: string;
  evaluator: string;
  detail: string;
}

interface RulesFile {
  version: number;
  senate_divisions: Record<string, string[]>;
  rules: RuleSpec[];
}

export const FEDERALISM_RULES = rules as RulesFile;

export interface FederalismInput {
  /** one aggregate per region */
  regions: RegionAggregate[];
  names: string[];
  /** provinces the scope covers, so a provincial scope is not judged as if it were Canada */
  scopeProvinces: string[];
}

const TERRITORIES = ['YT', 'NT', 'NU'];

function divisionOf(province: string, divisions: Record<string, string[]>): string {
  for (const [division, members] of Object.entries(divisions))
    if (members.includes(province)) return division;
  return 'unknown';
}

type Evaluator = (
  input: FederalismInput,
  rule: RuleSpec,
) => { verdict: FederalismFinding['verdict']; detail: string };

const EVALUATORS: Record<string, Evaluator> = {
  senate_divisions: ({ regions, names }, rule) => {
    const divisions = FEDERALISM_RULES.senate_divisions;
    const spanning = regions
      .map((region, i) => ({
        name: names[i] ?? `Region ${i + 1}`,
        divisions: new Set(region.provinces.map((p) => divisionOf(p, divisions))),
      }))
      .filter((r) => r.divisions.size > 1);
    if (!spanning.length) {
      return { verdict: 'holds', detail: `${rule.detail} No region spans two Senate divisions.` };
    }
    return {
      verdict: 'breaks',
      detail: `${rule.detail} ${spanning.length} region${spanning.length === 1 ? '' : 's'} span two or more divisions: ${spanning
        .map((r) => r.name)
        .slice(0, 5)
        .join(', ')}.`,
    };
  },

  seven_fifty: ({ regions }, rule) => {
    const total = regions.reduce((sum, r) => sum + r.population, 0);
    const needed = Math.ceil((regions.length * 2) / 3);
    const sorted = [...regions].sort((a, b) => b.population - a.population);
    const topShare = sorted.slice(0, needed).reduce((sum, r) => sum + r.population, 0) / (total || 1);
    const smallestShare = sorted.slice(-needed).reduce((sum, r) => sum + r.population, 0) / (total || 1);
    const detail =
      `${rule.detail} Two-thirds of ${regions.length} units is ${needed}. The ${needed} largest hold ` +
      `${Math.round(topShare * 100)}% of the people; the ${needed} smallest hold ${Math.round(smallestShare * 100)}%.`;
    if (smallestShare >= 0.5)
      return { verdict: 'breaks', detail: `${detail} Any ${needed} units can amend alone.` };
    if (topShare < 0.5)
      return { verdict: 'breaks', detail: `${detail} No ${needed} units reach half the population.` };
    return { verdict: 'strained', detail };
  },

  fiscal_capacity: ({ regions, names }, rule) => {
    const withGdp = regions.filter((r) => r.gdpCadMillions !== null && r.population > 0);
    if (!withGdp.length) return { verdict: 'holds', detail: `${rule.detail} No GDP estimate for this set.` };
    const totalGdp = withGdp.reduce((sum, r) => sum + (r.gdpCadMillions ?? 0), 0);
    const totalPeople = withGdp.reduce((sum, r) => sum + r.population, 0);
    const average = totalGdp / totalPeople;
    const below = withGdp.filter((r) => (r.gdpCadMillions ?? 0) / r.population < average);
    const poorest = [...withGdp].sort(
      (a, b) => (a.gdpCadMillions ?? 0) / a.population - (b.gdpCadMillions ?? 0) / b.population,
    )[0];
    const poorestName = names[regions.indexOf(poorest)] ?? 'the poorest region';
    return {
      verdict: below.length > regions.length / 2 ? 'strained' : 'holds',
      detail:
        `${rule.detail} ${below.length} of ${regions.length} regions fall below the set's GDP per person; ` +
        `${poorestName} is furthest below it. GDP here is an allocation, so read this as a shape, not a payment.`,
    };
  },

  quebec_intact: ({ regions, names, scopeProvinces }, rule) => {
    if (!scopeProvinces.includes('QC')) {
      return { verdict: 'holds', detail: `${rule.detail} This scope does not include Quebec.` };
    }
    const touching = regions
      .map((region, i) => ({ name: names[i] ?? `Region ${i + 1}`, quebec: region.provinces.includes('QC') }))
      .filter((r) => r.quebec);
    const mixed = regions.filter((r) => r.provinces.includes('QC') && r.provinces.length > 1).length;
    if (touching.length === 1 && !mixed)
      return { verdict: 'holds', detail: `${rule.detail} Quebec is one region here.` };
    return {
      verdict: mixed ? 'breaks' : 'strained',
      detail:
        `${rule.detail} Quebec is spread over ${touching.length} regions` +
        (mixed ? `, and ${mixed} of them also hold ground in another province.` : '.'),
    };
  },

  territories_intact: ({ regions, names, scopeProvinces }, rule) => {
    if (!scopeProvinces.some((p) => TERRITORIES.includes(p))) {
      return { verdict: 'holds', detail: `${rule.detail} This scope has no territory in it.` };
    }
    const mixed = regions
      .map((region, i) => ({
        name: names[i] ?? `Region ${i + 1}`,
        mixes:
          region.provinces.some((p) => TERRITORIES.includes(p)) &&
          region.provinces.some((p) => !TERRITORIES.includes(p)),
      }))
      .filter((r) => r.mixes);
    if (!mixed.length)
      return { verdict: 'holds', detail: `${rule.detail} No region joins territory to province.` };
    return {
      verdict: 'breaks',
      detail: `${rule.detail} ${mixed.length} region${mixed.length === 1 ? '' : 's'} join territory to province: ${mixed
        .map((r) => r.name)
        .slice(0, 5)
        .join(', ')}.`,
    };
  },

  senate_floor: ({ regions }, rule) => {
    const total = regions.reduce((sum, r) => sum + r.population, 0);
    const smallest = [...regions].sort((a, b) => a.population - b.population)[0];
    const share = total > 0 ? smallest.population / total : 0;
    // 338 Commons seats, so a unit under 1/338 of the people is already over-represented by the floor.
    const seatShare = 1 / 338;
    return {
      verdict: share < seatShare ? 'strained' : 'holds',
      detail:
        `${rule.detail} The smallest region holds ${(share * 100).toFixed(1)}% of the set's people` +
        (share < seatShare ? `, under one seat's worth, so the floor would carry it.` : `.`),
    };
  },
};

/** Every rule in the YAML, evaluated against the set. */
export function federalismFindings(input: FederalismInput): FederalismFinding[] {
  return FEDERALISM_RULES.rules.map((rule) => {
    const evaluator = EVALUATORS[rule.evaluator];
    const { verdict, detail } = evaluator
      ? evaluator(input, rule)
      : { verdict: 'holds' as const, detail: `${rule.detail} No evaluator for "${rule.evaluator}".` };
    return { id: rule.id, title: rule.title, citation: rule.citation, url: rule.url, verdict, detail };
  });
}
