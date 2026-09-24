/**
 * Offline support (plan Phase 7 §2): register the service worker the build writes (src/offline/sw.js)
 * and tell it which basemap tiles the last settled view showed, so it keeps those and drops the rest.
 * Only in a production build: in dev, Vite serves unfingerprinted modules a cache would pin.
 */

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const root = document.documentElement;
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      // Installed means every artefact is cached: from now on the page opens with the network off.
      root.dataset.offline = 'ready';
    })
    .catch((err: unknown) => {
      root.dataset.offline = 'unavailable';
      console.warn('Meridian: offline support is off:', err);
    });
}

/**
 * The tiles a tile pane shows at zoom `z`, as absolute URLs. Leaflet keeps the previous level's
 * tiles in the pane for a moment after a zoom, so tiles of other levels are left out.
 */
export function visibleTileUrls(tilePane: HTMLElement, z: number): string[] {
  const level = new RegExp(`/${z}/\\d+/\\d+(@2x)?\\.png`);
  return [...tilePane.querySelectorAll<HTMLImageElement>('img.leaflet-tile-loaded')]
    .map((img) => img.src)
    .filter((src) => level.test(new URL(src).pathname));
}

/** Send the worker the last view's tiles; it prunes its tile cache to exactly these. */
export function reportTiles(urls: string[]): void {
  if (!('serviceWorker' in navigator) || urls.length === 0) return;
  navigator.serviceWorker.controller?.postMessage({ type: 'tiles', urls });
}
