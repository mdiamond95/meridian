import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/** The Licences panel (plan Phase 7 §5) shows every attribution string in docs/data-sources.md. */

const groups = JSON.parse(
  readFileSync(new URL('../../src/licences/licences.json', import.meta.url), 'utf8'),
) as { attribution: string }[];

test('every attribution string is in the Licences panel, from the menu and from a link', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Layers' }).click();
  await page.getByTestId('licences-button').click();
  const dialog = page.getByTestId('licences');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('licence')).toHaveCount(groups.length);
  for (const { attribution } of groups) await expect(dialog).toContainText(attribution);
  await expect(dialog).toContainText('This does not constitute an endorsement by Statistics Canada');
  const result = await new AxeBuilder({ page }).include('[data-testid="licences"]').analyze();
  expect(result.violations.map((v) => v.id)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.goto('./#licences');
  await expect(page.getByTestId('licences')).toBeVisible();
  await page.getByRole('button', { name: 'Close licences' }).click();
  await expect(page.getByTestId('licences')).toBeHidden();
  expect(new URL(page.url()).hash).toBe('');
  // And from the map's attribution line.
  await page.locator('.leaflet-control-attribution a', { hasText: 'Licences' }).click();
  await expect(page.getByTestId('licences')).toBeVisible();
});
