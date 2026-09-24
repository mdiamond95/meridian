import { expect, test, type Page } from '@playwright/test';

/**
 * Offline (plan Phase 7 §2): after one visit the service worker holds the page, its code, every
 * artefact and the last view's basemap tiles, so with the network off the page loads and a pack
 * saved in this browser opens.
 */

test.use({ serviceWorkers: 'allow' });
test.describe.configure({ timeout: 180_000 });

async function controlled(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-offline', 'ready', { timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

const cachedTiles = (page: Page) =>
  page.evaluate(async () => (await (await caches.open('meridian-tiles')).keys()).map((r) => r.url));

test('the page loads and a saved pack opens with the network off', async ({ page, context }) => {
  await page.goto('./');
  await controlled(page);

  // A visit under the worker: the split's view is the last one, so its tiles are the ones kept.
  await page.goto('./#pack=alberta-15');
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(15, { timeout: 60_000 });
  await page.getByTestId('files-tab').click();
  await page.getByLabel('Name for the saved pack').fill('Alberta, offline');
  await page.getByTestId('library-save').click();
  await expect(page.getByTestId('library-list')).toContainText('Alberta, offline');
  await expect.poll(async () => (await cachedTiles(page)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  // The tile cache is the last view and nothing more: every cached tile is one the map shows now.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const shown = new Set(
            [
              ...document.querySelectorAll<HTMLImageElement>('.leaflet-tile-pane img.leaflet-tile-loaded'),
            ].map((i) => i.src),
          );
          const cached = (await (await caches.open('meridian-tiles')).keys()).map((r) => r.url);
          return cached.filter((url) => !shown.has(url));
        }),
      { timeout: 30_000 },
    )
    .toEqual([]);

  await context.setOffline(true);
  await page.goto('./');
  await expect(page.getByTestId('timeline-year')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.leaflet-overlay-pane path').first()).toBeAttached();

  await page.getByTestId('files-tab').click();
  const list = page.getByTestId('library-list');
  await expect(list).toContainText('Alberta, offline', { timeout: 60_000 });
  await list.getByRole('button', { name: 'Load' }).first().click();
  await page.getByTestId('generate-tab').click();
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(15, { timeout: 60_000 });
  // The split fits the map to Alberta again, the last viewed extent: its tiles come from the cache.
  await expect
    .poll(() => page.locator('.leaflet-tile-pane img.leaflet-tile-loaded').count(), { timeout: 30_000 })
    .toBeGreaterThan(0);

  await context.setOffline(false);
  await page.getByTestId('files-tab').click();
  await list.getByRole('button', { name: 'Delete Alberta, offline' }).first().click();
});
