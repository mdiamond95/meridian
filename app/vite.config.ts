/// <reference types="vitest/config" />
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The shared packs live in the repo's top-level packs/ folder (docs/interop.md), which other projects
 * fetch by raw URL. The app fetches the same files by the relative URL packs/<file>: served from that
 * folder in dev, and copied into the build.
 */
function sharedPacks(): Plugin {
  const dir = fileURLToPath(new URL('../packs/', import.meta.url));
  const files = () => readdirSync(dir).filter((f) => /^[a-z0-9.-]+\.json$/.test(f));
  return {
    name: 'meridian-shared-packs',
    configureServer(server) {
      server.middlewares.use('/packs/', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0].replace(/^\//, ''));
        if (!files().includes(name) || !existsSync(dir + name)) return next();
        res.setHeader('Content-Type', 'application/json');
        createReadStream(dir + name).pipe(res);
      });
    },
    generateBundle() {
      for (const file of files()) {
        this.emitFile({ type: 'asset', fileName: `packs/${file}`, source: readFileSync(dir + file) });
      }
    },
  };
}

export default defineConfig({
  // Relative base so the same build serves from / locally and /meridian/ on Pages.
  base: './',
  // Expose CARTO_BASEMAPS_KEY (same name as the repo variable) to import.meta.env.
  envPrefix: ['VITE_', 'CARTO_BASEMAPS_KEY'],
  plugins: [react(), sharedPacks()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
