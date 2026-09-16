import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;

/**
 * Frame-time measurement (docs/perf.md), kept out of `npm run smoke` so CI stays stable: it
 * measures the machine as much as the code. Run it with `npm run frame-time`.
 */
export default defineConfig({
  testDir: 'tests/perf',
  reporter: 'list',
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'ipad',
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, hasTouch: true },
    },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
});
