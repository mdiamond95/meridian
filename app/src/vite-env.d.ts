/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Free CARTO basemaps key (carto.com/basemaps/apikey). Absent → OpenStreetMap standard tiles. */
  readonly CARTO_BASEMAPS_KEY?: string;
}
