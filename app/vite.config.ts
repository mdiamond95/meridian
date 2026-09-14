/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative base so the same build serves from / locally and /meridian/ on Pages.
  base: './',
  // Expose CARTO_BASEMAPS_KEY (same name as the repo variable) to import.meta.env.
  envPrefix: ['VITE_', 'CARTO_BASEMAPS_KEY'],
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
