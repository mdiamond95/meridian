import { expect, test } from '@playwright/test';

test('atlas loads and resolves the timeline to units', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('./');

  // 1867 on load: the four original provinces and the lands around them.
  // Shown paths only: the neighbouring event windows' units are kept on the map with display: none
  // (AtlasLayer's lookahead, docs/perf.md).
  const units = page.locator('.leaflet-overlay-pane path:not([style*="display: none"])');
  await expect(units.first()).toBeAttached();
  await expect(page.getByTestId('timeline-year')).toHaveText('1867');
  await expect(page.getByTestId('timeline-event')).toContainText('Confederation');
  await expect(page.getByTestId('event-panel')).toContainText('Confederation');
  const count1867 = await units.count();
  expect(count1867).toBeGreaterThanOrEqual(9);
  await page.screenshot({ path: testInfo.outputPath('atlas-1867.png') });

  // An event tick jumps to its exact date: Nunavut on 1 April 1999. With 50 events the ticks
  // overlap, so dispatch the click rather than aim the pointer.
  await page.getByRole('button', { name: '1 Apr 1999: Nunavut' }).dispatchEvent('click');
  await expect(page.getByTestId('timeline-year')).toHaveText('1999');
  await expect(page.getByTestId('timeline-event')).toContainText('Nunavut');
  await expect(units).toHaveCount(13);
  await page.screenshot({ path: testInfo.outputPath('atlas-1999.png') });

  // The slider moves by year from the keyboard. Home is the timeline's first year, which is the
  // start selector's, not the atlas's: 1497 by default, before the first event of 1670.
  const slider = page.getByRole('slider', { name: 'Year' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('timeline-year')).toHaveText('1497');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('timeline-year')).toHaveText('1498');
  await expect(page.getByTestId('timeline-event')).toContainText('Before the first event');
  expect(errors).toEqual([]);
});

test('clicking a unit opens its details', async ({ page }) => {
  await page.goto('./');
  const unit = page
    .locator('.leaflet-overlay-pane path.leaflet-interactive:not([style*="display: none"])')
    .first();
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

test('the contact frontier and the pre-contact base', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.leaflet-overlay-pane path').first()).toBeAttached();

  // The layer is off by default and its data is not fetched until it is asked for.
  const requested: string[] = [];
  page.on('request', (r) => requested.push(r.url()));
  await page.getByRole('button', { name: 'Layers' }).click();
  await page.getByLabel('Contact frontier').check();
  await expect
    .poll(() => requested.filter((u) => u.includes('contact')).length, { timeout: 15000 })
    .toBeGreaterThan(0);

  // Its caveat travels with it: these years must not be read as a record of what happened first.
  const caveat = page.getByTestId('contact-caveat');
  await expect(caveat).toBeVisible();
  await expect(caveat).toContainText('European frame');

  // Before the atlas begins, the base is the Indigenous language families and community names,
  // with the caveat from the schema.
  await page.getByTestId('start-select').selectOption('1000');
  const slider = page.getByRole('slider', { name: 'Year' });
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('timeline-year')).toHaveText('1000');
  await expect(page.getByTestId('indigenous-caveat')).toContainText('not pre-contact boundaries');
  await expect(page.locator('.family-label').first()).toBeAttached();
  await expect(page.locator('.leaflet-control-attribution')).toContainText('Glottolog');
});

test('the Indigenous layers are available at any date', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.leaflet-overlay-pane path').first()).toBeAttached();
  await expect(page.getByTestId('indigenous-caveat')).toHaveCount(0);

  await page.getByRole('button', { name: 'Layers' }).click();
  const group = page.getByTestId('indigenous-group');
  await group.getByLabel('Language families').check();
  await expect(page.locator('.family-label').first()).toBeAttached({ timeout: 15000 });
  await expect(page.getByTestId('indigenous-caveat')).toContainText('not pre-contact boundaries');

  await group.getByLabel('Community names').check();
  await expect(page.locator('.community-label').first()).toBeAttached();
  await group.getByLabel('Language families').uncheck();
  await group.getByLabel('Community names').uncheck();
  await expect(page.getByTestId('indigenous-caveat')).toHaveCount(0);
});
