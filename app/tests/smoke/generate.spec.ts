import { expect, test } from '@playwright/test';

test.describe.configure({ timeout: 90_000 });

test('a shipped preset loads from the library and shows its regions', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('generate-tab').click();
  await expect(page.getByTestId('generate')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('preset-select').selectOption('alberta-15');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(15, { timeout: 30_000 });
  await expect(page.locator('.region-label').first()).toBeAttached();
  expect(new URL(page.url()).hash).toBe('#pack=alberta-15');
});

test('a split runs in the worker, and its share link reruns it', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('generate-tab').click();
  await expect(page.getByTestId('generate')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('scope-select').selectOption('province');
  await page.getByTestId('province-select').selectOption('NS');
  await page.getByTestId('n-input').fill('3');
  await page.getByTestId('run-button').click();
  const legend = page.getByTestId('split-legend').locator('li');
  await expect(legend).toHaveCount(3, { timeout: 60_000 });
  const names = await legend.allTextContents();
  const hash = new URL(page.url()).hash;
  expect(hash).toMatch(/^#split=/);

  await page.goto(`./${hash}`);
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(3, { timeout: 60_000 });
  expect(await page.getByTestId('split-legend').locator('li').allTextContents()).toEqual(names);
});

test('a pack link loads the preset, and painting a cell marks the split edited', async ({ page }) => {
  await page.goto('./#pack=canada-14');
  const legend = page.getByTestId('split-legend');
  await expect(legend.locator('li')).toHaveCount(14, { timeout: 60_000 });
  await expect(legend).toContainText("St. John's");
  await legend.getByRole('button', { name: /St\. John's/ }).click();
  await page.getByRole('button', { name: 'Paint cells' }).click();
  // Close the panel first: on iPad it is a bottom sheet over the map, and a click on Toronto would land
  // on the legend. The paint tool stays on.
  const handle = page.getByTestId('panel').locator('.panel-handle');
  await handle.click();
  await expect(page.getByTestId('split-result')).toBeHidden();
  // Paint at the Toronto region's label, which sits on its largest place: land, and not St. John's.
  const label = await page.locator('.region-label span', { hasText: /^Toronto$/ }).boundingBox();
  if (!label) throw new Error('no Toronto label');
  await page.mouse.click(label.x + label.width / 2, label.y + label.height / 2);
  await handle.click();
  await expect(page.getByTestId('split-result')).toContainText('edited');
});

test('acadie-2 loads with its names, and its scope shows as several provinces (1.0.1)', async ({ page }) => {
  await page.goto('./#pack=acadie-2');
  const legend = page.getByTestId('split-legend');
  await expect(legend.locator('li')).toHaveCount(2, { timeout: 60_000 });
  await expect(legend).toContainText('Acadie');
  await expect(legend).toContainText('Maritimes');
  await expect(page.getByTestId('scope-select')).toHaveValue('provinces');
  const picker = page.getByTestId('provinces-picker');
  for (const code of ['NB', 'NS', 'PE']) await expect(picker.getByLabel(code)).toBeChecked();
  await expect(picker.getByLabel('QC')).not.toBeChecked();
  // The dossiers, written in the worker, keep the names the recipe gives.
  await page.getByTestId('dossier-tab').click();
  await expect(page.getByTestId('panel')).toContainText('Acadie', { timeout: 60_000 });
});
