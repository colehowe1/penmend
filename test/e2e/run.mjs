// End-to-end test: the built extension (dist/) in a real headless Chrome, on a local test page with
// every kind of text box, against a mock of the Claude API (no key, no cost).
//
//   npm run e2e            (builds first)
//   PM_E2E_KEEP=1 ...      keep the Chrome profile for inspection
//
// Uses the Chrome installed on this Mac over a CDP pipe (branded Chrome only loads unpacked
// extensions that way) and quits it with CDP Browser.close, so it leaves nothing behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist-test'); // the test build (npm run e2e builds it): honors debugHooks
const FIXTURES = path.join(ROOT, 'test/e2e/fixtures');
const CHROME = process.env.PM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  (${detail})` : ''}`);
}

async function waitFor(fn, timeout = 10_000, every = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not yet */ }
    await sleep(every);
  }
  return null;
}

// ---- Servers -------------------------------------------------------------------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function fixtureServer() {
  return http.createServer((req, res) => {
    const file = path.join(FIXTURES, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/$/, '/index.html'));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(file));
  });
}

// Sentence rewrites: a long sentence with a fix in it, one without, and Claude's clearer versions.
const LONG_FIXED = 'The store manager called this morning to say that the camera in the back room that we replaced last week is down again and they want someone out their today.';
const LONG_FIXED_REWRITE = 'The store manager called this morning. The back-room camera we replaced last week is down again, and they want someone out there today.';
const LONG_PLAIN = 'We should probably think about whether it would make sense to replace the whole system at some point next year instead of fixing each camera as it fails.';
const LONG_PLAIN_REWRITE = 'Next year, we should consider replacing the whole system instead of fixing each camera as it fails.';

// What the mock "Claude" finds, by the text it's shown.
const MOCK_EDITS = [
  { match: LONG_FIXED, edit: { find: 'out their today', replace: 'out there today', type: 'word_choice', why: 'Use "there" for a place.' } },
  { match: LONG_FIXED, edit: { find: LONG_FIXED, replace: LONG_FIXED_REWRITE, type: 'rewrite', why: 'Split into two shorter sentences.' } },
  { match: LONG_PLAIN, edit: { find: LONG_PLAIN, replace: LONG_PLAIN_REWRITE, type: 'rewrite', why: 'Shorter and to the point.' } },
  // A fix that brings in a semicolon: never shown while semicolons are switched off.
  { match: 'closed, we will', edit: { find: 'closed, we will', replace: 'closed; we will', type: 'punctuation', why: 'Comma splice.' } },
  { match: "camera's are", edit: { find: "camera's are", replace: 'cameras are', type: 'punctuation', why: 'Plural, not possessive.' } },
  { match: 'Me and him went', edit: { find: 'Me and him went', replace: 'He and I went', type: 'grammar', why: 'Use subject pronouns.' } },
  { match: 'in order to', edit: { find: 'in order to check', replace: 'to check', type: 'clarity', why: 'Shorter.' } },
];
export const MOCK_REWRITE = 'The cameras are down at the store. He and I went there to check.';
export const MOCK_SHORT = 'Short version.';
// Claude ignoring "no dashes, no semicolons": the extension cleans it up.
const MOCK_FRIENDLY = 'Good news — the cameras are back up; thanks for waiting.';

function mockClaude() {
  const requests = [];
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ url: req.url, headers: req.headers, body });
    const usage = { input_tokens: 420, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const user = String(body.messages?.[0]?.content ?? '');
    if (body.stream) {
      const text = /as short as possible/i.test(user) ? MOCK_SHORT : /warmer and friendlier/i.test(user) ? MOCK_FRIENDLY : MOCK_REWRITE;
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const piece of text.match(/.{1,12}/g)) {
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
        await sleep(25);
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    let text = 'OK';
    if (body.output_config?.format) {
      const edits = [];
      for (const m of user.matchAll(/<paragraph id="(\d+)"[^>]*>([\s\S]*?)<\/paragraph>/g)) {
        for (const { match, edit } of MOCK_EDITS) if (m[2].includes(match)) edits.push({ p: Number(m[1]), ...edit });
      }
      text = JSON.stringify({ edits });
    } else if (/<samples>/.test(user)) {
      text = '- Opens with "Hello,".\n- Very short.';
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({
      id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage,
    }));
  });
  return { server, requests };
}

// ---- Page helpers ----------------------------------------------------------------------------------

const hostData = (ctx) => ctx.evaluate(() => {
  const h = document.querySelector('penmend-ui');
  return h ? { ...h.dataset } : null;
});

/** Rects of the textarea overlay's underlined words. */
const overlaySpans = (ctx) => ctx.evaluate(() => [...(document.querySelector('penmend-ui')?.shadowRoot?.querySelectorAll('.pm-u') || [])]
  .map((s) => ({ text: s.textContent, cls: s.className, r: s.getBoundingClientRect().toJSON() })));

/** Clicks a button in our shadow UI by its text (a real mouse click, like a person). */
async function clickUi(page, selector, text, ctx = page) {
  const rect = await ctx.evaluate((sel, t) => {
    const root = document.querySelector('penmend-ui')?.shadowRoot;
    const el = [...(root?.querySelectorAll(sel) || [])].find((e) => !t || e.textContent.trim() === t);
    return el ? el.getBoundingClientRect().toJSON() : null;
  }, selector, text);
  if (!rect) return false;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return true;
}

