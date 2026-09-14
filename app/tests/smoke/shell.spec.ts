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

test('basemap matches the build-time key: CARTO with a key, OpenStreetMap without', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });
  await page.goto('./');

  const withKey = Boolean(process.env.CARTO_BASEMAPS_KEY?.trim());
  const tile = page.locator('.leaflet-tile-pane img').first();
  await expect(tile).toBeAttached();
  const src = (await tile.getAttribute('src')) ?? '';
  const attribution = page.locator('.leaflet-control-attribution');

  await expect(page.getByTestId('map')).toHaveAttribute(
    'data-basemap',
    withKey ? 'carto-positron' : 'osm-standard',
  );
  await expect(attribution).toContainText('OpenStreetMap');
  if (withKey) {
    expect(new URL(src).hostname).toMatch(/basemaps\.cartocdn\.com$/);
    await expect(attribution).toContainText('CARTO');
    expect(warnings.filter((w) => w.includes('CARTO_BASEMAPS_KEY'))).toEqual([]);
  } else {
    expect(new URL(src).hostname).toBe('tile.openstreetmap.org');
    expect(warnings.some((w) => w.includes('CARTO_BASEMAPS_KEY was not set'))).toBe(true);
  }
});
