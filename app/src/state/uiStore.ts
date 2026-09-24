import { create } from 'zustand';

/** Shell chrome state only. Data and split state get their own stores in later phases. */
export type PanelTab = 'details' | 'generate' | 'dossier' | 'set' | 'compare' | 'files';

interface UiState {
  panelOpen: boolean;
  panelTab: PanelTab;
  setPanelTab: (tab: PanelTab) => void;
  layersOpen: boolean;
  togglePanel: () => void;
  toggleLayers: () => void;
  openPanel: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  panelOpen: true,
  panelTab: 'details',
  setPanelTab: (panelTab) => set({ panelTab, panelOpen: true }),
  layersOpen: false,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  toggleLayers: () => set((s) => ({ layersOpen: !s.layersOpen })),
  openPanel: () => set({ panelOpen: true }),
}));