const uiText = (ctx, selector) => ctx.evaluate((sel) => {
  const el = document.querySelector('penmend-ui')?.shadowRoot?.querySelector(sel);
  return el ? el.textContent : null;
}, selector);

/** Viewport rect of a word inside an element's text (rich editors). */
const wordRect = (ctx, selector, word) => ctx.evaluate((sel, w) => {
  const root = document.querySelector(sel);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.data.indexOf(w);
    if (i >= 0) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      return r.getBoundingClientRect().toJSON();
    }
  }
  return null;
}, selector, word);

/** Viewport rect of the first line of the textarea overlay's underline on exactly `text`. */
const spanFirstRect = (ctx, text) => ctx.evaluate((t) => {
  const span = [...(document.querySelector('penmend-ui')?.shadowRoot?.querySelectorAll('.pm-u') || [])].find((s) => s.textContent === t);
  return span ? span.getClientRects()[0].toJSON() : null;
}, text);

/** Viewport rect of a word inside a textarea, from a hidden copy with the same layout. */
const wordRectInTextarea = (page, selector, word) => page.evaluate((sel, w) => {
  const ta = document.querySelector(sel);
  const cs = getComputedStyle(ta);
  const r = ta.getBoundingClientRect();
  const div = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'whiteSpace', 'overflowWrap']) div.style[p] = cs[p];
  Object.assign(div.style, { position: 'fixed', left: `${r.left + ta.clientLeft}px`, top: `${r.top + ta.clientTop}px`, width: `${ta.clientWidth}px`, boxSizing: 'border-box', visibility: 'hidden' });
  const i = ta.value.indexOf(w);
  div.append(ta.value.slice(0, i));
  const span = document.createElement('span');
  span.textContent = w;
  div.append(span);
  document.body.append(div); // outside the dialog: its transform would move a fixed element
  const out = span.getBoundingClientRect().toJSON();
  div.remove();
  return out;
}, selector, word);

/** Empties a text box the way a person would (select all, delete), so the page sees input events. */
async function clearField(page, selector) {
  await page.click(selector);
  await page.evaluate(() => {
    document.execCommand('selectAll');
    document.execCommand('delete');
  });
}

const SHOTS = process.env.PM_E2E_SHOTS;
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// ---- The run ---------------------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(process.env.PM_E2E_TMP || os.tmpdir(), 'pm-e2e-'));
const fixtures = fixtureServer();
const claude = mockClaude();
const pageUrl = await listen(fixtures);
const apiBase = await listen(claude.server);
const errors = [];
let browser;

