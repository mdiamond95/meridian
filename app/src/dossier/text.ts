import { PLACEHOLDER_MARK, type DossierText } from '../schema/dossier';
import type { RegionAggregate } from './stats';

/**
 * The written fields of a dossier: character line, the One Sentence, what would kill it, what would
 * save it (vision §6).
 *
 * The style rule (Mark, 2026-09-17): **one sentence, concrete, and no adjective that could apply to
 * any region.** So every line here is built from this region's own numbers and names — a share, a
 * city, an industry, a border — and never from a word like "vast" or "diverse". `VAGUE_WORDS` is the
 * list the tests hold these lines to.
 *
 * All four are templates, so each is marked `placeholder: true` and opens with ⟨draft⟩ until it is
 * rewritten by hand. They never state anything the aggregates do not.
 */

/** Adjectives that could be said of any region; a generated line may not use them. */
export const VAGUE_WORDS = [
  'vast',
  'diverse',
  'unique',
  'vibrant',
  'beautiful',
  'stunning',
  'important',
  'significant',
  'major',
  'key',
  'dynamic',
  'rich',
  'proud',
  'sprawling',
  'rugged',
  'picturesque',
  'bustling',
  'strategic',
  'iconic',
  'historic',
  'stark',
  'sweeping',
  'dramatic',
];

const pct = (share: number) => `${Math.round(share * 100)}%`;
const people = (n: number) => new Intl.NumberFormat('en-CA').format(Math.round(n));

function draft(text: string): DossierText {
  return { text: `${PLACEHOLDER_MARK} ${text}`, placeholder: true };
}

export interface TextInputs {
  name: string;
  aggregate: RegionAggregate;
  /** the same aggregates for the whole set, to see what this region has most of */
  set: RegionAggregate[];
  topIndustry: { label: string; share: number } | null;
  borders: string[];
}

/** Is this region the set's extreme on `value`? */
function highest(
  set: RegionAggregate[],
  aggregate: RegionAggregate,
  value: (r: RegionAggregate) => number,
): boolean {
  const mine = value(aggregate);
  return set.every((other) => other === aggregate || value(other) <= mine);
}

/**
 * One concrete sentence about what this region is, chosen by whichever fact is most extreme in the
 * set: its Indigenous majority, its distance from the capital, its dependence on one industry, the
 * share of its people in one city, or how urban it is.
 */
export function characterLine(inputs: TextInputs): DossierText {
  const { aggregate: a, set, topIndustry } = inputs;
  const capital = a.cities[0];
  const capitalShare = capital && a.population > 0 ? capital.population / a.population : 0;

  if (a.indigenousIdentity > 0.5) {
    const family = [...a.languageFamilies].sort((x, y) => y[1] - x[1])[0];
    return draft(
      `${pct(a.indigenousIdentity)} of the people here report an Indigenous identity` +
        (family ? `, and ${family[0]} is the language family of the ground they live on.` : '.'),
    );
  }
  if (capital && capitalShare > 0.45) {
    return draft(`${pct(capitalShare)} of its ${people(a.population)} people live in ${capital.name}.`);
  }
  if (topIndustry && topIndustry.share > 0.18) {
    return draft(`${pct(topIndustry.share)} of its workers are in ${topIndustry.label.toLowerCase()}.`);
  }
  if (highest(set, a, (r) => r.distanceToCapitalKm) && set.length > 1) {
    return draft(
      `Its cells sit ${Math.round(a.distanceToCapitalKm)} km from their provincial capital on average, further than any other region in the set.`,
    );
  }
  if (a.urban < 0.2 && a.population > 0) {
    return draft(`${pct(1 - a.urban)} of its ${people(a.population)} people live outside any city or town.`);
  }
  return draft(
    `${people(a.population)} people on ${people(a.areaKm2)} km²` +
      (capital ? `, ${pct(capitalShare)} of them in ${capital.name}.` : '.'),
  );
}

