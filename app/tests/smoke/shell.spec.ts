import { expect, test, type Page } from '@playwright/test';

async function sizes(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error(`${selector} has no layout box`);
  return { box, viewport };
}

test('built site renders the map shell', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('./');

  await expect(page.locator('.leaflet-container')).toBeVisible();
  const { box, viewport } = await sizes(page, '.leaflet-container');
  expect(box.width).toBe(viewport.width);
  expect(box.height).toBe(viewport.height);

  await expect(page.locator('.leaflet-tile-pane')).toBeAttached();
  await expect(page.getByTestId('panel')).toBeVisible();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Layers' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('panel sits right on desktop and collapses to a sheet on iPad', async ({ page }, testInfo) => {
  await page.goto('./');
  await expect(page.getByTestId('panel')).toBeVisible();
  const { box, viewport } = await sizes(page, '[data-testid="panel"]');

  if (testInfo.project.name === 'ipad') {
    expect(box.x).toBe(0);
    expect(box.width).toBe(viewport.width);
  } else {
    expect(box.x + box.width).toBeGreaterThan(viewport.width - 20);
    expect(box.width).toBeLessThan(viewport.width / 2);
  }
});
