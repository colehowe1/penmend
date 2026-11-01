// tools/store-images.mjs: the Chrome Web Store images in store/images/: five 1280x800 screenshots
// of the real extension on a made-up mail page (store/demo/compose.html), the two promo tiles and
// the 128x128 store icon.
//
//   npm run store-images      (builds the test build first; Claude's answers come from a local
//                              mock, so nothing is sent to Anthropic and nothing is spent)
//
// Uses the Chrome installed on this Mac over a CDP pipe, like the end-to-end test, and quits it
// with CDP Browser.close; the temporary profile is removed on every way out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist-test');
const DEMO = path.join(ROOT, 'store/demo');
const OUT = path.join(ROOT, 'store/images');
const CHROME = process.env.PM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The capture inside each screenshot (CSS px; taken at 2x for sharp text).
const SHOT = { width: 1180, height: 640 };

// ---- What gets typed, and what the mock "Claude" says about it ---------------------------------

const LOCAL_TEXT = [
  'Hi Dana,',
  'Thanks for sending the floor plan. I will recieve the new parts on Wednesday, and we can start the install tomorow afternoon. Its not a big job, so we should be done by five.',
  'Thanks,',
  'Sam',
];
const SPLICE = "When the parts arrive we'll start the install, it should take about two hours.";
const LONG = 'I wanted to follow up on our call from last week about the schedule because the team is wondering whether we could move the start date to the following Monday so that everyone has enough time to finish the safety training.';
const LONG_REWRITE = "Following up on last week's call about the schedule: could we move the start date to the following Monday? That gives everyone time to finish the safety training.";
const CLAUDE_TEXT = ['Hi Dana,', SPLICE, LONG, 'Thanks,', 'Sam'];
const FRIENDLY = [
  'Hi Dana,',
  "Good news: once the parts arrive, we'll start the install. It should only take about two hours.",
  "Also, following up on last week's call: could we move the start date to the following Monday? That would give everyone time to finish the safety training.",
  'Thanks so much,',
  'Sam',
].join('\n');

const MOCK_EDITS = [
  { match: SPLICE, edit: { find: "arrive we'll", replace: "arrive, we'll", type: 'punctuation', why: 'Add a comma after the opening clause.' } },
  { match: SPLICE, edit: { find: 'install, it should', replace: 'install. It should', type: 'punctuation', why: 'Comma splice: make it two sentences.' } },
  { match: LONG, edit: { find: LONG, replace: LONG_REWRITE, type: 'rewrite', why: 'Shorter, with the question up front.' } },
];

// ---- Servers ---------------------------------------------------------------------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function demoServer() {
  return http.createServer((req, res) => {
    const file = path.join(DEMO, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(DEMO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(file));
  });
}

function mockClaude() {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const usage = { input_tokens: 420, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const user = String(body.messages?.[0]?.content ?? '');
    if (body.stream) {
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: 'msg_demo', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const piece of FRIENDLY.match(/[\s\S]{1,24}/g)) send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 90 } });
      send('message_stop', { type: 'message_stop' });
      return res.end();
    }
    let text = 'OK';
    if (body.output_config?.format) {
      const edits = [];
      for (const m of user.matchAll(/<paragraph id="(\d+)"[^>]*>([\s\S]*?)<\/paragraph>/g)) {
        for (const { match, edit } of MOCK_EDITS) if (m[2].includes(match)) edits.push({ p: Number(m[1]), ...edit });
      }
      text = JSON.stringify({ edits });
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({
      id: 'msg_demo', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage,
    }));
  });
}

// ---- Page helpers ----------------------------------------------------------------------------------

async function waitFor(fn, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`timed out: ${fn}`);
}

const hostData = (page) => page.evaluate(() => ({ ...(document.querySelector('penmend-ui')?.dataset || {}) }));
const ui = (page, sel) => page.evaluate((s) => Boolean(document.querySelector('penmend-ui')?.shadowRoot?.querySelector(s)), sel);

/** Viewport rect of `word` in the message body. */
const wordRect = (page, word) => page.evaluate((w) => {
  const walker = document.createTreeWalker(document.getElementById('body'), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf(w);
    if (i >= 0) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      return r.getClientRects()[0].toJSON();
    }
  }
  return null;
}, word);

