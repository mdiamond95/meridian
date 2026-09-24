import type { ScopeGraph } from '../engine/graph';
import { GDP_CAVEAT, type RegionDossier, type SetAnalysis } from '../schema/dossier';
import type { SplitterData } from '../splitter/data';
import type { CellTopology } from '../splitter/outline';
import type { PreparedSplit } from '../splitter/split';
import { bordersInWords, borderRuns } from './borders';
import { federalismFindings } from './federalism';
import { generateNames } from './names';
import { regionAggregates, topIndustries, type RegionAggregate } from './stats';
import { characterLine, oneSentence, rivalRegion, whatWouldKillIt, whatWouldSaveIt } from './text';

/**
 * Dossiers and set analysis (vision §6, plan Phase 4): pure functions from a split to what it says
 * about itself. Everything is measured from the mesh, attrs and the gazetteer, except the four
 * written fields, which are templates marked as drafts (src/dossier/text.ts).
 */

export interface DossierInput {
  data: SplitterData;
  topo: CellTopology;
  prepared: PreparedSplit;
  /** region id per mesh cell, -1 outside the scope */
  assignment: Int32Array;
  regionCount: number;
  /** names that were chosen rather than generated: capitals, carved metros, manual renames */
  manualNames?: Record<number, string>;
}

function industryLabels(data: SplitterData): Record<string, string> {
  const lookup = data.lookups.industry_dominant ?? {};
  const labels: Record<string, string> = {};
  for (const [code, label] of Object.entries(lookup)) labels[code] = label;
  // The lookup is keyed by the first two digits ("31" for manufacturing, whose column is 31_33).
  for (const name of Object.keys(data.columns)) {
    if (!name.startsWith('industry_share_')) continue;
    const code = name.slice('industry_share_'.length);
    labels[code] ??= lookup[code.slice(0, 2)] ?? `NAICS ${code}`;
  }
  return labels;
}

/** Which regions touch which, over the scope graph (sea crossings included). */
function regionNeighbours(graph: ScopeGraph, assignment: Int32Array, k: number): Set<number>[] {
  const out = Array.from({ length: k }, () => new Set<number>());
  for (let u = 0; u < graph.size; u++) {
    const a = assignment[graph.cells[u]];
    if (a < 0 || a >= k) continue;
    for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++) {
      const b = assignment[graph.cells[graph.targets[e]]];
      if (b >= 0 && b < k && b !== a) out[a].add(b);
    }
  }
  return out;
}

export interface BuiltDossiers {
  dossiers: RegionDossier[];
  aggregates: RegionAggregate[];
  names: string[];
}

