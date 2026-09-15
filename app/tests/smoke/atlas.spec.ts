import { expect, test } from '@playwright/test';

test('atlas loads and resolves the timeline to units', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('./');

  // 1867 on load: the four original provinces and the lands around them.
  const units = page.locator('.leaflet-overlay-pane path');
  await expect(units.first()).toBeAttached();
  await expect(page.getByTestId('timeline-year')).toHaveText('1867');
  await expect(page.getByTestId('timeline-event')).toContainText('Confederation');
  await expect(page.getByTestId('event-panel')).toContainText('Confederation');
  const count1867 = await units.count();
  expect(count1867).toBeGreaterThanOrEqual(9);
  await page.screenshot({ path: testInfo.outputPath('atlas-1867.png') });

  // An event tick jumps to its exact date: Nunavut on 1 April 1999.
  await page.getByRole('button', { name: '1 Apr 1999: Nunavut' }).click();
  await expect(page.getByTestId('timeline-year')).toHaveText('1999');
  await expect(page.getByTestId('timeline-event')).toContainText('Nunavut');
  await expect(units).toHaveCount(13);
  await page.screenshot({ path: testInfo.outputPath('atlas-1999.png') });

  // The slider moves by year from the keyboard.
  const slider = page.getByRole('slider', { name: 'Year' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('timeline-year')).toHaveText('1867');
  expect(errors).toEqual([]);
});

test('clicking a unit opens its details', async ({ page }) => {
  await page.goto('./');
  const unit = page.locator('.leaflet-overlay-pane path.leaflet-interactive').first();
  await expect(unit).toBeAttached();
  // A multipolygon's bounding-box centre can be open water, so dispatch the click on the path itself.
  await unit.dispatchEvent('click');
  const panel = page.getByTestId('unit-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading')).not.toBeEmpty();
  await expect(panel).toContainText('Sovereign');
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('event-panel')).toBeVisible();
});

test('NRCan drawing overlay is off by default and shows where the atlas departs from it', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page.locator('.leaflet-overlay-pane path').first()).toBeAttached();
  // Ticks for 1867 and 1870 sit a few pixels apart, so dispatch the click rather than aim the pointer.
  await page
    .getByRole('button', { name: '15 Jul 1870: Manitoba and the North-West Territories' })
    .dispatchEvent('click');
  await expect(page.getByTestId('timeline-year')).toHaveText('1870');
  const dashed = page.locator('.leaflet-overlay-pane path[stroke-dasharray="2 5"]');
  await expect(dashed).toHaveCount(0);

  await page.getByRole('button', { name: 'Layers' }).click();
  await page.getByLabel('NRCan drawing').check();
  await expect(dashed).toHaveCount(1); // Manitoba's box as NRCan drafts it
  await expect(page.locator('.leaflet-control-attribution')).toContainText('Open Government Licence');

  await page.getByLabel('NRCan drawing').uncheck();
  await expect(dashed).toHaveCount(0);
});
