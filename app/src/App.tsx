import { useEffect } from 'react';
import { ATLAS_TOPOLOGY_URL, ATLAS_URL } from './atlas/assets';
import { loadAtlas } from './atlas/loadAtlas';
import { LayersMenu } from './components/LayersMenu';
import { MapView } from './components/MapView';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';
import { useAtlasStore } from './state/atlasStore';

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

  return (
    <div className="app">
      <MapView />
      <LayersMenu />
      <SidePanel />
      <Timeline />
    </div>
  );
}
