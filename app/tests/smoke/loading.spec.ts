import { expect, test } from '@playwright/test';

/**
 * Loading (plan Phase 7 §1): the first view fetches only the atlas; the splitter's artefacts wait for
 * the Generate panel, and a second open reads the decoded mesh and attributes from IndexedDB.
 */

test.describe.configure({ timeout: 120_000 });

const LAZY = /(mesh|attrs|cells|places|snap|contact|indigenous)\.v\d/;

test('the first view fetches the atlas and nothing the splitter or other layers need', async ({ page }) => {
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(r.url()));
  await page.goto('./');
  await expect(page.locator('.leaflet-overlay-pane path').first()).toBeAttached();
  await expect(page.getByTestId('map')).toHaveAttribute('data-atlas-warm', 'true');
  expect(fetched.filter((u) => /atlas\.v1/.test(u))).toHaveLength(2);
  expect(fetched.filter((u) => LAZY.test(u))).toEqual([]);

  await page.getByTestId('generate-tab').click();
  await expect(page.getByTestId('generate')).toBeVisible({ timeout: 60_000 });
  // Five artefacts. The worker asks for the same five after the page has them (1.0.1), which the
  // browser's cache (or on Pages the service worker) answers: distinct URLs, not downloads, are five.
  await expect.poll(() => new Set(fetched.filter((u) => LAZY.test(u))).size).toBe(5);
});

test('the second open of the splitter reads the decoded data from IndexedDB', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('generate-tab').click();
  await expect(page.getByTestId('generate')).toHaveAttribute('data-source', /network|cache/, {
    timeout: 60_000,
  });
  // The cache is written in the background after the first decode.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const req = indexedDB.open('meridian-decoded');
            req.onsuccess = () => {
              const store = req.result.transaction('decoded').objectStore('decoded');
              const count = store.count();
              count.onsuccess = () => resolve(count.result);
            };
            req.onerror = () => resolve(-1);
          }),
      ),
    )
    .toBe(1);
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(r.url()));
  await page.reload();
  await page.getByTestId('generate-tab').click();
  await expect(page.getByTestId('generate')).toHaveAttribute('data-source', 'cache', { timeout: 60_000 });
  expect(fetched.filter((u) => /(mesh|attrs|places|snap)\.v1/.test(u))).toEqual([]);
});
