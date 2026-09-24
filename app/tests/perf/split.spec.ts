import { execSync } from 'node:child_process';
import { devices, expect, test, type CDPSession, type Page } from '@playwright/test';

/**
 * Plan Phase 7 §1: frame times with a 30-region Canada split on the map, and the memory a split of
 * the whole mesh (38,432 cells, "the 40k-cell split") costs under Playwright's iPad emulation. Like
 * frame-time.spec.ts this measures the machine as much as the code, so it is not part of smoke; the
 * numbers go in docs/perf.md. Run with `npm run frame-time` after `npm run build`.
 */

test.describe.configure({ timeout: 300_000 });

const STEPS = 24;

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { median: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}
const ms = (v: number) => `${v.toFixed(1)} ms`;

/** Run Canada into `n` regions from the Generate panel; resolves with the longest main-thread task. */
async function runCanada(page: Page, n: number) {
  await page.getByTestId('generate-tab').click();
  await expect(page.getByTestId('generate')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('scope-select').selectOption('canada');
  await page.getByTestId('n-input').fill(String(n));
  await page.evaluate(() => {
    const w = window as unknown as { __longest: number; __observer?: PerformanceObserver };
    w.__longest = 0;
    w.__observer?.disconnect();
    w.__observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longest = Math.max(w.__longest, e.duration);
    });
    w.__observer.observe({ type: 'longtask' });
  });
  const started = Date.now();
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('split-legend').locator('li')).toHaveCount(n, { timeout: 240_000 });
  const elapsed = Date.now() - started;
  const longest = await page.evaluate(() => (window as unknown as { __longest: number }).__longest);
  return { elapsed, longest };
}

async function sliderSteps(page: Page, from: number) {
  return page.evaluate(
    async ({ from, steps }) => {
      const slider = document.querySelector<HTMLInputElement>('#timeline-slider');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!slider || !setter) throw new Error('no timeline slider');
      const work: number[] = [];
      for (let i = 1; i <= steps; i++) {
        setter.call(slider, String(from + i));
        const started = performance.now();
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        work.push(performance.now() - started);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return work;
    },
    { from, steps: STEPS },
  );
}

/** Frame gaps while `drive` runs, from a rAF loop in the page. */
async function frameGaps(page: Page, drive: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    const tick = (t: number) => {
      w.__frames.push(t);
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await drive();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __stop: boolean };
    w.__stop = true;
    return w.__frames;
  });
  return frames.slice(1).map((t, i) => t - frames[i]);
}

