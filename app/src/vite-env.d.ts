/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Free CARTO basemaps key (carto.com/basemaps/apikey). Absent → OpenStreetMap standard tiles. */
  readonly CARTO_BASEMAPS_KEY?: string;
}

/** pipeline/artefacts.yaml `permissions.native_land_permission`, inlined at build time. */
declare const __NATIVE_LAND_PERMISSION__: string;
