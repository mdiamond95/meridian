import { LayersMenu } from './components/LayersMenu';
import { MapView } from './components/MapView';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';

export function App() {
  return (
    <div className="app">
      <MapView />
      <LayersMenu />
      <SidePanel />
      <Timeline />
    </div>
  );
}
