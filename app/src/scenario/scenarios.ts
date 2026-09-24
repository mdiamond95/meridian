import { ScenarioSchema, type Scenario } from '../schema/scenario';
import compiled from './scenarios.json';

/** The shipped scenarios (docs/scenarios/*.yaml, compiled by `npm run scenarios`). */
export const SCENARIOS: Scenario[] = (compiled as unknown[]).map((s) => ScenarioSchema.parse(s));

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
