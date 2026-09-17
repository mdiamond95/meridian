import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests/smoke',
  forbidOnly: !!process.env.CI,
  // One browser at a time: the Codespace has 8 GB and terminates processes below about 1 GB free
  // (docs/perf.md). Projects run one after another too.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // iPad viewport in Chromium: checks the sheet layout without a WebKit download in CI.
    {
      name: 'ipad',
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, hasTouch: true },
    },
  ],
  // Smoke tests the built site: `npm run build` must run first.
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
  },
});
