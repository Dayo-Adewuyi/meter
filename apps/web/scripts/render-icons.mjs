// Renders the PNG app icons from public/icons/icon.svg with the local Chrome.
// Run after editing the SVG: pnpm --filter @meter/web icons
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const root = new URL('..', import.meta.url);
const svg = await readFile(new URL('public/icons/icon.svg', root), 'utf8');
const targets = [
  ['public/icons/icon-192.png', 192],
  ['public/icons/icon-512.png', 512],
  ['app/apple-icon.png', 180],
];

const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [path, size] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: new URL(path, root).pathname, omitBackground: false });
    await page.close();
    console.log(`rendered ${path} (${size}px)`);
  }
} finally {
  await browser.close();
}
