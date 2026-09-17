import { defineConfig } from '@playwright/test';

/**
 * The cross-engine determinism gate (docs/plan.md, Phase 3). One test launches Chromium, WebKit and
 * Firefox itself so it can compare their results; it needs no dev server.
 */
export default defineConfig({
  testDir: 'tests/determinism',
  reporter: process.env.CI ? 'github' : 'list',
  forbidOnly: !!process.env.CI,
  // Serial by design: the test launches one engine, closes it, then launches the next, so only one
  // browser is ever resident (docs/perf.md).
  workers: 1,
});