async function clickUi(page, selector, text) {
  const rect = await page.evaluate((sel, t) => {
    const el = [...(document.querySelector('penmend-ui')?.shadowRoot?.querySelectorAll(sel) || [])].find((e) => !t || e.textContent.trim() === t);
    return el ? el.getBoundingClientRect().toJSON() : null;
  }, selector, text);
  if (!rect) throw new Error(`no ${selector} ${text || ''}`);
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

async function typeMessage(page, lines) {
  await page.click('#body');
  for (const [i, line] of lines.entries()) {
    if (i) await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
  await page.mouse.move(5, 5);
}

async function clickWord(page, word, dx = 0.5) {
  const r = await waitFor(() => wordRect(page, word));
  await page.mouse.click(r.x + r.width * dx, r.y + r.height / 2);
}

// ---- Framing -------------------------------------------------------------------------------------

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14968b"/><stop offset="1" stop-color="#0f766e"/></linearGradient></defs>
  <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#g)"/>
  <path d="M32 62 L54 84 L98 36" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M30 104 H98" stroke="#fff" stroke-opacity="0.6" stroke-width="8" stroke-linecap="round"/>
</svg>`;
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"; // single quotes: it goes in style=""

/** A screenshot as the store shows it: a headline, a line under it, and the capture in a window. */
function framed(capture, title, line) {
  return `<html><body style="margin:0;width:1280px;height:800px;overflow:hidden;font-family:${FONT};
    background:linear-gradient(160deg,#e9f5f3 0%,#f6f4ee 60%,#eef1f6 100%)">
    <div style="position:absolute;left:50px;top:30px;display:flex;align-items:center;gap:14px">
      <div style="width:44px;height:44px">${ICON_SVG}</div>
      <div>
        <div style="font-size:31px;font-weight:700;color:#12302d;letter-spacing:-0.01em">${title}</div>
        <div style="font-size:18px;color:#4a5b59;margin-top:2px">${line}</div>
      </div>
    </div>
    <img src="data:image/png;base64,${capture.toString('base64')}" style="position:absolute;left:50px;top:118px;width:${SHOT.width}px;height:${SHOT.height}px;
      border-radius:12px;box-shadow:0 18px 50px rgba(18,48,45,0.18),0 2px 6px rgba(18,48,45,0.12)">
  </body></html>`;
}

async function render(browser, html, width, height, file, { transparent = false } = {}) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(OUT, file), omitBackground: transparent, clip: { x: 0, y: 0, width, height } });
    console.log(`wrote store/images/${file}`);
  } finally {
    await page.close();
  }
}

function promo(width, height) {
  const big = width > 1000;
  return `<html><body style="margin:0;width:${width}px;height:${height}px;overflow:hidden;font-family:${FONT};
    background:linear-gradient(150deg,#14968b 0%,#0f766e 55%,#0b5d57 100%);display:flex;align-items:center;justify-content:center">
    <div style="display:flex;align-items:center;gap:${big ? 40 : 20}px">
      <div style="width:${big ? 190 : 104}px;height:${big ? 190 : 104}px;border-radius:${big ? 46 : 26}px;background:rgba(255,255,255,0.14);display:grid;place-items:center">
        <svg viewBox="0 0 128 128" width="${big ? 130 : 70}" height="${big ? 130 : 70}"><path d="M32 62 L54 84 L98 36" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><path d="M30 104 H98" stroke="#fff" stroke-opacity="0.6" stroke-width="8" stroke-linecap="round"/></svg>
      </div>
      <div style="color:#fff">
        <div style="font-size:${big ? 96 : 50}px;font-weight:700;letter-spacing:-0.02em;line-height:1">Penmend</div>
        <div style="margin-top:${big ? 18 : 10}px;font-size:${big ? 40 : 22}px;line-height:1.2;color:#eafffb">
          <span style="text-decoration:underline wavy #ff8a80;text-decoration-thickness:${big ? 3 : 2}px;text-underline-offset:${big ? 9 : 5}px">teh</span>
          → the
        </div>
      </div>
    </div>
  </body></html>`;
}

// ---- The run ---------------------------------------------------------------------------------------

if (!fs.existsSync(path.join(DIST, 'manifest.json'))) throw new Error('no dist-test/: run npm run store-images (it builds first)');
fs.mkdirSync(OUT, { recursive: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'penmend-images-'));
const demo = demoServer();
const claude = mockClaude();
let browser;
try {
  const pageBase = await listen(demo);
  const apiBase = await listen(claude);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: true,
    userDataDir: path.join(scratch, 'profile'),
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const extId = await browser.installExtension(DIST);
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`), { timeout: 10_000 });
  const sw = await swTarget.worker();
  const setSync = (v) => sw.evaluate((x) => chrome.storage.sync.set(x), v);
  await sw.evaluate((base) => chrome.storage.local.set({ apiKey: 'sk-ant-demo-0000000000', apiBase: base }), apiBase);
  // A neutral person's settings: no personal dictionary, a short style note, Claude off for shot 1.
  await setSync({
    debugHooks: true, dictionary: [], styleNotes: '- Short and friendly.\n- Signs off with "Thanks,".',
    noSemicolons: true, noDashes: true, checkModel: 'claude-haiku-5-5', rewriteModel: 'claude-sonnet-5-5',
    aiMode: 'off', keyEpoch: Date.now(),
  });
  await sleep(500);
  for (const p of await browser.pages()) await p.close(); // the welcome tab

  const open = async (url) => {
    const page = await browser.newPage();
    await page.setViewport({ ...SHOT, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: 'load' });
    return page;
  };
  const snap = (page) => page.screenshot({ clip: { x: 0, y: 0, ...SHOT } });

  // 1. Local checks: underlines and a fix card, nothing sent anywhere.
  let page = await open(`${pageBase}/compose.html`);
  await typeMessage(page, LOCAL_TEXT);
  await waitFor(async () => Number((await hostData(page)).issues) >= 3, 15_000);
  await sleep(900);
  await clickWord(page, 'tomorow');
  await waitFor(() => ui(page, '.pm-card'));
  await sleep(300);
  await render(browser, framed(await snap(page), 'Fix mistakes as you type', 'Free checks that run on your computer. Nothing you type is sent anywhere.'), 1280, 800, 'screenshot-1.png');
  await page.close();

  // 2. Claude: the comma mistakes rule-based checkers miss.
  await setSync({ aiMode: 'auto' });
  await sleep(400);
  page = await open(`${pageBase}/compose.html`);
  await typeMessage(page, CLAUDE_TEXT);
  await waitFor(async () => Number((await hostData(page)).rewrites) === 1 && Number((await hostData(page)).claude) >= 2, 15_000);
  await sleep(900);
  await clickWord(page, ', it', 0.3);
  await waitFor(() => ui(page, '.pm-card .pm-src'));
  await sleep(300);
  await render(browser, framed(await snap(page), 'Catches the commas others miss', 'Add your own Claude key for comma splices, run-ons and the wrong word.'), 1280, 800, 'screenshot-2.png');

  // 3. A clearer version of a tangled sentence.
  await page.keyboard.press('Escape');
  await page.mouse.move(5, 5);
  await sleep(400);
  await clickWord(page, 'follow up on');
  await waitFor(() => ui(page, '.pm-card .pm-card-rw'));
  await sleep(300);
  await render(browser, framed(await snap(page), 'Clearer sentences in one click', 'Long or tangled? Get a clearer version that keeps every fact, name and number.'), 1280, 800, 'screenshot-3.png');

  // 4. Rewrite the whole message.
  await page.keyboard.press('Escape');
  await sleep(300);
  await clickUi(page, '.pm-badge');
  await waitFor(() => ui(page, '.pm-panel'));
  await clickUi(page, '.pm-panel .pm-btn', 'Friendlier');
  await waitFor(() => page.evaluate(() => [...document.querySelector('penmend-ui').shadowRoot.querySelectorAll('.pm-panel .pm-btn')].some((b) => b.textContent === 'Replace')), 10_000);
  await clickUi(page, '.pm-panel .pm-toggle', 'Show result only'); // the marked-up changes are busy at this size
  await page.mouse.move(5, 5);
  await sleep(400);
  await render(browser, framed(await snap(page), 'Rewrite the whole message', 'Improve, shorten, friendlier, more professional, or in your own style.'), 1280, 800, 'screenshot-4.png');
  await page.close();

  // 5. Settings: your key, your models, your daily limit, punctuation you don't use.
  page = await open(`chrome-extension://${extId}/options/options.html`);
  await sleep(800);
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    document.getElementById('claude')?.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -16);
  });
  await sleep(400);
  await render(browser, framed(await snap(page), 'Your key, your model, your limit', 'Bring your own Anthropic key, pick the model, and see the monthly cost up front.'), 1280, 800, 'screenshot-5.png');
  await page.close();

  // Promo tiles and the store icon (96 px artwork in a 128 px square, as the store asks).
  await render(browser, promo(440, 280), 440, 280, 'promo-small.png');
  await render(browser, promo(1400, 560), 1400, 560, 'promo-marquee.png');
  await render(browser, `<html><body style="margin:0;background:transparent"><div style="width:96px;height:96px;margin:16px">${ICON_SVG}</div></body></html>`,
    128, 128, 'icon-128.png', { transparent: true });
} finally {
  if (browser) await browser.close();
  demo.close();
  claude.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
