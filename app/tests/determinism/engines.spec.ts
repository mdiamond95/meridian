import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium, expect, firefox, test, webkit, type BrowserType } from '@playwright/test';
import { build } from 'esbuild';

/**
 * The Phase 3 determinism gate: one fixed seed and params (src/engine/testing/determinismCases.ts)
 * give byte-identical assignments in Chromium, WebKit and Firefox, and match the hashes Node
 * produces (src/engine/golden/cross-engine.json, asserted by Vitest too).
 */

const ROOT = new URL('../../', import.meta.url);
const GOLDEN = JSON.parse(
  readFileSync(new URL('src/engine/golden/cross-engine.json', ROOT), 'utf8'),
) as Record<string, string>;
const ENGINES: [string, BrowserType][] = [
  ['chromium', chromium],
  ['webkit', webkit],
  ['firefox', firefox],
];

function hash(values: number[]): string {
  return createHash('sha256')
    .update(Buffer.from(Int32Array.from(values).buffer))
    .digest('hex');
}

test('the solver gives identical assignments in Chromium, WebKit and Firefox', async () => {
  test.setTimeout(300_000);
  const bundle = await build({
    entryPoints: [new URL('tests/determinism/harness.ts', ROOT).pathname],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
  });
  const script = bundle.outputFiles[0].text;
  const files: Record<string, Buffer> = {
    '/data/mesh.v1.json.gz': readFileSync(new URL('../data/build/mesh.v1.json.gz', ROOT)),
    '/data/attrs.v1.json.gz': readFileSync(new URL('../data/build/attrs.v1.json.gz', ROOT)),
  };

  const hashes: Record<string, Record<string, string>> = {};
  for (const [name, engine] of ENGINES) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage();
      await page.route('http://localhost/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><title>determinism</title>',
          });
        const body = files[path];
        return body
          ? route.fulfill({ body, contentType: 'application/octet-stream' })
          : route.fulfill({ status: 404 });
      });
      await page.goto('http://localhost/');
      await page.addScriptTag({ content: script });
      const assignments = await page.evaluate(() =>
        (window as unknown as { determinism: () => Promise<Record<string, number[]>> }).determinism(),
      );
      hashes[name] = Object.fromEntries(
        Object.entries(assignments).map(([label, values]) => [label, hash(values)]),
      );
    } finally {
      await browser.close();
    }
  }

  expect(hashes.webkit).toEqual(hashes.chromium);
  expect(hashes.firefox).toEqual(hashes.chromium);
  expect(hashes.chromium).toEqual(GOLDEN);
});
