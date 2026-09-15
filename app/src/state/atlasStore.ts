import { create } from 'zustand';
import type { LoadedAtlas } from '../atlas/loadAtlas';
import { resolveUnits } from '../atlas/resolve';
import { TRUTH_LAYERS, type TruthLayer } from '../schema/atlas';

/** Atlas view state: the date on the timeline, visible truth layers, and the selected unit. */

export type AtlasStatus = 'idle' | 'loading' | 'ready' | 'error';

interface AtlasState {
  status: AtlasStatus;
  error: string | null;
  data: LoadedAtlas | null;
  /** ISO date the map resolves to. */
  date: string;
  visible: boolean;
  truth: Record<TruthLayer, boolean>;
  /** Unit id. The panel shows whichever row of that unit is valid on `date`. */
  selected: string | null;
  setLoading: () => void;
  setLoaded: (data: LoadedAtlas) => void;
  setError: (message: string) => void;
  setDate: (date: string) => void;
  setVisible: (visible: boolean) => void;
  toggleTruth: (layer: TruthLayer) => void;
  select: (id: string | null) => void;
}

export const INITIAL_DATE = '1867-07-01';

export const initialAtlasState = {
  status: 'idle' as AtlasStatus,
  error: null,
  data: null,
  date: INITIAL_DATE,
  visible: true,
  truth: { dejure: true, defacto: false, disputed: false },
  selected: null,
};

export function activeTruthLayers(truth: Record<TruthLayer, boolean>): TruthLayer[] {
  return TRUTH_LAYERS.filter((layer) => truth[layer]);
}

export const useAtlasStore = create<AtlasState>()((set) => ({
  ...initialAtlasState,
  setLoading: () => set({ status: 'loading', error: null }),
  setLoaded: (data) => set({ status: 'ready', data, error: null }),
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
  select: (selected) => set({ selected }),
}));
