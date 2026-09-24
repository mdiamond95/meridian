import { create } from 'zustand';

/** Shell chrome state only. Data and split state get their own stores in later phases. */
export type PanelTab = 'details' | 'scenario' | 'generate' | 'dossier' | 'set' | 'compare' | 'files';

interface UiState {
  panelOpen: boolean;
  panelTab: PanelTab;
  setPanelTab: (tab: PanelTab) => void;
  layersOpen: boolean;
  togglePanel: () => void;
  toggleLayers: () => void;
  openPanel: () => void;
  /** Non-geographic overlays switched on, by id (src/overlays/overlays.ts). */
  overlays: Record<string, boolean>;
  toggleOverlay: (id: string) => void;
  /** The Licences and sources dialog (plan Phase 7 §5). */
  licencesOpen: boolean;
  setLicencesOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  panelOpen: true,
  panelTab: 'details',
  setPanelTab: (panelTab) => set({ panelTab, panelOpen: true }),
  layersOpen: false,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  toggleLayers: () => set((s) => ({ layersOpen: !s.layersOpen })),
  openPanel: () => set({ panelOpen: true }),
  overlays: {},
  toggleOverlay: (id) => set((s) => ({ overlays: { ...s.overlays, [id]: !s.overlays[id] } })),
  licencesOpen: false,
  setLicencesOpen: (licencesOpen) => set({ licencesOpen }),
}));
