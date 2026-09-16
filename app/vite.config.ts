/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Native Land permission gate, read from the pipeline's own plan so there is one source of
 * truth. Until it says `granted`, nothing of theirs is fetched or shipped and the pre-contact base
 * says so. Regex rather than a YAML dependency: it is one scalar on one line.
 */
function nativeLandPermission(): string {
  const plan = readFileSync(fileURLToPath(new URL('../pipeline/artefacts.yaml', import.meta.url)), 'utf8');
  return /^\s*native_land_permission:\s*(\w+)/m.exec(plan)?.[1] ?? 'pending';
}

export default defineConfig({
  // Relative base so the same build serves from / locally and /meridian/ on Pages.
  base: './',
  // Expose CARTO_BASEMAPS_KEY (same name as the repo variable) to import.meta.env.
  envPrefix: ['VITE_', 'CARTO_BASEMAPS_KEY'],
  define: { __NATIVE_LAND_PERMISSION__: JSON.stringify(nativeLandPermission()) },
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