test('frame times with a 30-region Canada split on the map', async ({ page }, testInfo) => {
  await page.goto('./');
  await expect(page.getByTestId('map')).toHaveAttribute('data-atlas-warm', 'true');
  const run = await runCanada(page, 30);

  const map = page.getByTestId('map');
  const box = await map.boundingBox();
  if (!box) throw new Error('no map');
  const cx = box.x + box.width * 0.35;
  const cy = box.y + box.height * 0.45;

  const pan = await frameGaps(page, async () => {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(cx + i * 6, cy + i * 2);
    await page.mouse.up();
    await page.waitForTimeout(300);
  });
  const hover = await frameGaps(page, async () => {
    for (let i = 0; i < 30; i++) await page.mouse.move(cx + i * 8, cy - i * 3);
  });
  // The atlas beneath the split, stepped across Confederation's events.
  await page.evaluate(() => {
    const slider = document.querySelector<HTMLInputElement>('#timeline-slider');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '1855');
    slider?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(map).toHaveAttribute('data-atlas-lookahead', /.+/, { timeout: 60_000 });
  const steps = stats(await sliderSteps(page, 1855));

  const lines = [
    `${testInfo.project.name} Canada into 30: ${run.elapsed} ms to the legend, longest main-thread task ${ms(run.longest)}`,
    `${testInfo.project.name} pan: frame median ${ms(stats(pan).median)}, p95 ${ms(stats(pan).p95)}, max ${ms(stats(pan).max)}`,
    `${testInfo.project.name} hover: frame median ${ms(stats(hover).median)}, p95 ${ms(stats(hover).p95)}, max ${ms(stats(hover).max)}`,
    `${testInfo.project.name} slider under the split: work median ${ms(steps.median)}, p95 ${ms(steps.p95)}, max ${ms(steps.max)}`,
  ];
  console.log(lines.join('\n'));
  await testInfo.attach('split-frame-time', { body: lines.join('\n'), contentType: 'text/plain' });
  expect(steps.max, 'slowest slider step under the split').toBeLessThan(16);
});

test.describe('memory, iPad emulation', () => {
  // Playwright's iPad Pro 11 descriptor (viewport, device scale factor, touch, mobile user agent) in
  // Chromium: Safari's own heap cannot be read from Playwright, so this is Chromium's accounting of
  // the same page at the same size. The Codespace check is a trend, not an iPad's number.
  const { defaultBrowserType: _ignored, ...ipad } = devices['iPad Pro 11'];
  test.use(ipad);

  async function sample(cdp: CDPSession) {
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    // The renderer holds the page and the solver worker; one test runs at a time, so the largest
    // headless-shell renderer is this page's.
    let rss = 0;
    try {
      const ps = execSync('ps -eo rss,args', { encoding: 'utf8' });
      for (const line of ps.split('\n'))
        if (/ms-playwright/.test(line) && /--type=renderer/.test(line))
          rss = Math.max(rss, Number(line.trim().split(/\s+/)[0]) * 1024);
    } catch {
      rss = NaN;
    }
    return { heap: m.JSHeapUsedSize, total: m.JSHeapTotalSize, nodes: m.Nodes, rss };
  }

  test('a split of the whole mesh stays within an iPad budget and does not grow', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'ipad', 'one emulated device is enough');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const rows: [string, Awaited<ReturnType<typeof sample>>][] = [];

    await page.goto('./');
    await expect(page.getByTestId('map')).toHaveAttribute('data-atlas-warm', 'true');
    rows.push(['atlas loaded and warm', await sample(cdp)]);
    await page.getByTestId('generate-tab').click();
    await expect(page.getByTestId('generate')).toBeVisible({ timeout: 60_000 });
    rows.push(['splitter data decoded', await sample(cdp)]);
    await runCanada(page, 30);
    rows.push(['Canada (38,432 cells) into 30', await sample(cdp)]);
    await page.getByTestId('set-tab').click();
    await expect(page.getByTestId('panel')).toContainText('Population reconciliation', { timeout: 120_000 });
    rows.push(['with dossiers and set analysis', await sample(cdp)]);
    // Renderer memory climbs for the first few runs (the solver worker's heap and the canvas settle)
    // and then levels off; five more runs show where.
    for (let i = 2; i <= 6; i++) {
      await runCanada(page, 30);
      rows.push([`run ${i}`, await sample(cdp)]);
    }

    const mb = (b: number) => `${(b / 1024 / 1024).toFixed(0)} MB`;
    const lines = rows.map(
      ([stage, s]) =>
        `${stage}: JS heap ${mb(s.heap)} (of ${mb(s.total)}), DOM nodes ${s.nodes}, renderer RSS ${mb(s.rss)}`,
    );
    console.log(lines.join('\n'));
    await testInfo.attach('split-memory', { body: lines.join('\n'), contentType: 'text/plain' });
    const [, afterFirst] = rows[3];
    const [, last] = rows[rows.length - 1];
    const [, beforeLast] = rows[rows.length - 2];
    // Re-running the same split replaces the old one: the heap must not climb run after run.
    expect(last.heap, 'heap after five more runs').toBeLessThan(afterFirst.heap * 1.15);
    // And the renderer as a whole has levelled off by the last runs.
    expect(last.rss, 'renderer RSS, last run against the one before').toBeLessThan(beforeLast.rss * 1.1);
    // A budget with room to spare on an iPad (Safari starts discarding tabs well above this).
    expect(last.heap, 'JS heap').toBeLessThan(400 * 1024 * 1024);
  });
});
