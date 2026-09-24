/// <reference types="vitest/config" />
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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

/**
 * The service worker (src/offline/sw.js, plan Phase 7 §2), written into the build once everything
 * else is: its precache list is every file in dist (the page, code, data artefacts, packs and the
 * public folder), and its version is a hash of their bytes, so each build gets a fresh cache.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  const source = fileURLToPath(new URL('./src/offline/sw.js', import.meta.url));
  return {
    name: 'meridian-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir.startsWith('/')
        ? config.build.outDir
        : join(config.root, config.build.outDir);
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path);
          else if (name !== 'sw.js') files.push(relative(outDir, path).split('\\').join('/'));
        }
      };
      walk(outDir);
      const hash = createHash('sha256');
      for (const file of files) hash.update(file).update(readFileSync(join(outDir, file)));
      const header =
        `const VERSION = ${JSON.stringify(hash.digest('hex').slice(0, 12))};\n` +
        `const PRECACHE = ${JSON.stringify(['./', ...files.map((f) => `./${f}`)])};\n`;
      writeFileSync(join(outDir, 'sw.js'), header + readFileSync(source, 'utf8'));
    },
  };
}

export default defineConfig({
  // Relative base so the same build serves from / locally and /meridian/ on Pages.
  base: './',
  // Expose CARTO_BASEMAPS_KEY (same name as the repo variable) to import.meta.env.
  envPrefix: ['VITE_', 'CARTO_BASEMAPS_KEY'],
  plugins: [react(), sharedPacks(), serviceWorker()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
