import { create } from 'zustand';

/** Shell chrome state only. Data and split state get their own stores in later phases. */
interface UiState {
  panelOpen: boolean;
  layersOpen: boolean;
  togglePanel: () => void;
  toggleLayers: () => void;
  openPanel: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  panelOpen: true,
  layersOpen: false,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  toggleLayers: () => set((s) => ({ layersOpen: !s.layersOpen })),
  openPanel: () => set({ panelOpen: true }),
}));
