import { create } from 'zustand';
import type { Progress } from '../engine/solver';
import type { SplitterData } from '../splitter/data';
import type { CellTopology } from '../splitter/outline';
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