try {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: true,
    userDataDir: path.join(scratch, 'profile'),
    args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });
  const extId = await browser.installExtension(DIST);
  check('extension installs', /^[a-p]{32}$/.test(extId), extId);
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`), { timeout: 10_000 });
  let sw = await swTarget.worker();
  sw.on('console', (m) => { if (m.type() === 'error') errors.push(`sw: ${m.text()}`); });
  const ext = (p) => `chrome-extension://${extId}/${p}`;
  const setSync = (v) => sw.evaluate((x) => chrome.storage.sync.set(x), v);
  await setSync({ debugHooks: true }); // an open shadow root + data-* counts, for these checks

  // The install opens the welcome page.
  const welcome = await waitFor(async () => (await browser.pages()).find((p) => p.url().startsWith(ext('options/options.html'))), 5000);
  check('first install opens the welcome page', Boolean(welcome));

  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`page console: ${m.text()}`); });
  await page.goto(pageUrl, { waitUntil: 'load' });

  // 1. Plain textarea, local checks only.
  await page.click('#ta');
  const typedAt = Date.now();
  await page.keyboard.type('I will recieve teh report tomorow.');
  const first = await waitFor(async () => Number((await hostData(page))?.issues) >= 3 && Date.now(), 15_000);
  check('textarea: local checker underlines 3 mistakes', first, first ? `${first - typedAt} ms after typing started` : 'no underlines');
  const spans = await overlaySpans(page);
  check('textarea: underlines sit on the right words', ['recieve', 'teh', 'tomorow'].every((w) => spans.some((s) => s.text === w)), spans.map((s) => s.text).join(', '));
  const taRect = await page.$eval('#ta', (e) => e.getBoundingClientRect().toJSON());
  const span = spans.find((s) => s.text === 'recieve');
  check('textarea: overlay lines up with the text box', span && span.r.x > taRect.x && span.r.y > taRect.y && span.r.y < taRect.y + 50, span ? `${Math.round(span.r.x)},${Math.round(span.r.y)}` : '');
  check('textarea: Chrome\'s own squiggles turned off while checked', await page.$eval('#ta', (e) => e.getAttribute('spellcheck') === 'false' && e.hasAttribute('data-pm-spellcheck')));

  // 2. Click the word, take the fix.
  await page.mouse.click(span.r.x + span.r.width / 2, span.r.y + span.r.height / 2);
  const cardTitle = await waitFor(() => uiText(page, '.pm-card .pm-card-head'), 3000);
  check('textarea: clicking a word opens its card', cardTitle && /Spelling/.test(cardTitle), cardTitle || '');
  await shot(page, '0-card');
  await clickUi(page, '.pm-card .pm-sugg', 'receive');
  const fixed = await waitFor(async () => (await page.$eval('#ta', (e) => e.value)).includes('I will receive teh'), 3000);
  check('textarea: the fix is applied', fixed, await page.$eval('#ta', (e) => e.value));
  check('textarea: one fewer underline after fixing', await waitFor(async () => Number((await hostData(page)).issues) === 2, 3000));
  await page.evaluate(() => document.execCommand('undo'));
  check('textarea: Undo (Cmd+Z) undoes the fix', await waitFor(async () => (await page.$eval('#ta', (e) => e.value)).includes('recieve'), 2000));
  await waitFor(async () => (await hostData(page)).issues === '3', 3000);

  // 2b. Grammarly-style hover: rest the mouse on an underline and the card opens; move off, it closes.
  await page.keyboard.press('Escape');
  await sleep(1000); // hover cards wait until you've paused typing
  const hs = (await overlaySpans(page)).find((x) => x.text === 'tomorow');
  await page.mouse.move(hs.r.x + hs.r.width / 2, hs.r.y + hs.r.height / 2, { steps: 4 });
  const hovered = await waitFor(() => uiText(page, '.pm-card .pm-sugg'), 2500);
  check('hover: resting on an underline opens its card', hovered === 'tomorrow', hovered || 'no card');
  await page.mouse.move(taRect.x + taRect.width + 160, hs.r.y, { steps: 4 });
  check('hover: moving away closes it again', await waitFor(async () => !(await uiText(page, '.pm-card')), 2500));

  // 2c. A page script faking a click can't open (or press) anything.
  const fake = (await overlaySpans(page)).find((x) => x.text === 'teh');
  await page.evaluate(({ x, y }) => {
    document.getElementById('ta').dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }));
  }, { x: fake.r.x + 3, y: fake.r.y + 3 });
  await sleep(400);
  check("a page's fake click doesn't open a card", !(await uiText(page, '.pm-card')));

  // 3. Badge, panel, Fix all.
  const badge = await waitFor(() => page.evaluate(() => {
    const b = document.querySelector('penmend-ui').shadowRoot.querySelector('.pm-badge');
    return b && b.style.display !== 'none' ? b.textContent : null;
  }), 3000);
  const count = (await hostData(page)).issues;
  check('badge shows the issue count', badge === count && Number(count) >= 2, `badge: ${badge}, issues: ${count}`);
  await shot(page, '1-textarea-badge');
  await clickUi(page, '.pm-badge');
  check('badge opens the panel', await waitFor(() => uiText(page, '.pm-panel .pm-title'), 2000));
  check('panel lists the issues', (await page.evaluate(() => document.querySelector('penmend-ui').shadowRoot.querySelectorAll('.pm-item').length)) === Number(count));
  await shot(page, '2-panel');
  await page.$eval('#ta', (e) => { e.focus(); e.setSelectionRange(e.value.length, e.value.length); });
  await clickUi(page, '.pm-panel .pm-mini.go', 'Fix');
  const caretKept = await waitFor(() => page.$eval('#ta', (e) => !e.value.includes('recieve') && e.selectionStart === e.value.length), 3000);
  check('panel: a fix from the list leaves the caret where you were typing', caretKept, await page.$eval('#ta', (e) => `${e.value} | caret ${e.selectionStart}`));
  await waitFor(async () => Number((await hostData(page)).issues) === Number(count) - 1, 3000);
  await clickUi(page, '.pm-panel .pm-btn', `Fix all ${Number(count) - 1} errors`);
  const allFixed = await waitFor(async () => (await page.$eval('#ta', (e) => e.value)) === 'I will receive the report tomorrow.', 3000);
  check('panel: Fix all fixes everything', allFixed, await page.$eval('#ta', (e) => e.value));
  check('panel: all clear after Fix all', await waitFor(async () => (await hostData(page)).issues === '0', 3000));
  await page.keyboard.press('Escape');

  // 3b. A page script setting the text (no input event) is noticed; clearing it clears the underlines.
  await page.$eval('#ta', (e) => { e.value = 'Teh new text from a script.'; });
  check('text set by a page script gets checked too', await waitFor(async () => (await overlaySpans(page)).some((x) => x.text === 'Teh'), 4000));
  await page.$eval('#ta', (e) => { e.value = ''; });
  check('clearing a box from a script clears its underlines', await waitFor(async () => !(await overlaySpans(page)).length, 4000));

  // 3c. Typing a character and deleting it again right next to an underline: the underline comes back.
  await page.click('#ta');
  await page.keyboard.type('See you tomorow');
  await waitFor(async () => (await overlaySpans(page)).some((x) => x.text === 'tomorow'), 6000);
  await page.keyboard.type('!');
  await page.keyboard.press('Backspace');
  await sleep(900);
  check('typing and deleting a character keeps the underline', (await overlaySpans(page)).some((x) => x.text === 'tomorow'));
  await clearField(page, '#ta');

  // 3d. A textarea inside a web component (a shadow root) gets underlines and cards too.
  const inner = await page.evaluateHandle(() => document.getElementById('xbox').shadowRoot.getElementById('inner'));
  await inner.click();
  await page.keyboard.type('Plese send the reprot.');
  const shadowSpan = await waitFor(async () => (await overlaySpans(page)).find((x) => x.text === 'reprot' && x.r.width > 0), 6000);
  check('a textarea inside a web component shows its underlines', shadowSpan, shadowSpan ? `${Math.round(shadowSpan.r.x)},${Math.round(shadowSpan.r.y)}` : 'no visible underline');
  if (shadowSpan) {
    await page.mouse.click(shadowSpan.r.x + shadowSpan.r.width / 2, shadowSpan.r.y + shadowSpan.r.height / 2);
    check('...and its cards open', await waitFor(() => uiText(page, '.pm-card .pm-sugg'), 2500));
    await page.keyboard.press('Escape');
  }
  await page.$eval('#xbox', (x) => { x.shadowRoot.getElementById('inner').value = ''; });

  // 4. Rich editor (contenteditable), local checks.
  await page.click('#ce');
  await page.keyboard.type('Their going to the store tomorow.');
  const painted = () => page.evaluate(() => {
    const h = CSS.highlights.get('pm-red');
    return h ? [...h].map((r) => r.toString()) : [];
  });
  const hl = await waitFor(async () => { const words = await painted(); return words.includes('tomorow') && words; }, 8000);
  check('rich editor: underlines are painted on the words', hl && hl.includes('Their'), (hl || await painted()).join(', '));
  const wr = await wordRect(page, '#ce', 'tomorow');
  await page.mouse.click(wr.x + wr.width / 2, wr.y + wr.height / 2);
  check('rich editor: clicking an underlined word opens its card', await waitFor(() => uiText(page, '.pm-card'), 3000));
  await clickUi(page, '.pm-card .pm-sugg', 'tomorrow');
  const ceFixed = await waitFor(async () => (await page.$eval('#ce', (e) => e.innerText)).includes('store tomorrow.'), 3000);
  check('rich editor: the fix is applied', ceFixed, await page.$eval('#ce', (e) => e.innerText));

  // 5. Boxes that must be left alone, and quoted replies.
  await sleep(1200); // let the rich editor's re-check after the fix settle
  const before = Number((await hostData(page)).issues);
  await page.click('#code');
  await page.keyboard.type('teh codez arr hear');
  await page.click('#gramm');
  await page.keyboard.type('teh codez arr hear');
  await sleep(1500);
  check('leaves spellcheck=false and data-gramm=false boxes alone', Number((await hostData(page)).issues) === before);
  const quoted = await wordRect(page, '#reply', 'New');
  await page.mouse.click(quoted.x + 2, quoted.y + quoted.height / 2);
  await sleep(1200);
  check('ignores quoted replies (the "teh" in a Gmail-style quote)', Number((await hostData(page)).issues) === before);
  const outlook = await wordRect(page, '#outlook', 'Thanks');
  await page.mouse.click(outlook.x + 2, outlook.y + outlook.height / 2);
  await sleep(1200);
  check('ignores the signature and the message being replied to (Outlook-style)', Number((await hostData(page)).issues) === before,
    `${(await hostData(page)).issues} vs ${before}`);

  // 5b. A text box in a modal dialog centered with a transform (the top layer, a moved origin).
  await page.evaluate(() => document.getElementById('dlg').showModal());
  await page.click('#dta');
  await page.keyboard.type('Plese check this.');
  const inDialog = await waitFor(async () => (await page.evaluate(() => {
    const host = document.querySelector('#dlg penmend-ui');
    return host ? [...host.shadowRoot.querySelectorAll('.pm-u')].map((u) => ({ t: u.textContent, r: u.getBoundingClientRect().toJSON() })) : [];
  })).find((u) => u.t === 'Plese'), 8000);
  const wordInDialog = await wordRectInTextarea(page, '#dta', 'Plese');
  check('dialog: underline drawn inside the modal dialog, on the word', inDialog && wordInDialog
    && Math.abs(inDialog.r.x - wordInDialog.x) < 3 && Math.abs(inDialog.r.y - wordInDialog.y) < 6,
  inDialog ? `underline at ${Math.round(inDialog.r.x)},${Math.round(inDialog.r.y)}; word at ${Math.round(wordInDialog?.x)},${Math.round(wordInDialog?.y)}` : 'no underline');
  if (inDialog) {
    await page.mouse.click(inDialog.r.x + inDialog.r.width / 2, inDialog.r.y + inDialog.r.height / 2);
    const cardBox = await waitFor(() => page.evaluate(() => document.querySelector('#dlg penmend-ui')?.shadowRoot.querySelector('.pm-card')?.getBoundingClientRect().toJSON()), 3000);
    check('dialog: the card opens right under the word', cardBox && Math.abs(cardBox.y - (inDialog.r.y + inDialog.r.height)) < 14 && Math.abs(cardBox.x - inDialog.r.x) < 40,
      cardBox ? `card at ${Math.round(cardBox.x)},${Math.round(cardBox.y)}` : 'no card');
    const whole = await page.evaluate(() => {
      const card = document.querySelector('#dlg penmend-ui').shadowRoot.querySelector('.pm-card');
      const r = card.getBoundingClientRect();
      const d = document.getElementById('dlg').getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 20, r.bottom - 12); // the card's bottom row
      return { past: r.bottom > d.bottom, ours: hit?.localName === 'penmend-ui' };
    });
    check("dialog: the card isn't cut off by the dialog's edge", whole.ours, JSON.stringify(whole));
  }
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.getElementById('dlg').close());

  // 6. Editor inside an iframe.
  const frame = page.frames().find((f) => f.url() === 'about:srcdoc');
  await frame.click('body');
  await page.keyboard.type('We has a meeting tomorow.');
  check('iframe editor: checked too', await waitFor(async () => Number((await hostData(frame))?.issues) >= 2, 8000), JSON.stringify(await hostData(frame)));

  // 7. Add to dictionary.
  await clearField(page, '#ta');
  await page.keyboard.type('Ask Zorblatt about it.');
  await waitFor(async () => (await overlaySpans(page)).some((s) => s.text === 'Zorblatt'), 6000);
  const z = (await overlaySpans(page)).find((s) => s.text === 'Zorblatt');
  if (z) {
    await page.mouse.click(z.r.x + z.r.width / 2, z.r.y + z.r.height / 2);
    await waitFor(() => uiText(page, '.pm-card'), 2000);
    await clickUi(page, '.pm-card .pm-link', 'Add to dictionary');
  }
  check('Add to dictionary: the word stops being flagged', z && await waitFor(async () => !(await overlaySpans(page)).some((s) => s.text === 'Zorblatt'), 4000));
  const dict = await sw.evaluate(() => chrome.storage.sync.get('dictionary'));
  check('Add to dictionary: saved in settings', dict.dictionary?.includes('Zorblatt'));

  // 8. Claude checks (mock).
  await setSync({ styleNotes: '- Emails start with "Hello," on its own line, then a blank line, then the body.' });
  await sw.evaluate((base) => chrome.storage.local.set({ apiKey: 'sk-ant-test-key', apiBase: base }), apiBase);
  await setSync({ keyEpoch: Date.now(), checkModel: 'claude-haiku-5-5', rewriteModel: 'claude-sonnet-5-5', aiMode: 'auto' });
  await sleep(400);
  const checks = () => claude.requests.filter((r) => r.body.output_config?.format);
  // Text a page puts in a box by itself costs nothing: Claude waits until you type there.
  await page.$eval('#ta2', (e) => { e.focus(); e.value = "The camera's are down at the store. Me and him went there in order to check."; });
  await page.evaluate(() => document.execCommand('insertText', false, ' Me and him went there in order to check.'));
  await sleep(3500);
  // (Boxes you did type in earlier are checked now that Claude is on; this one never was typed in.)
  const sentPageText = claude.requests.some((r) => JSON.stringify(r.body).includes('Me and him went'));
  check("Claude doesn't check text a page put in a box you didn't type in (no surprise costs)", !sentPageText, `${checks().length} checks of other boxes`);
  await page.$eval('#ta2', (e) => { e.value = ''; e.blur(); });
  await clearField(page, '#ta');
  await page.keyboard.type("The camera's are down at the store. Me and him went there in order to check.");
  const fromClaude = await waitFor(async () => Number((await hostData(page)).claude) >= 3, 10_000);
  check('Claude: its findings appear after a pause in typing', fromClaude, JSON.stringify(await hostData(page)));
  const checkReq = claude.requests.find((r) => r.body.output_config?.format);
  check('Claude check: right model, key and API version', checkReq && checkReq.body.model === 'claude-haiku-5-5'
    && (checkReq.headers.authorization === 'Bearer sk-ant-test-key' || checkReq.headers['x-api-key'] === 'sk-ant-test-key')
    && checkReq.headers['anthropic-version'] === '2026-10-21',
  checkReq ? `${checkReq.body.model}, version ${checkReq.headers['anthropic-version']}, key ${checkReq.headers['x-api-key']}, auth ${checkReq.headers.authorization}` : 'no request');
  const sys = JSON.stringify(checkReq?.body.system || '');
  check('Claude check: prompt carries dictionary and style notes', sys.includes('<dictionary>Zorblatt</dictionary>') && sys.includes('Hello,'),
    `dictionary ${sys.includes('Zorblatt')}, style ${sys.includes('Hello,')}`);
  check('Claude check: Haiku gets no fallback parameter', checkReq && !checkReq.body.fallbacks && !String(checkReq.headers['anthropic-beta'] || '').includes('fallback'));
  check('Claude check: no sampling parameters sent', checkReq && !('temperature' in checkReq.body) && !('top_p' in checkReq.body));
  const blues = (await overlaySpans(page)).filter((s) => s.cls.includes('blue')).map((s) => s.text);
  check('Claude: clarity findings are blue', blues.some((t) => t.startsWith('in order')), blues.join(', '));
  await shot(page, '3-claude');
  const cs = (await overlaySpans(page)).find((s) => s.text === "camera's");
  if (cs) {
    await page.mouse.click(cs.r.x + cs.r.width / 2, cs.r.y + cs.r.height / 2);
    const src = await waitFor(() => uiText(page, '.pm-card .pm-src'), 2000);
    check('Claude: its card says "Claude" and gives the fix', src === 'Claude' && (await uiText(page, '.pm-card .pm-sugg')) === 'cameras', src || '');
    await clickUi(page, '.pm-card .pm-sugg', 'cameras');
    await waitFor(async () => (await page.$eval('#ta', (e) => e.value)).startsWith('The cameras are'), 2000);
  } else {
    check('Claude: its card says "Claude" and gives the fix', false, "no underline on camera's");
  }
  const checksBefore = claude.requests.filter((r) => r.body.output_config?.format).length;
  await sleep(2500);
  const checksAfter = claude.requests.filter((r) => r.body.output_config?.format).length;
  check('Claude: fixing one finding keeps the others without a new check', checksAfter === checksBefore && Number((await hostData(page)).claude) >= 2,
    `${checksAfter - checksBefore} extra checks, ${(await hostData(page)).claude} Claude findings`);
  const keep = await page.$eval('#ta', (e) => e.value);
  await page.$eval('#ta', (e) => { e.focus(); e.setSelectionRange(e.value.length, e.value.length); });
  await page.keyboard.type('\nThe NVR password is Bosch1234! for the admin account.');
  await sleep(3500);
  check('Claude never gets a paragraph that looks like it holds a password',
    !claude.requests.some((r) => JSON.stringify(r.body).includes('Bosch1234')));

  // An editor that types for itself (CKEditor-style: no 'input' events): automatic checks still run.
  const checksBeforeCk = checks().length;
  await page.click('#ck');
  await page.keyboard.type("The camera's are down again.");
  check('automatic Claude checks also work in editors that handle typing themselves',
    await waitFor(() => claude.requests.some((r) => r.body.output_config?.format && JSON.stringify(r.body).includes('down again')), 8000),
    `${checks().length - checksBeforeCk} new checks`);

  // Sentence rewrites. A hard-to-read sentence with nothing else to fix is underlined in blue as a
  // whole; one with a fix in it shows just the fix, whose card offers the rewrite.
  await clearField(page, '#ta');
  await page.keyboard.type(`${LONG_FIXED} ${LONG_PLAIN}`);
  check('rewrites: Claude offers clearer versions of two hard-to-read sentences',
    await waitFor(async () => (await hostData(page)).rewrites === '2', 10_000), JSON.stringify(await hostData(page)));
  const spansNow = await overlaySpans(page);
  check('rewrites: a sentence with nothing else to fix is underlined in blue as a whole',
    spansNow.some((x) => x.text === LONG_PLAIN && x.cls.includes('blue')), spansNow.map((x) => x.text).join(' | '));
  check('rewrites: a sentence with a fix in it shows just the fix', !spansNow.some((x) => x.text === LONG_FIXED) && spansNow.some((x) => x.text === 'their'));
  const theirRect = await spanFirstRect(page, 'their');
  if (theirRect) await page.mouse.click(theirRect.x + theirRect.width / 2, theirRect.y + theirRect.height / 2);
  check('rewrites: that fix\'s card offers "Rewrite the whole sentence"', await waitFor(() => uiText(page, '.pm-card .pm-rw-link'), 2500));
  await clickUi(page, '.pm-card .pm-rw-link');
  const rwShown = await waitFor(() => uiText(page, '.pm-card .pm-card-rw'), 2500);
  check('rewrites: ...which opens the rewrite card with the new sentence', rwShown === LONG_FIXED_REWRITE, rwShown || 'no rewrite card');
  const checksBeforeUse = checks().length;
  await clickUi(page, '.pm-card .pm-sugg', 'Use this version');
  check('rewrites: "Use this version" puts it in the text',
    await waitFor(async () => (await page.$eval('#ta', (e) => e.value)) === `${LONG_FIXED_REWRITE} ${LONG_PLAIN}`, 2500), await page.$eval('#ta', (e) => e.value));
  const plainRect = await waitFor(() => spanFirstRect(page, LONG_PLAIN), 3000);
  check('rewrites: the other sentence keeps its rewrite, without a new check', plainRect && checks().length === checksBeforeUse,
    `${checks().length - checksBeforeUse} new checks`);
  await sleep(700); // hover cards wait a moment after typing
  if (plainRect) await page.mouse.click(plainRect.x + 20, plainRect.y + plainRect.height / 2);
  const plainCard = await waitFor(() => uiText(page, '.pm-card .pm-card-rw'), 2500);
  check('rewrites: clicking the blue sentence opens its rewrite', plainCard === LONG_PLAIN_REWRITE, plainCard || 'no card');
  await clickUi(page, '.pm-card .pm-sugg', 'Use this version');
  check('rewrites: ...and it goes in too',
    await waitFor(async () => (await page.$eval('#ta', (e) => e.value)) === `${LONG_FIXED_REWRITE} ${LONG_PLAIN_REWRITE}`, 2500), await page.$eval('#ta', (e) => e.value));

  // Punctuation the author doesn't use (switched on here; the public defaults leave them off).
  await setSync({ noSemicolons: true, noDashes: true });
  await clearField(page, '#ta');
  await page.keyboard.type('The store is closed, we will go tomorrow morning instead.');
  await waitFor(() => checks().some((r) => JSON.stringify(r.body).includes('closed, we will')), 8000);
  await sleep(800);
  check('no semicolons: a fix that brings one in is never shown', !(await overlaySpans(page)).some((x) => x.text === ','),
    (await overlaySpans(page)).map((x) => x.text).join(' | '));
  const sysLatest = JSON.stringify(checks().at(-1)?.body.system || '');
  check('no semicolons or dashes: the check prompt says so', sysLatest.includes('never uses semicolons or dashes'));
  await setSync({ noSemicolons: false });
  check('...and it shows once semicolons are allowed again', await waitFor(async () => (await overlaySpans(page)).some((x) => x.text === ','), 3000));
  await setSync({ noSemicolons: true });
  await sleep(300);

  // Fix all leaves a sentence's rewrite in place (it already has the fixes in it), with no new check.
  await clearField(page, '#ta');
  await page.keyboard.type(`${LONG_FIXED} Thanks for teh help.`);
  await waitFor(async () => (await hostData(page)).rewrites === '1' && (await overlaySpans(page)).some((x) => x.text === 'teh'), 10_000);
  await clickUi(page, '.pm-badge');
  await waitFor(() => uiText(page, '.pm-panel'), 2000);
  const fixAllShown = await clickUi(page, '.pm-panel .pm-btn', 'Fix all 2 errors');
  const checksBeforeFixAll = checks().length;
  const fixedAll = await waitFor(async () => (await page.$eval('#ta', (e) => e.value)) === `${LONG_FIXED.replace('their', 'there')} Thanks for the help.`, 3000);
  const keptRw = await waitFor(async () => (await overlaySpans(page)).some((x) => x.text === LONG_FIXED.replace('their', 'there') && x.cls.includes('blue')), 3000);
  check('rewrites: Fix all keeps the sentence\'s rewrite, without a new check', fixAllShown && fixedAll && keptRw && checks().length === checksBeforeFixAll,
    `${fixAllShown ? '' : 'no Fix all button; '}${await page.$eval('#ta', (e) => e.value)} | ${(await overlaySpans(page)).map((x) => x.text).join(' | ')}`);
  await page.keyboard.press('Escape');
  await sleep(300);

  // The daily limit, enforced by the extension's own worker.
  await sw.evaluate(() => chrome.storage.local.set({ budget: { dailyDollars: 0.0000001 } }));
  await setSync({ keyEpoch: Date.now() });
  await sleep(300);
  const n = checks().length;
  await page.click('#ck');
  await page.keyboard.type(' Me and him went to fix it.');
  await sleep(3500);
  check("the daily limit stops Claude (no request goes out)", checks().length === n, `${checks().length - n} requests`);
  await sw.evaluate(() => chrome.storage.local.remove('budget'));
  await setSync({ keyEpoch: Date.now() });
  await clearField(page, '#ta');
  await page.keyboard.type(keep);
  await sleep(2500);

  // 9. Rewrite the whole text from the panel (Sonnet: fallback opted in, streamed).
  await page.click('#ta');
  await clickUi(page, '.pm-badge');
  await waitFor(() => uiText(page, '.pm-panel'), 2000);
  await clickUi(page, '.pm-panel .pm-btn', 'Improve');
  const rewritten = await waitFor(() => page.evaluate(() => {
    const root = document.querySelector('penmend-ui').shadowRoot;
    return [...root.querySelectorAll('.pm-panel .pm-btn')].some((b) => b.textContent === 'Replace');
  }), 8000);
  check('rewrite: Claude\'s version streams in with Replace/Copy', rewritten);
  const rwReq = claude.requests.find((r) => r.body.stream);
  check('rewrite: Sonnet request opts into the server-side fallback', rwReq && rwReq.body.fallbacks === 'default'
    && String(rwReq.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), rwReq ? String(rwReq.headers['anthropic-beta']) : 'no request');
  await shot(page, '4-rewrite');
  check('rewrite: changes are marked up', await page.evaluate(() => document.querySelector('penmend-ui').shadowRoot.querySelectorAll('.pm-rw-text ins, .pm-rw-text del').length > 0));
  // Typing in the box after the rewrite started: Replace must not throw that edit away.
  await page.$eval('#ta', (e) => { e.focus(); e.setSelectionRange(e.value.length, e.value.length); });
  await page.keyboard.type(' Extra');
  await sleep(700);
  await clickUi(page, '.pm-panel .pm-btn', 'Replace');
  const refused = await waitFor(async () => /changed/.test(await uiText(page, '.pm-panel .pm-note') || ''), 2000);
  check('rewrite: Replace refuses if you edited the text meanwhile', refused && (await page.$eval('#ta', (e) => e.value)).endsWith(' Extra'));
  await page.keyboard.press('Backspace', { delay: 10 });
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await sleep(700);
  await clickUi(page, '.pm-panel .pm-btn', 'Replace');
  check('rewrite: Replace puts it in the text box', await waitFor(async () => (await page.$eval('#ta', (e) => e.value)) === 'The cameras are down at the store. He and I went there to check.', 3000), await page.$eval('#ta', (e) => e.value));

  // A rewrite that ignores "no dashes, no semicolons" comes back without them.
  await page.click('#ta');
  await clickUi(page, '.pm-badge');
  await waitFor(() => uiText(page, '.pm-panel'), 2000);
  await clickUi(page, '.pm-panel .pm-btn', 'Friendlier');
  const friendly = await waitFor(() => page.evaluate(() => {
    const root = document.querySelector('penmend-ui').shadowRoot;
    const done = [...root.querySelectorAll('.pm-panel .pm-btn')].some((b) => b.textContent === 'Replace');
    const out = done ? root.querySelector('.pm-panel .pm-rw-text')?.cloneNode(true) : null;
    out?.querySelectorAll('del').forEach((d) => d.remove()); // the result as it would go in
    return out ? out.textContent : null;
  }), 8000);
  check('rewrite: dashes and semicolons Claude adds are taken out', friendly === 'Good news, the cameras are back up. Thanks for waiting.', friendly || 'no result');
  await page.keyboard.press('Escape');
  await sleep(300);

  // 10. Rewrite a selection from the right-click menu (the service worker's message).
  await page.click('#ce');
  await page.evaluate(() => {
    const ce = document.getElementById('ce');
    const r = document.createRange();
    r.selectNodeContents(ce);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  const tabUrls = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    // Only the tab with the selection acts; tabs without our content script just reject.
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'rewrite-selection', mode: 'shorten' }, { frameId: 0 }).catch(() => {})));
    return tabs.map((t) => t.url ?? '(no url)');
  });
  console.log(`   tabs as the service worker sees them: ${tabUrls.join(', ')}`);
  const menuReady = await waitFor(() => page.evaluate(() => [...document.querySelector('penmend-ui').shadowRoot.querySelectorAll('.pm-menu .pm-btn')].some((b) => b.textContent === 'Replace')), 8000);
  check('selection: right-click "Shorten" rewrites just the selection', menuReady);
  await shot(page, '5-selection');
  await clickUi(page, '.pm-menu .pm-btn', 'Replace');
  check('selection: Replace swaps the selected text', await waitFor(async () => (await page.$eval('#ce', (e) => e.innerText.trim())) === 'Short version.', 3000), await page.$eval('#ce', (e) => e.innerText));

  // 11. Turn it off for the site: everything comes off the page.
  await setSync({ disabledSites: ['127.0.0.1'] });
  check('turning a site off removes the underlines', await waitFor(async () => (await hostData(page)).issues === '0', 3000));
  check('turning a site off restores Chrome\'s own spellcheck', await page.$eval('#ta', (e) => !e.hasAttribute('data-pm-spellcheck') && e.getAttribute('spellcheck') !== 'false'));
  await setSync({ disabledSites: [] });

  // 12. Extension pages: settings, popup, writing pad.
  const opts = await browser.newPage();
  opts.on('pageerror', (e) => errors.push(`options: ${e.message}`));
  await opts.goto(ext('options/options.html'), { waitUntil: 'load' });
  check('settings page: model choices render', await waitFor(() => opts.$$eval('.model', (m) => m.length === 6), 3000));
  await shot(opts, '6-settings');
  check('settings page: shows the monthly estimate', /a month/.test(await opts.$eval('#estimate', (e) => e.textContent)), await opts.$eval('#estimate', (e) => e.textContent));
  await opts.click('.learn summary');
  await opts.type('#samples', 'Hello,\n\nThe cameras are back up. Let me know if you see anything else.\n\nHello,\n\nStore 12 is fixed.');
  await opts.click('#learn');
  check('settings: "Describe my style" returns notes', await waitFor(async () => !(await opts.$eval('#learned', (e) => e.hidden)), 5000));
  await opts.click('#learn-replace');
  check('settings: learned style is saved', await waitFor(async () => (await sw.evaluate(() => chrome.storage.sync.get('styleNotes'))).styleNotes.includes('Very short'), 3000));
  const usage = await sw.evaluate(() => chrome.storage.local.get('usage'));
  check('usage meter counts Claude calls', (usage.usage?.kinds?.check || 0) >= 1 && (usage.usage?.kinds?.rewrite || 0) >= 2, JSON.stringify(usage.usage?.kinds));
  const pageCanReadKey = await page.evaluate(() => typeof chrome !== 'undefined' && !!chrome.storage);
  check('web page itself has no chrome.storage access', !pageCanReadKey);

  const popup = await browser.newPage();
  popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
  await popup.goto(ext('popup/popup.html'), { waitUntil: 'load' });
  await popup.setViewport({ width: 320, height: 420 });
  await shot(popup, '7-popup');
  check('popup renders Claude status', await waitFor(async () => /Haiku/.test(await popup.$eval('#claude-status', (e) => e.textContent)), 3000), await popup.$eval('#claude-status', (e) => e.textContent));

  await setSync({ aiMode: 'off' });
  const pad = await browser.newPage();
  pad.on('pageerror', (e) => errors.push(`pad: ${e.message}`));
  await pad.goto(ext('pad/pad.html'), { waitUntil: 'load' });
  await pad.click('#editor');
  await pad.keyboard.type('This is teh writing pad.');
  check('writing pad: checks as you type', await waitFor(async () => Number((await hostData(pad))?.issues) >= 1, 8000));
  await shot(pad, '8-pad');

  // 12b. A page can't switch Penmend off by faking the update handshake.
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('penmend-hello')));
  await clearField(page, '#ta');
  await page.keyboard.type('Still cheking.');
  check("a page faking the update handshake can't switch it off", await waitFor(async () => (await overlaySpans(page)).some((x) => x.text === 'cheking'), 6000));

  // 13. An update while a tab is open: the new version takes the tab over by itself, no reload.
  await page.bringToFront();
  await clearField(page, '#ta');
  await page.keyboard.type('Teh old copy.');
  await waitFor(async () => Number((await hostData(page)).issues) >= 1, 6000);
  const oldBuild = (await hostData(page)).build;
  execFileSync('node', ['build.mjs', '--test'], { cwd: ROOT, stdio: 'ignore' }); // a new build in dist-test/
  const nextWorker = new Promise((resolve) => browser.on('targetcreated', (t) => {
    if (t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`)) resolve(t);
  }));
  await browser.installExtension(DIST); // loading the same folder again is an update
  sw = await (await nextWorker).worker();
  const builds = await waitFor(async () => {
    const b = await page.evaluate(() => [...document.querySelectorAll('penmend-ui')].map((h) => h.dataset.build));
    return b.length === 1 && b[0] && b[0] !== oldBuild && b;
  }, 10_000);
  check('an update hands open tabs to the new version (the old copy steps aside)', builds, `${oldBuild} -> ${builds?.[0]}`);
  await page.click('#ta');
  await page.keyboard.type(' And teh new one.');
  check('...and the new version checks as you type', await waitFor(async () => (await overlaySpans(page)).some((x) => x.text === 'teh'), 8000));

  // Normal use (no debug hooks): the page can't see inside Penmend's UI.
  await setSync({ debugHooks: false, aiMode: 'off' });
  await page.bringToFront();
  await page.reload({ waitUntil: 'load' });
  await page.click('#ta');
  await page.keyboard.type('Teh end.');
  await sleep(1500);
  check("normal use: the page can't look inside Penmend's UI", await page.evaluate(() => {
    const host = document.querySelector('penmend-ui');
    return Boolean(host) && host.shadowRoot === null && !('issues' in host.dataset);
  }));

  check('no errors in pages or the service worker', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  check('run finished', false, e.stack || String(e));
} finally {
  await browser?.close().catch(() => {});
  fixtures.close();
  claude.server.close();
  if (!process.env.PM_E2E_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