/** Population, area and the two ends of the region, in one sentence. */
export function oneSentence(inputs: TextInputs): DossierText {
  const { aggregate: a, name, borders } = inputs;
  const cities = a.cities.slice(0, 2).map((c) => c.name);
  const edge = borders.find((line) => !line.includes('open country'));
  return draft(
    `${name}: ${people(a.population)} people on ${people(a.areaKm2)} km²` +
      (cities.length ? `, from ${cities[0]}${cities[1] ? ` to ${cities[1]}` : ''}` : '') +
      (edge ? `, bounded on the ${edge.replace(/ \(about .*$/, '')}.` : '.'),
  );
}

/** What would kill it: the measured dependency, not a guess. */
export function whatWouldKillIt(inputs: TextInputs): DossierText {
  const { aggregate: a, topIndustry } = inputs;
  const capital = a.cities[0];
  const capitalShare = capital && a.population > 0 ? capital.population / a.population : 0;
  const growth = a.population2016 > 0 ? (a.population - a.population2016) / a.population2016 : 0;
  if (topIndustry && topIndustry.share > 0.2) {
    return draft(
      `A downturn in ${topIndustry.label.toLowerCase()}, which employs ${pct(topIndustry.share)} of its workers.`,
    );
  }
  if (capitalShare > 0.5) {
    return draft(`Anything that empties ${capital.name}, where ${pct(capitalShare)} of its people live.`);
  }
  if (growth < 0) {
    return draft(`The decline it is already in: ${pct(Math.abs(growth))} fewer people than in 2016.`);
  }
  return draft(
    `Losing the ${pct(a.urban)} of its people who live in towns, leaving ${people(a.population * (1 - a.urban))} spread over ${people(a.areaKm2)} km².`,
  );
}

/** What would save it: the measured strength. */
export function whatWouldSaveIt(inputs: TextInputs): DossierText {
  const { aggregate: a, topIndustry } = inputs;
  const growth = a.population2016 > 0 ? (a.population - a.population2016) / a.population2016 : 0;
  const second = [...a.industries].sort((x, y) => y[1] - x[1])[1];
  if (growth > 0.05) {
    return draft(`The ${pct(growth)} it grew between 2016 and 2021, if it keeps it.`);
  }
  if (a.immigrant > 0.15) {
    return draft(`The ${pct(a.immigrant)} of its people who are immigrants, and whoever follows them.`);
  }
  if (topIndustry && second && second[1] > 0.1) {
    return draft(
      `A second leg to stand on: ${pct(second[1])} of its workers are already outside ${topIndustry.label.toLowerCase()}'s ${pct(topIndustry.share)}.`,
    );
  }
  const capital = a.cities[0];
  return draft(
    capital
      ? `${capital.name}, its largest place at ${people(capital.population)} people, growing into a city the rest of the region can use.`
      : `A town of its own: its largest place has ${people(a.cities[0]?.population ?? 0)} people.`,
  );
}

/** The most similar neighbouring region: same kind of place, next door. */
export function rivalRegion(
  aggregate: RegionAggregate,
  set: RegionAggregate[],
  names: string[],
  neighbours: Set<number>,
  self: number,
): { id: number; name: string; similarity: number } | null {
  const vector = (r: RegionAggregate) => [
    // Population on a 0-1 scale without a logarithm: engines may round Math.log10 differently.
    Math.min(1, r.population / 5_000_000),
    r.urban,
    r.indigenousIdentity,
    r.french,
    r.internalColonyIndex,
    r.industries.get('21') ?? 0,
    r.industries.get('11') ?? 0,
  ];
  const mine = vector(aggregate);
  let best: { id: number; name: string; similarity: number } | null = null;
  for (const id of neighbours) {
    if (id === self || !set[id]) continue;
    const other = vector(set[id]);
    let sum = 0;
    for (let i = 0; i < mine.length; i++) sum += (mine[i] - other[i]) * (mine[i] - other[i]);
    const similarity = 1 / (1 + Math.sqrt(sum));
    if (!best || similarity > best.similarity || (similarity === best.similarity && id < best.id)) {
      best = { id, name: names[id] ?? `Region ${id + 1}`, similarity: Math.round(similarity * 1000) / 1000 };
    }
  }
  return best;
}
