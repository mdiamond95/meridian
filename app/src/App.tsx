import { useEffect } from 'react';
import { ATLAS_TOPOLOGY_URL, ATLAS_URL } from './atlas/assets';
import { loadAtlas } from './atlas/loadAtlas';
import { LayersMenu } from './components/LayersMenu';
import { LicencesDialog } from './components/LicencesDialog';
import { MapView } from './components/MapView';
import { PreContactBase } from './components/PreContactBase';
import { ScenarioBadge } from './components/ScenarioBadge';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';
import { loadPreset, runCurrentSpec } from './splitter/controller';
import { decodeHash } from './splitter/url';
import { useAtlasStore } from './state/atlasStore';
import { useSplitStore } from './state/splitStore';
import { useUiStore } from './state/uiStore';

export function App() {
  useEffect(() => {
    const { setLoading, setLoaded, setError } = useAtlasStore.getState();
    let cancelled = false;
    setLoading();
    loadAtlas(ATLAS_URL, ATLAS_TOPOLOGY_URL)
      .then((data) => !cancelled && setLoaded(data))
      .catch((err: unknown) => {
        console.error(err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A share link: #split=… reruns the split, #pack=… loads a preset (src/splitter/url.ts).
  // Also on hashchange, so a link pasted into an open tab works. The app's own history.replaceState
  // does not fire hashchange, so a finished run does not rerun itself.
  useEffect(() => {
    const follow = () => {
      if (location.hash === '#licences') {
        useUiStore.getState().setLicencesOpen(true);
        return;
      }
      const state = decodeHash(location.hash);
      if (state.kind === 'none') return;
      useUiStore.getState().setPanelTab('generate');
      if (state.kind === 'split') {
        useSplitStore.getState().replaceSpec(state.spec);
        void runCurrentSpec();
      } else {
        void loadPreset(state.id);
      }
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, []);

  return (
    <div className="app">
      <MapView />
      <LayersMenu />
      <PreContactBase />
      <ScenarioBadge />
      <SidePanel />
      <Timeline />
      <LicencesDialog />
    </div>
  );
}
