// tools/make-icons.mjs: draws src/icons/{16,32,48,128}.png from the SVG below, using the Chrome
// installed on this Mac (headless, through puppeteer-core; closed with CDP Browser.close).
//
//   node tools/make-icons.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'src', 'icons');
const CHROME = process.env.PM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A teal tile, a bold check, and a line of "text" under it. Thicker strokes at small sizes.
const svg = (size) => {
  const small = size <= 32;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14968b"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#g)"/>
  <path d="M32 62 L54 84 L98 36" fill="none" stroke="#fff" stroke-width="${small ? 17 : 14}" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M30 104 H98" stroke="#fff" stroke-opacity="0.6" stroke-width="${small ? 11 : 8}" stroke-linecap="round"/>
</svg>`;
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-icons-'));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: profile, args: ['--no-first-run'] });
try {
  const page = await browser.newPage();
  fs.mkdirSync(OUT, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size)}</body></html>`);
    await page.screenshot({ path: path.join(OUT, `${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`wrote src/icons/${size}.png`);
  }
} finally {
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
