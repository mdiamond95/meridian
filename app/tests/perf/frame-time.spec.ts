import { expect, test } from '@playwright/test';

/**
 * Slider frame time at the two dates the Phase 2 gate names: 1867 and 1999. Phase 7's target is
 * stricter: every one-year step under 16 ms, including the steps that cross an event.
 *
 * What is measured: the main-thread work one slider step costs — from dispatching the range
 * input's `input` event (React flushes discrete input synchronously) to the moment the handler
 * returns, which includes resolving the units for the new date, React's commit, and Leaflet
 * adding, removing and restyling paths. The paint that follows is measured separately as the
 * delay to the next animation frame, because in a headless browser that number is mostly vsync
 * and idle, not our work.
 *
 * 16 ms is the budget for one 60 Hz frame, so the work figure is the one to keep under it.
 */

const STEPS = 24;

interface Sample {
  work: number[];
  paint: number[];
  gaps: number[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

test('slider frame time at 1867 and 1999', async ({ page }, testInfo) => {
  await page.goto('./');
  await expect(page.locator('.leaflet-overlay-pane path').first()).toBeAttached();
  // Measure the steady state: the atlas warms its layer cache when the browser is idle after
  // loading, and a user who drags the slider before that is over pays the build cost once per row.
  await expect(page.getByTestId('map')).toHaveAttribute('data-atlas-warm', 'true');

  // Start each run on its first year and let the lookahead settle there, as it would while a user
  // reads the map before dragging: the run then steps one year at a time, crossing real events.
  const settleAt = async (year: number) => {
    const map = page.getByTestId('map');
    await page.evaluate((year) => {
      const slider = document.querySelector<HTMLInputElement>('#timeline-slider');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!slider) throw new Error('no timeline slider');
      setter?.call(slider, String(year));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }, year);
    await expect(map).toHaveAttribute('data-atlas-lookahead', /.+/);
  };

  const measure = async (centre: number): Promise<Sample> =>
    page.evaluate(
      async ({ centre, steps }) => {
        const slider = document.querySelector<HTMLInputElement>('#timeline-slider');
        if (!slider) throw new Error('no timeline slider');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        const work: number[] = [];
        const paint: number[] = [];
        const frames: number[] = [];
        // Drag across the years either side of the date, so the run crosses real events.
        for (let i = 1; i <= steps; i += 1) {
          const year = centre - Math.floor(steps / 2) + i;
          setter?.call(slider, String(year));
          const started = performance.now();
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          work.push(performance.now() - started);
          const painted = await new Promise<number>((resolve) =>
            requestAnimationFrame(() => resolve(performance.now())),
          );
          paint.push(painted - started);
          frames.push(painted);
        }
        // One step per frame, so the gap between successive frames is what a user sees: it covers
        // the step, the paint, and any idle slice (the lookahead re-filling) that ran in between.
        const gaps = frames.slice(1).map((t, i) => t - frames[i]);
        return { work, paint, gaps };
      },
      { centre, steps: STEPS },
    );

  const lines: string[] = [];
  const rows = [];
  for (const year of [1867, 1999]) {
    await settleAt(year - Math.floor(STEPS / 2));
    const sample = await measure(year);
    const row = {
      year,
      workMedian: median(sample.work),
      workP95: percentile(sample.work, 95),
      workMax: Math.max(...sample.work),
      paintMedian: median(sample.paint),
      gapMax: Math.max(...sample.gaps),
    };
    rows.push(row);
    lines.push(
      `${testInfo.project.name} ${year}: work median ${row.workMedian.toFixed(1)} ms, ` +
        `p95 ${row.workP95.toFixed(1)} ms, max ${row.workMax.toFixed(1)} ms; ` +
        `to next frame ${row.paintMedian.toFixed(1)} ms; longest frame ${row.gapMax.toFixed(1)} ms`,
    );
  }
  // Report every number before asserting, so a failure still shows what both dates cost.
  console.log(lines.join('\n'));
  await testInfo.attach('frame-time', { body: lines.join('\n'), contentType: 'text/plain' });
  for (const row of rows) {
    expect(row.workMedian, `median at ${row.year}`).toBeLessThan(16);
    // The steps that cross an event swap which pre-attached paths are shown (AtlasLayer's
    // lookahead), so they fit the frame too: every step, not a percentile. See docs/perf.md.
    expect(row.workMax, `slowest step at ${row.year}`).toBeLessThan(16);
  }
});
