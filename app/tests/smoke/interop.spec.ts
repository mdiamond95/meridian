import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/**
 * The cities-atlas gate (plan Phase 5, amended): the twenty-line Leaflet snippet in docs/interop.md,
 * run as written, draws alberta-15 with one layer per region and names a region on hover. Its network
 * is served from this checkout: raw.githubusercontent.com from packs/ and data/build/, unpkg from
 * node_modules; map tiles are not needed.
 */

const ROOT = new URL('../../../', import.meta.url);
const RAW = 'https://raw.githubusercontent.com/mdiamond95/meridian/main/';

function snippet(): string {
  const doc = readFileSync(new URL('docs/interop.md', ROOT), 'utf8');
  const block = doc.split('<!-- leaflet-snippet:start -->')[1]?.split('<!-- leaflet-snippet:end -->')[0];
  const html = block?.match(/```html\n([\s\S]*?)```/)?.[1];
  if (!html) throw new Error('no Leaflet snippet in docs/interop.md');
  return html;
}

const UNPKG: Record<string, string> = {
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css': 'node_modules/leaflet/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js': 'node_modules/leaflet/dist/leaflet.js',
  'https://unpkg.com/topojson-client@3.1.0/dist/topojson-client.min.js':
    'node_modules/topojson-client/dist/topojson-client.min.js',
};

test('the docs/interop.md Leaflet snippet draws a pack and names a region on hover', async ({ page }) => {
  const html = snippet();
  expect(html.trim().split('\n')).toHaveLength(20);
  const pack = JSON.parse(readFileSync(new URL('packs/alberta-15.v1.json', ROOT), 'utf8')) as {
    regions: { id: number; name: string }[];
  };

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (url === 'https://interop.test/') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (url.startsWith(RAW)) {
      const path = url.slice(RAW.length);
      if (!/^(packs\/[a-z0-9.-]+\.json|data\/build\/[a-z0-9.]+\.gz)$/.test(path)) {
        return route.fulfill({ status: 404, headers: cors });
      }
      // Served as raw.githubusercontent.com does: plain bytes, no Content-Encoding.
      return route.fulfill({
        headers: cors,
        contentType: 'text/plain; charset=utf-8',
        body: readFileSync(new URL(path, ROOT)),
      });
    }
    if (UNPKG[url]) {
      return route.fulfill({
        contentType: url.endsWith('.css') ? 'text/css' : 'application/javascript',
        body: readFileSync(new URL(UNPKG[url], ROOT)),
      });
    }
    // Tiles and anything else: not needed to draw the regions.
    return route.fulfill({ status: 204 });
  });

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('https://interop.test/');

  const regions = page.locator('path.leaflet-interactive');
  await expect(regions).toHaveCount(pack.regions.length);
  expect(errors).toEqual([]);

  // Leaflet opens a region's tooltip on mouseover of its own path. (A synthetic mouseout does not
  // close it, so each hover looks for its own label.)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const i of [0, pack.regions.length - 1]) {
    await regions.nth(i).dispatchEvent('mouseover');
    const label = page
      .locator('.leaflet-tooltip')
      .filter({ hasText: new RegExp(`^${escape(pack.regions[i].name)}$`) });
    await expect(label).toBeVisible();
  }
});
