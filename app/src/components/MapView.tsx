import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { reportTiles, visibleTileUrls } from '../offline/register';
import { CARTO_MISSING_WARNING, selectBasemap } from '../map/basemap';
import { installPatterns } from '../map/patterns';
import { AtlasLayer } from './AtlasLayer';
import { BaseOutlineLayer } from './BaseOutlineLayer';
import { CompareDivider } from './CompareDivider';
import { ContactLayer } from './ContactLayer';
import { IndigenousLayer } from './IndigenousLayer';
import { OverlayLayer } from './OverlayLayer';
import { ReferenceLayer } from './ReferenceLayer';
import { SplitLayer } from './SplitLayer';

/** Canada's extent, south-west to north-east, including Ellesmere and Cape Spear. */
const CANADA_BOUNDS: L.LatLngBoundsExpression = [
  [41.6, -141.1],
  [83.2, -52.6],
];

const BASEMAP = selectBasemap(import.meta.env.CARTO_BASEMAPS_KEY);
if (BASEMAP.provider === 'osm-standard') console.warn(CARTO_MISSING_WARNING);

/** Keep Canada clear of the floating chrome: right panel on wide screens, sheets below on iPad. */
function chromePadding(): L.FitBoundsOptions {
  return window.matchMedia('(max-width: 1024px)').matches
    ? { paddingTopLeft: [16, 60], paddingBottomRight: [16, 150] }
    : { paddingTopLeft: [60, 16], paddingBottomRight: [396, 110] };
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const instance = L.map(containerRef.current, { zoomSnap: 0.25, worldCopyJump: true });
    // CORS tiles, so the service worker stores ordinary responses rather than opaque ones (both
    // providers send Access-Control-Allow-Origin: *); once a view's tiles have all loaded, the worker
    // is told which they are, and keeps only those for offline use.
    const tiles = L.tileLayer(BASEMAP.url, { ...BASEMAP.options, crossOrigin: 'anonymous' }).addTo(instance);
    tiles.on('load', () =>
      reportTiles(
        visibleTileUrls(instance.getPane('tilePane') as HTMLElement, Math.round(instance.getZoom())),
      ),
    );
    instance.fitBounds(CANADA_BOUNDS, chromePadding());
    const removePatterns = installPatterns(instance);
    setMap(instance);
    return () => {
      setMap(null);
      removePatterns();
      instance.remove();
    };
  }, []);

  return (
    <div ref={containerRef} className="map" data-testid="map" data-basemap={BASEMAP.provider}>
      {map && <IndigenousLayer map={map} />}
      {map && <ContactLayer map={map} />}
      {map && <AtlasLayer map={map} />}
      {map && <ReferenceLayer map={map} />}
      {map && <BaseOutlineLayer map={map} />}
      {map && <SplitLayer map={map} />}
      {map && <OverlayLayer map={map} />}
      <CompareDivider />
    </div>
  );
}
