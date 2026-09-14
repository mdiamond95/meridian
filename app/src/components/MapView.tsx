import { useEffect, useRef } from 'react';
import L from 'leaflet';

/** Canada's extent, south-west to north-east, including Ellesmere and Cape Spear. */
const CANADA_BOUNDS: L.LatLngBoundsExpression = [
  [41.6, -141.1],
  [83.2, -52.6],
];

// CARTO watermarks keyless Positron tiles; the free key is public by design and injected at build time.
const CARTO_KEY = import.meta.env.VITE_CARTO_KEY;
const POSITRON_URL =
  'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' + (CARTO_KEY ? `?key=${CARTO_KEY}` : '');
const POSITRON_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

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
    L.tileLayer(POSITRON_URL, {
      attribution: POSITRON_ATTRIBUTION,
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(map);
    map.fitBounds(CANADA_BOUNDS, chromePadding());
    return () => {
      map.remove();
    };
  }, []);

  return <div ref={containerRef} className="map" data-testid="map" />;
}
