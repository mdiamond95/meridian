import type { TileLayerOptions } from 'leaflet';

export interface Basemap {
  provider: 'carto-positron' | 'osm-standard';
  url: string;
  options: TileLayerOptions;
}

const OSM_COPYRIGHT =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * CARTO Positron when a key was provided at build time, otherwise OpenStreetMap standard tiles.
 * The CARTO key is public by design (it ships in the bundle); Pages always builds with it.
 */
export function selectBasemap(cartoKey: string | undefined): Basemap {
  const key = cartoKey?.trim();
  if (key) {
    return {
      provider: 'carto-positron',
      url: `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`,
      options: {
        attribution: `${OSM_COPYRIGHT} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
        subdomains: 'abcd',
        maxZoom: 20,
      },
    };
  }
  return {
    provider: 'osm-standard',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { attribution: OSM_COPYRIGHT, maxZoom: 19 },
  };
}

export const CARTO_MISSING_WARNING =
  'Meridian: CARTO_BASEMAPS_KEY was not set at build time; using OpenStreetMap standard tiles.';
