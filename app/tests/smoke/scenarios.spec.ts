import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** Phase 6 on the built site: scenarios, nesting, overlays and scores (both layouts). */
test.describe.configure({ timeout: 120_000 });

async function chooseScenario(page: Page, id: string) {
  await page.goto('./');
  await expect(page.getByTestId('timeline-year')).toHaveText('1867');
  await page.getByTestId('scenario-tab').click();
  await page.getByTestId('scenario-select').selectOption(id);
  await expect(page.getByTestId('scenario-badge')).toBeVisible();
}

async function toYear(page: Page, year: number) {
  await page.getByRole('slider', { name: 'Year' }).fill(String(year));
  await expect(page.getByTestId('timeline-year')).toHaveText(String(year));
}

test('Newfoundland independent: no 1949 accession, a notice where it would have been, clean to today', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await chooseScenario(page, 'newfoundland-independent-1949');
  await expect(page.getByTestId('scenario-badge')).toContainText('2 base events skipped');
  await expect(page.getByTestId('scenario-clean')).toBeVisible();
  await expect(page.getByTestId('scenario-skipped').locator('li')).toHaveCount(2);
  await expect(page.getByTestId('scenario-skipped')).toContainText('Newfoundland joins');
  await expect(
    page.getByTestId('timeline').getByRole('button', { name: '31 Mar 1949: Newfoundland joins' }),
  ).toHaveCount(0);

  await toYear(page, 1999);
  await expect(page.getByTestId('scenario-diff')).toContainText('Newfoundland: status Province → Dominion');
  await toYear(page, 1949);
  await page.getByTestId('details-tab').click();
  await expect(page.getByTestId('skipped-notice')).toContainText('Newfoundland joins');

  await page.getByTestId('scenario-exit').click();
  await expect(page.getByTestId('scenario-badge')).toHaveCount(0);
  await expect(
    page.getByTestId('timeline').getByRole('button', { name: '31 Mar 1949: Newfoundland joins' }),
  ).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('Unified Buffalo: one province from 1905, the record outlined beneath it', async ({
  page,
}, testInfo) => {
  await chooseScenario(page, 'buffalo-1905');
  await page
    .getByTestId('timeline')
    .getByRole('button', { name: '1 Sep 1905: The Province of Buffalo' })
    .dispatchEvent('click');
  await expect(page.getByTestId('timeline-event')).toContainText('The Province of Buffalo');
  const diff = page.getByTestId('scenario-diff');
  await expect(diff).toContainText('Only in the scenario: Buffalo (province, Canada, capital Regina)');
  await expect(diff).toContainText('Only in the record: Alberta');
  // The base's two provinces are drawn as dashed outlines, never filled.
  await expect(page.locator('.leaflet-overlay-pane path[stroke-dasharray="6 6"]')).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath('buffalo-1905.png') });
  await toYear(page, 1913);
  await expect(page.getByTestId('timeline-event')).toContainText('Manitoba, Ontario and Quebec extended');
});

test('nesting: a region of a region of a preset, a breadcrumb back up, one JSON for the tree', async ({
  page,
}) => {
  await page.goto('./#pack=alberta-15');
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(15, { timeout: 60_000 });

  const splitFirstRegion = async (n: number) => {
    await page.getByTestId('dossier-tab').click();
    await page.locator('.dossier .legend-row').first().click({ timeout: 60_000 });
    await page.getByTestId('nest-n').fill(String(n));
    await page.getByTestId('nest-split').click();
    await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(n, { timeout: 60_000 });
  };
  await splitFirstRegion(3);
  await splitFirstRegion(2);
  const crumbs = page.getByTestId('nest-breadcrumb').locator('.breadcrumb li');
  await expect(crumbs).toHaveCount(3);

  await page.getByTestId('files-tab').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-tree').click(),
  ]);
  const tree = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(tree.meta.id).toBe('alberta-15');
  expect(tree.children).toHaveLength(1);
  expect(tree.children[0].meta.parentPack).toBe('alberta-15');
  expect(tree.children[0].children[0].meta.parentPack).toBe(tree.children[0].meta.id);
  expect(tree.children[0].children[0].regions).toHaveLength(2);

  await page.getByTestId('generate-tab').click();
  await crumbs.first().getByRole('button').click();
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(15);
});

test('overlays sit over any partition; the 1867 preset carries scores', async ({ page }) => {
  await page.goto('./#pack=dominion-1867-5');
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(5, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Layers' }).click();
  await page.getByTestId('overlay-immigrant-halos').check();
  await expect(page.locator('path.overlay-immigrant-halos')).toHaveCount(40, { timeout: 30_000 });
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(5);
  await page.getByRole('button', { name: 'Layers' }).click();

  await page.getByTestId('dossier-tab').click();
  await page.locator('.dossier .legend-row').first().click({ timeout: 60_000 });
  const score = page.getByTestId('region-score');
  await expect(score).toContainText('Cohesion');
  await expect(score).toContainText('Exposure');
});
