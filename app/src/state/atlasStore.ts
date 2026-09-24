import { create } from 'zustand';
import type { LoadedAtlas } from '../atlas/loadAtlas';
import type { LoadedContact } from '../atlas/loadContact';
import type { LoadedIndigenous } from '../atlas/loadIndigenous';
import { resolveUnits } from '../atlas/resolve';
import { applyScenario, type ScenarioAtlas } from '../scenario/apply';
import { TRUTH_LAYERS, type TruthLayer } from '../schema/atlas';
import type { Scenario } from '../schema/scenario';

/** Atlas view state: the date on the timeline, visible truth layers, and the selected unit. */

export type AtlasStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Where the timeline begins (plan Phase 2 Sitting C). 1000 is the Norse at L'Anse aux Meadows and
 * 1497 is Cabot; "frontier" starts at 1000 as well but shades each area until contact reached it,
 * so the map answers "reached by whom, and when" instead of implying one date for the country.
 */
export const START_OPTIONS = [1000, 1497, 'frontier'] as const;
export type StartOption = (typeof START_OPTIONS)[number];

export function startYear(start: StartOption): number {
  return start === 'frontier' ? 1000 : start;
}

interface AtlasState {
  status: AtlasStatus;
  error: string | null;
  /** The atlas the map shows: the base, or the active scenario's replay of it. */
  data: LoadedAtlas | null;
  /** The base atlas as built by the pipeline; the diff compares `data` with it. */
  base: LoadedAtlas | null;
  /** The active scenario (plan Phase 6 §1), or null for the base atlas. */
  scenario: ScenarioAtlas | null;
  /** Draw the base atlas's units the scenario changes, as dashed outlines. */
  baseOutlines: boolean;
  /** ISO date the map resolves to. */
  date: string;
  visible: boolean;
  truth: Record<TruthLayer, boolean>;
  /** NRCan's drawing, shown only where the atlas departs from it. */
  nrcanVisible: boolean;
  /** The contact frontier choropleth. Its data is fetched the first time it is asked for. */
  contactVisible: boolean;
  contact: LoadedContact | null;
  contactError: string | null;
  /** Where the timeline starts, and whether the pre-contact base shades by contact date. */
  start: StartOption;
  /**
   * Indigenous language families and community names. Drawn automatically before the atlas begins
   * (the pre-contact base); these switch them on at any date. Data fetched on first use.
   */
  familiesVisible: boolean;
  communitiesVisible: boolean;
  indigenous: LoadedIndigenous | null;
  indigenousError: string | null;
  /** Unit id. The panel shows whichever row of that unit is valid on `date`. */
  selected: string | null;
  setLoading: () => void;
  setLoaded: (data: LoadedAtlas) => void;
  /** Activate a scenario (or null for the base). Throws when the scenario cannot apply. */
  setScenario: (scenario: Scenario | null) => void;
  toggleBaseOutlines: () => void;
  setError: (message: string) => void;
  setDate: (date: string) => void;
  setVisible: (visible: boolean) => void;
  toggleTruth: (layer: TruthLayer) => void;
  toggleNrcan: () => void;
  toggleContact: () => void;
  setContact: (contact: LoadedContact) => void;
  setContactError: (message: string) => void;
  setStart: (start: StartOption) => void;
  toggleFamilies: () => void;
  toggleCommunities: () => void;
  setIndigenous: (indigenous: LoadedIndigenous) => void;
  setIndigenousError: (message: string) => void;
  select: (id: string | null) => void;
}

export const INITIAL_DATE = '1867-07-01';

export const initialAtlasState = {
  status: 'idle' as AtlasStatus,
  error: null,
  data: null,
  base: null,
  scenario: null,
  baseOutlines: true,
  date: INITIAL_DATE,
  visible: true,
  truth: { dejure: true, defacto: false, disputed: false },
  nrcanVisible: false,
  contactVisible: false,
  contact: null,
  contactError: null,
  start: 1497 as StartOption,
  familiesVisible: false,
  communitiesVisible: false,
  indigenous: null,
  indigenousError: null,
  selected: null,
};

export function activeTruthLayers(truth: Record<TruthLayer, boolean>): TruthLayer[] {
  return TRUTH_LAYERS.filter((layer) => truth[layer]);
}

export const useAtlasStore = create<AtlasState>()((set) => ({
  ...initialAtlasState,
  setLoading: () => set({ status: 'loading', error: null }),
  setLoaded: (base) =>
    set((s) => {
      const scenario = s.scenario ? applyScenario(base, s.scenario.scenario) : null;
      return { status: 'ready', base, scenario, data: scenario?.loaded ?? base, error: null };
    }),
  setScenario: (chosen) =>
    set((s) => {
      if (!s.base) return {};
      const scenario = chosen ? applyScenario(s.base, chosen) : null;
      const data = scenario?.loaded ?? s.base;
      const exists =
        s.selected && resolveUnits(data.atlas, s.date, TRUTH_LAYERS).some((u) => u.id === s.selected);
      return { scenario, data, selected: exists ? s.selected : null };
    }),
  toggleBaseOutlines: () => set((s) => ({ baseOutlines: !s.baseOutlines })),
  setError: (message) => set({ status: 'error', error: message }),
  // Keep the selection while the unit exists (Manitoba stays selected as it grows); drop it once
  // the unit is dissolved or not yet created at the new date.
  setDate: (date) =>
    set((s) => {
      if (!s.selected || !s.data) return { date };
      const exists = resolveUnits(s.data.atlas, date, TRUTH_LAYERS).some((u) => u.id === s.selected);
      return { date, selected: exists ? s.selected : null };
    }),
  setVisible: (visible) => set((s) => ({ visible, selected: visible ? s.selected : null })),
  toggleTruth: (layer) => set((s) => ({ truth: { ...s.truth, [layer]: !s.truth[layer] } })),
  toggleNrcan: () => set((s) => ({ nrcanVisible: !s.nrcanVisible })),
  toggleContact: () => set((s) => ({ contactVisible: !s.contactVisible })),
  setContact: (contact) => set({ contact, contactError: null }),
  setContactError: (message) => set({ contactError: message }),
  setStart: (start) => set({ start }),
  toggleFamilies: () => set((s) => ({ familiesVisible: !s.familiesVisible })),
  toggleCommunities: () => set((s) => ({ communitiesVisible: !s.communitiesVisible })),
  setIndigenous: (indigenous) => set({ indigenous, indigenousError: null }),
  setIndigenousError: (message) => set({ indigenousError: message }),
  select: (selected) => set({ selected }),
}));
