import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * The Files tab (plan Phase 5): every export downloads, exports come back in as the same split, packs
 * are kept in this browser, and the page works when browser storage is unavailable.
 */

test.describe.configure({ timeout: 120_000 });

async function openFilesWithPreset(page: Page, id = 'alberta-15', regions = 15) {
  await page.goto(`./#pack=${id}`);
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(regions, { timeout: 60_000 });
  await page.getByTestId('files-tab').click();
  await expect(page.getByTestId('files')).toBeVisible();
  // The Markdown export waits for the dossiers, which are written after the map is drawn.
  await expect(page.getByTestId('export-markdown')).toBeEnabled({ timeout: 30_000 });
}

async function download(page: Page, format: string) {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(`export-${format}`).click(),
  ]);
  const path = await file.path();
  return { name: file.suggestedFilename(), bytes: readFileSync(path) };
}

async function legendNames(page: Page) {
  await page.getByTestId('generate-tab').click();
  const names = await page.getByTestId('split-legend').locator('.legend-name').allTextContents();
  await page.getByTestId('files-tab').click();
  return names;
}

test('every format downloads, and GeoJSON, KML and the pack come back in as the same split', async ({
  page,
}) => {
  await openFilesWithPreset(page);
  const names = await legendNames(page);

  const geojson = await download(page, 'geojson');
  expect(geojson.name).toMatch(/\.geojson$/);
  const collection = JSON.parse(geojson.bytes.toString('utf8')) as { features: unknown[] };
  expect(collection.features).toHaveLength(15);

  const topojson = await download(page, 'topojson');
  expect(JSON.parse(topojson.bytes.toString('utf8')).type).toBe('Topology');

  const kml = await download(page, 'kml');
  expect(kml.bytes.toString('utf8')).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');

  const svg = await download(page, 'svg');
  expect(svg.bytes.toString('utf8')).toContain('id="scale-bar"');

  const png = await download(page, 'png');
  expect([...png.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(png.bytes.length).toBeGreaterThan(10_000);

  const markdown = await download(page, 'markdown');
  expect(markdown.bytes.toString('utf8')).toContain('⟨draft⟩');

  const pack = await download(page, 'pack');
  expect(JSON.parse(pack.bytes.toString('utf8')).format).toBe('meridian.regionPack');

  // Back in: each file replaces the split with the same regions under the same names.
  for (const [file, mimeType] of [
    [geojson, 'application/geo+json'],
    [kml, 'application/vnd.google-earth.kml+xml'],
    [pack, 'application/json'],
  ] as const) {
    await page.getByTestId('import-file').setInputFiles({ name: file.name, mimeType, buffer: file.bytes });
    await expect(page.getByTestId('files-notice')).toContainText(file.name);
    expect(await legendNames(page)).toEqual(names);
  }
  // A split from an imported map has no recipe, so no share link.
  await page.getByTestId('import-file').setInputFiles({
    name: geojson.name,
    mimeType: 'application/geo+json',
    buffer: geojson.bytes,
  });
  await expect(page.getByTestId('share-link')).toBeDisabled();
  await expect(page.getByTestId('share-hint')).toContainText('imported map');
});

test('a pack saved in this browser survives a reload', async ({ page }) => {
  await openFilesWithPreset(page, 'canada-14', 14);
  await page.getByLabel('Name for the saved pack').fill('Capitals, saved');
  await page.getByTestId('library-save').click();
  const list = page.getByTestId('library-list');
  await expect(list).toContainText('Capitals, saved');

  await page.goto('./');
  await page.getByTestId('files-tab').click();
  await expect(list).toContainText('Capitals, saved');
  await list.getByRole('button', { name: 'Load' }).first().click();
  await expect(page.getByTestId('files-notice')).toContainText('Capitals, saved');
  await page.getByTestId('generate-tab').click();
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(14);
  await page.getByTestId('files-tab').click();
  await list.getByRole('button', { name: 'Delete Capitals, saved' }).first().click();
});

test('with browser storage unavailable the page still splits and exports', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await openFilesWithPreset(page);
  await expect(page.getByTestId('library-unavailable')).toBeVisible();
  const geojson = await download(page, 'geojson');
  expect(JSON.parse(geojson.bytes.toString('utf8')).features).toHaveLength(15);
  expect(errors).toEqual([]);
});
