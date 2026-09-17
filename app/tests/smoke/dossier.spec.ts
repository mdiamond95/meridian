import { expect, test } from '@playwright/test';

/** Phase 4 on the built site: the dossier, the set analysis and compare mode (both layouts). */
test.describe.configure({ timeout: 120_000 });

async function loadPreset(page: import('@playwright/test').Page, id: string) {
  await page.goto(`./#pack=${id}`);
  await expect(page.getByTestId('split-legend').locator('li').first()).toBeAttached({ timeout: 60_000 });
}

test('a region dossier reads off its borders, its numbers and its drafts', async ({ page }) => {
  await loadPreset(page, 'alberta-15');
  await page.getByTestId('dossier-tab').click();
  // The Generate panel (and its legend) is unmounted by the tab switch; the dossier tab lists the
  // regions itself once they are described.
  await page.locator('.dossier .legend-row').first().click();
  const dossier = page.getByTestId('dossier');
  await expect(dossier).toBeVisible();
  await expect(dossier.getByTestId('borders').locator('li').first()).toBeVisible();
  await expect(dossier).toContainText('⟨draft⟩');
  await expect(dossier).toContainText('GDP (estimate)');
  await expect(dossier).toContainText('estimate, allocated');
  await expect(dossier).toContainText('hypothetical');
});

test('the set panel ranks power and says what would break in the federation', async ({ page }) => {
  await loadPreset(page, 'canada-14');
  await page.getByTestId('set-tab').click();
  const ranking = page.getByTestId('power-ranking');
  await expect(ranking).toBeVisible({ timeout: 60_000 });
  await expect(ranking.locator('tbody tr')).toHaveCount(14);
  const federalism = page.getByTestId('federalism');
  await expect(federalism.locator('li')).toHaveCount(6);
  await expect(federalism).toContainText('Constitution Act');
  await expect(federalism.locator('li[data-verdict="breaks"]').first()).toBeVisible();
  await expect(page.getByTestId('set-analysis')).toContainText('allocation_v1');
});

test('compare mode swipes between two splits and says what moved', async ({ page }) => {
  await loadPreset(page, 'canada-14');
  await page.getByTestId('compare-tab').click();
  await page.getByTestId('compare-select').selectOption('actual-canada');
  await page.getByTestId('compare-button').click();
  await expect(page.getByTestId('difference')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('difference')).toContainText('Cells reassigned');
  await expect(page.getByTestId('compare-table').locator('tbody tr').first()).toBeVisible();

  // The divider is on the map, and moving it changes the split of the view.
  const divider = page.getByTestId('compare-divider');
  await expect(divider).toBeVisible();
  const before = await divider.evaluate((el) => (el as HTMLElement).style.left);
  await divider.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => divider.evaluate((el) => (el as HTMLElement).style.left)).not.toBe(before);
  // Both panes are clipped, so each split has its own side of the map.
  const clips = await page.evaluate(() => {
    const pane = (name: string) =>
      (document.querySelector(`.leaflet-pane.leaflet-${name}-pane`) as HTMLElement | null)?.style.clipPath ??
      '';
    return [pane('split-regions'), pane('split-compare')];
  });
  expect(clips[0]).toMatch(/inset/);
  expect(clips[1]).toMatch(/inset/);
});
