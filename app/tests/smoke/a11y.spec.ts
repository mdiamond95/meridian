import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * Accessibility (plan Phase 7 §3): no WCAG 2.1 A/AA violations axe can find in any panel, a timeline
 * and a Generate panel that work from the keyboard alone, and focus that follows the panel's order.
 */

test.describe.configure({ timeout: 180_000 });

const TABS = ['details', 'scenario', 'generate', 'dossier', 'set', 'compare', 'files'];

async function focusedLabel(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return '';
    return (
      el.getAttribute('aria-label') ||
      el.getAttribute('data-testid') ||
      el.closest('label')?.textContent?.trim().slice(0, 40) ||
      el.textContent?.trim().slice(0, 40) ||
      el.tagName
    );
  });
}

test('axe finds no WCAG 2.1 A or AA violations in any panel', async ({ page }) => {
  await page.goto('./#pack=alberta-15');
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(15, { timeout: 60_000 });
  const found: string[] = [];
  for (const tab of TABS) {
    await page.getByTestId(`${tab}-tab`).click();
    await expect(page.getByRole('tabpanel')).toBeVisible();
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    for (const v of result.violations)
      found.push(`${tab}: ${v.id} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
  }
  expect(found).toEqual([]);
});

test('the timeline works from the keyboard', async ({ page }) => {
  await page.goto('./');
  const year = page.getByTestId('timeline-year');
  const event = page.getByTestId('timeline-event');
  await expect(year).toHaveText('1867');

  const slider = page.getByRole('slider', { name: 'Year' });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(year).toHaveText('1868');
  // Page Up: the next event (Manitoba and the transfer of Rupert's Land, 15 July 1870).
  await page.keyboard.press('PageUp');
  await expect(event).toContainText('1870');
  await expect(year).toHaveText('1870');
  // Page Down: back to the start of this event's window (the end of 1871 is in British Columbia's),
  // then the one before.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('PageDown');
  await expect(event).toContainText('20 Jul 1871');
  await page.keyboard.press('PageDown');
  await expect(event).toContainText('15 Jul 1870');

  // The ticks are one tab stop after the slider, and arrows move between events.
  await page.keyboard.press('Tab');
  const tick = page.locator('.timeline-tick:focus');
  await expect(tick).toHaveAttribute('data-active', 'true');
  const before = await event.textContent();
  await page.keyboard.press('ArrowRight');
  await expect(event).not.toHaveText(before ?? '');
  await expect(page.locator('.timeline-tick:focus')).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('Home');
  await expect(year).toHaveText('1670');
  expect(await page.locator('.timeline-tick[tabindex="0"]').count()).toBe(1);
});

test('the Generate panel runs a split from the keyboard, in panel order', async ({ page }) => {
  await page.goto('./');
  // The tab row is one tab stop; arrows choose a tab.
  await page.getByTestId('details-tab').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('generate-tab')).toBeFocused();
  await expect(page.getByTestId('generate-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('generate')).toBeVisible({ timeout: 60_000 });

  // Tab through the panel: every stop is inside it until Run, and the main controls come in the
  // order they are laid out.
  const order: string[] = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab');
    const inPanel = await page.evaluate(() => !!document.activeElement?.closest('[role="tabpanel"]'));
    expect(inPanel, `stop ${i + 1} (${await focusedLabel(page)}) is in the panel`).toBe(true);
    const testId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');
    if (testId) order.push(testId);
    if (testId === 'run-button') break;
  }
  const main = order.filter((id) =>
    ['scope-select', 'method-select', 'n-input', 'seed-input', 'run-button'].includes(id),
  );
  expect(main).toEqual(['scope-select', 'method-select', 'n-input', 'seed-input', 'run-button']);

  // Set a small scope and N from the keyboard, then run with Enter.
  await page.getByTestId('scope-select').focus();
  await page.getByTestId('scope-select').selectOption('province');
  await page.getByTestId('province-select').focus();
  await page.getByTestId('province-select').selectOption('PE');
  await page.getByTestId('n-input').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('3');
  await page.getByTestId('run-button').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(3, { timeout: 60_000 });
});
