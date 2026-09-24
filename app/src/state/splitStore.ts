import { create } from 'zustand';
import type { Progress } from '../engine/solver';
import type { SplitterData } from '../splitter/data';
import type { CellTopology } from '../splitter/outline';
import type { RegionDossier, SetAnalysis } from '../schema/dossier';
import type { Difference } from '../splitter/compare';
import type { RegionPack } from '../schema/regionPack';
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
  /** where it came from; decides whether a share link can reproduce it */
  source: SplitSource;
  /** filled once the split is described (Phase 4); null while it is being rebuilt */
  dossiers: RegionDossier[] | null;
  setAnalysis: SetAnalysis | null;
}

export type SplitSource =
  /** run from the spec in the Generate panel */
  | { kind: 'run' }
  /** a shipped preset */
  | { kind: 'pack'; id: string; fit: Fit }
  /** a pack file or a pack saved in this browser; `refit` when moved from another mesh version */
  | { kind: 'file'; name: string; refit: string | null }
  /** cells assigned from an imported GeoJSON or KML */
  | { kind: 'template'; name: string };

/** A pack made on another mesh, waiting for the user to choose re-fit or regenerate. */
export interface PendingImport {
  name: string;
  pack: RegionPack;
  from: string;
  to: string;
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
  /** the snap layer from an imported file (session only: it is not in any share link) */
  importedSnap: { name: string; edges: Set<number> } | null;
  pendingImport: PendingImport | null;
  /** a passing message from import, export or the library */
  notice: string | null;
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
  importedSnap: null,
  pendingImport: null,
  notice: null,
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
