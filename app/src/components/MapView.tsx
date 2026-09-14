import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { CARTO_MISSING_WARNING, selectBasemap } from '../map/basemap';

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
    ? { paddingTopLeft: [16, 60], paddingBottomRight: [16, 130] }
    : { paddingTopLeft: [60, 16], paddingBottomRight: [396, 90] };
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { zoomSnap: 0.25, worldCopyJump: true });
    L.tileLayer(BASEMAP.url, BASEMAP.options).addTo(map);
    map.fitBounds(CANADA_BOUNDS, chromePadding());
    return () => {
      map.remove();
    };
  }, []);

  return <div ref={containerRef} className="map" data-testid="map" data-basemap={BASEMAP.provider} />;
}
