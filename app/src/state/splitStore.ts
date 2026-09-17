import { create } from 'zustand';
import type { Progress } from '../engine/solver';
import type { SplitterData } from '../splitter/data';
import type { CellTopology } from '../splitter/outline';
import type { RegionDossier, SetAnalysis } from '../schema/dossier';
import type { Difference } from '../splitter/compare';
import type { Edit, Fit, PackLibrary } from '../splitter/pack';
import { defaultSpec, type NamedRegion, type PreparedSplit, type SplitSpec } from '../splitter/split';

/** Splitter state: the spec being edited, the current split, and the map tool in use. */

export type MapTool = 'none' | 'paint' | 'draw' | 'together' | 'apart';

export interface CurrentSplit {
  prepared: PreparedSplit;
  /** region id per mesh cell, -1 outside the scope */
  assignment: Int32Array;
  regions: NamedRegion[];
  colours: string[];
  edits: Edit[];
  /** where it came from: a run, or a pack from the library */
  source: { kind: 'run' } | { kind: 'pack'; id: string; fit: Fit };
  /** filled once the split is described (Phase 4); null while it is being rebuilt */
  dossiers: RegionDossier[] | null;
  setAnalysis: SetAnalysis | null;
}

export interface Comparison {
  /** what the current split is being compared with */
  id: string;
  name: string;
  assignment: Int32Array;
  names: string[];
  colours: string[];
  difference: Difference;
  /** 0-1 across the map: left of it the current split, right of it the other */
  divider: number;
}

interface SplitState {
  dataStatus: 'idle' | 'loading' | 'ready' | 'error';
  data: SplitterData | null;
  topology: CellTopology | null;
  library: PackLibrary | null;
  error: string | null;
  spec: SplitSpec;
  running: boolean;
  progress: Progress | null;
  split: CurrentSplit | null;
  /** snapshot used by a 'region' scope: the split whose region is being re-split */
  regionSource: Int32Array | null;
  tool: MapTool;
  selectedRegion: number | null;
  drawPoints: [number, number][];
  /** CSDs picked for the pin group being built */
  pinDraft: string[];
  compare: Comparison | null;
  setSpec: (patch: Partial<SplitSpec>) => void;
  replaceSpec: (spec: SplitSpec) => void;
  setTool: (tool: MapTool) => void;
  selectRegion: (id: number | null) => void;
  set: (patch: Partial<SplitState>) => void;
}

export const useSplitStore = create<SplitState>()((set) => ({
  dataStatus: 'idle',
  data: null,
  topology: null,
  library: null,
  error: null,
  spec: defaultSpec(),
  running: false,
  progress: null,
  split: null,
  regionSource: null,
  tool: 'none',
  selectedRegion: null,
  drawPoints: [],
  pinDraft: [],
  compare: null,
  setSpec: (patch) => set((s) => ({ spec: { ...s.spec, ...patch } })),
  replaceSpec: (spec) => set({ spec }),
  setTool: (tool) =>
    set((s) => ({
      tool,
      drawPoints: tool === 'draw' ? [] : s.drawPoints,
      pinDraft: tool === s.tool ? s.pinDraft : [],
    })),
  selectRegion: (selectedRegion) => set({ selectedRegion }),
  set: (patch) => set(patch),
}));
