/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Free CARTO basemaps key (carto.com/basemaps/apikey). Optional; tiles are watermarked without it. */
  readonly VITE_CARTO_KEY?: string;
}