export function buildDossiers(input: DossierInput): BuiltDossiers {
  const { data, topo, prepared, assignment, regionCount: k } = input;
  const scopeCells = prepared.scopeGraph.cells;
  const aggregates = regionAggregates(data, scopeCells, assignment, k);
  const labels = industryLabels(data);
  const named = generateNames(data, scopeCells, assignment, aggregates, prepared.spec.seed, {
    manual: input.manualNames,
  });
  const names = named.map((n) => n.name);
  const neighbours = regionNeighbours(prepared.scopeGraph, assignment, k);

  const dossiers = aggregates.map((aggregate, id) => {
    const industries = topIndustries(aggregate, labels);
    const borders = bordersInWords(data, topo, assignment, id);
    const textInputs = {
      name: names[id],
      aggregate,
      set: aggregates,
      topIndustry: industries[0] ?? null,
      borders,
    };
    const growth =
      aggregate.population2016 > 0
        ? (aggregate.population - aggregate.population2016) / aggregate.population2016
        : 0;
    const gdp = aggregate.gdpCadMillions;
    const share = (map: Map<string, number>) =>
      [...map]
        .filter(([, value]) => value > 0.005)
        .sort((a, b) => b[1] - a[1])
        .map(([label, value]) => ({ label, share: Math.round(value * 1000) / 1000 }));
    const party = [...aggregate.parties].sort((a, b) => b[1] - a[1])[0];

    const dossier: RegionDossier = {
      name: names[id],
      nameSource: named[id].source,
      nameReason: named[id].reason,
      capital: aggregate.cities[0]
        ? { name: aggregate.cities[0].name, population: aggregate.cities[0].population }
        : null,
      mainCities: aggregate.cities.slice(1, 3).map((c) => ({ name: c.name, population: c.population })),
      secondaryCities: aggregate.cities.slice(3, 5).map((c) => ({ name: c.name, population: c.population })),
      population: Math.round(aggregate.population),
      areaKm2: Math.round(aggregate.areaKm2),
      densityPerKm2:
        aggregate.areaKm2 > 0 ? Math.round((aggregate.population / aggregate.areaKm2) * 100) / 100 : 0,
      gdpCadMillions: gdp === null ? null : Math.round(gdp),
      gdpCaveat: GDP_CAVEAT,
      gdpPerCapita:
        gdp === null || aggregate.population <= 0 ? null : Math.round((gdp * 1e6) / aggregate.population),
      growth2016to2021: Math.round(growth * 10000) / 10000,
      primaryIndustries: industries.map((i) => ({ ...i, share: Math.round(i.share * 1000) / 1000 })),
      dependencyScore: Math.round((industries[0]?.share ?? 0) * 1000) / 1000,
      urbanShare: Math.round(aggregate.urban * 1000) / 1000,
      internalColonyIndex: Math.round(aggregate.internalColonyIndex * 1000) / 1000,
      distanceToCapitalKmMean: Math.round(aggregate.distanceToCapitalKm),
      languages: {
        english: Math.round(aggregate.english * 1000) / 1000,
        french: Math.round(aggregate.french * 1000) / 1000,
        indigenous: Math.round(aggregate.indigenousLanguage * 1000) / 1000,
        other: Math.round(aggregate.otherLanguage * 1000) / 1000,
      },
      indigenous: {
        identityShare: Math.round(aggregate.indigenousIdentity * 1000) / 1000,
        languageFamilies: share(aggregate.languageFamilies).slice(0, 3),
        majority: aggregate.indigenousIdentity > 0.5,
      },
      treatyComposition: share(aggregate.treaties).slice(0, 5),
      governingParty: {
        party: party?.[0] ?? 'unknown',
        share: Math.round((party?.[1] ?? 0) * 1000) / 1000,
        hypothetical: true,
      },
      bordersInWords: borders,
      characterLine: characterLine(textInputs),
      rivalRegion: rivalRegion(aggregate, aggregates, names, neighbours[id], id),
      oneSentence: oneSentence(textInputs),
      whatWouldKillIt: whatWouldKillIt(textInputs),
      whatWouldSaveIt: whatWouldSaveIt(textInputs),
    };
    return dossier;
  });
  return { dossiers, aggregates, names };
}

export interface SetAnalysisInput extends DossierInput {
  aggregates: RegionAggregate[];
  names: string[];
  /** pieces per region, from the solver's stats */
  pieces: number[];
}

const EXTRACTIVE = ['11', '21'];

export function buildSetAnalysis(input: SetAnalysisInput): SetAnalysis {
  const { data, topo, prepared, assignment, aggregates, names, pieces } = input;
  const scopeCells = prepared.scopeGraph.cells;
  const totalGdp = aggregates.reduce((sum, r) => sum + (r.gdpCadMillions ?? 0), 0);
  const totalPopulation = aggregates.reduce((sum, r) => sum + r.population, 0);
  const extractive = aggregates.map(
    (r) => EXTRACTIVE.reduce((sum, code) => sum + (r.industries.get(code) ?? 0), 0) * r.population,
  );
  const totalExtractive = extractive.reduce((sum, value) => sum + value, 0);

  // Chokepoints: boundary runs that a major river or a provincial border crosses. Rivers and ridings
  // stand in for infrastructure until a highway and rail layer exists (plan Phase 4).
  const chokepoints = aggregates.map(
    (_, id) =>
      borderRuns(data, topo, assignment, id).filter((run) => run.kind === 'river' || run.kind === 'province')
        .length,
  );

  const ranking = aggregates
    .map((r, id) => {
      const economicLeverage = totalGdp > 0 ? (r.gdpCadMillions ?? 0) / totalGdp : 0;
      const resourceOwnership = totalExtractive > 0 ? extractive[id] / totalExtractive : 0;
      const choke = chokepoints[id];
      const maxChoke = Math.max(1, ...chokepoints);
      return {
        id,
        name: names[id] ?? `Region ${id + 1}`,
        economicLeverage: Math.round(economicLeverage * 1000) / 1000,
        chokepoints: choke,
        resourceOwnership: Math.round(resourceOwnership * 1000) / 1000,
        score:
          Math.round((0.5 * economicLeverage + 0.3 * resourceOwnership + 0.2 * (choke / maxChoke)) * 1000) /
          1000,
        rank: 0,
      };
    })
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .map((row, i) => ({ ...row, rank: i + 1 }));

  const ratio = (value: (r: RegionAggregate) => number): number | null => {
    const values = aggregates.map(value).filter((v) => v > 0);
    if (values.length < 2) return null;
    return Math.round((Math.max(...values) / Math.min(...values)) * 100) / 100;
  };

  const metrosSplit = data.cmas
    .map((cma) => {
      const regions = [...new Set(cma.cells.map((cell) => assignment[cell]).filter((r) => r >= 0))].sort(
        (a, b) => a - b,
      );
      return { cma: cma.cma, name: cma.name, regions };
    })
    .filter((entry) => entry.regions.length > 1);

  // Reconciliation: the regions against the scope they came from, cell by cell.
  let scopePopulation = 0;
  let scopeGdp = 0;
  for (const cell of scopeCells) {
    scopePopulation += data.columns.population?.[cell] ?? 0;
    scopeGdp += data.columns.gdp_estimate?.[cell] ?? 0;
  }
  const populationDifference = Math.round(totalPopulation - scopePopulation);
  const gdpDifference = Math.round(totalGdp - scopeGdp);

  const scopeProvinces = [
    ...new Set(scopeCells ? Array.from(scopeCells, (cell) => data.provinces[cell]) : []),
  ];

  return {
    scope: describeScope(prepared),
    regions: aggregates.length,
    powerRanking: ranking,
    ratios: {
      population: ratio((r) => r.population),
      area: ratio((r) => r.areaKm2),
      gdp: ratio((r) => r.gdpCadMillions ?? 0),
    },
    metrosSplit,
    reconciliation: {
      population: {
        regions: Math.round(totalPopulation),
        scope: Math.round(scopePopulation),
        difference: populationDifference,
      },
      gdp: { regions: Math.round(totalGdp), scope: Math.round(scopeGdp), difference: gdpDifference },
      ok:
        Math.abs(populationDifference) <= 1 &&
        Math.abs(gdpDifference) <= Math.max(1, Math.round(scopeGdp * 1e-6)),
    },
    contiguityLog: pieces
      .map((count, id) => ({
        id,
        name: names[id] ?? `Region ${id + 1}`,
        pieces: count,
        note:
          count > 1
            ? `${count} pieces: contiguity was soft or off, or the region spans water the mesh does not bridge.`
            : 'one piece',
      }))
      .filter((row) => row.pieces > 1),
    federalism: federalismFindings({ regions: aggregates, names, scopeProvinces }),
    gdpCaveat: GDP_CAVEAT,
  };
}

function describeScope(prepared: PreparedSplit): string {
  const scope = prepared.spec.scope;
  switch (scope.kind) {
    case 'canada':
      return 'Canada';
    case 'province':
      return scope.province;
    case 'atlasUnit':
      return `${scope.unit} at ${prepared.spec.date ?? 'today'}`;
    case 'atlasSovereign':
      return `${scope.sovereign} at ${prepared.spec.date ?? 'today'}`;
    case 'region':
      return `region ${scope.region} of ${scope.pack}`;
    case 'polygon':
      return 'a drawn polygon';
  }
}
