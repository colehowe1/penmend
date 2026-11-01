// Smoke test on real rich-text editors (public demo pages, so it needs the internet): type a
// sentence with mistakes, check the underlines, click one, take the fix, and check the editor
// really changed (each framework must accept the edit as its own).
//
//   node build.mjs && node test/e2e/editors.mjs [name ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.PM_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const step = (...a) => { if (process.env.PM_DEBUG) console.log(`   [${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a); };

// frame: a selector for an iframe holding the editor (TinyMCE-style editors live in one).
const EDITORS = [
  { name: 'ProseMirror', url: 'https://prosemirror.net/examples/basic/', sel: '.ProseMirror' },
  { name: 'Lexical', url: 'https://playground.lexical.dev/', sel: '.ContentEditable__root, [contenteditable="true"]' },
  { name: 'Slate', url: 'https://www.slatejs.org/examples/richtext', sel: '[data-slate-editor="true"]' },
  { name: 'Tiptap', url: 'https://tiptap.dev/docs/examples/basics/default-text-editor', sel: '.tiptap, .ProseMirror', frameUrl: /embed|demo|example/ },
  // Quill's own site nests its demos in frames; this local page loads the real Quill 2 from a CDN.
  { name: 'Quill', url: 'LOCAL/quill.html', sel: '.ql-editor' },
  { name: 'TinyMCE', url: 'https://www.tiny.cloud/docs/tinymce/latest/basic-example/', frame: 'iframe.tox-edit-area__iframe', sel: 'body#tinymce, body' },
  { name: 'CKEditor 5', url: 'https://ckeditor.com/docs/ckeditor5/latest/examples/builds/classic-editor.html', sel: '.ck-editor__editable' },
];

const only = process.argv.slice(2);
const results = [];
const shots = process.env.PM_E2E_SHOTS;

async function waitFor(fn, timeout = 10_000, every = 150) {
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

const hostData = (ctx) => ctx.evaluate(() => ({ ...(document.querySelector('penmend-ui')?.dataset || {}) }));
const painted = (ctx) => ctx.evaluate(() => {
  const h = CSS.highlights.get('pm-red');
  return h ? [...h].map((r) => r.toString()) : [];
});

/** Where a frame's viewport sits in the page, through any number of nested iframes. */
async function frameOffset(frame) {
  let x = 0;
  let y = 0;
  for (let f = frame; f && f.parentFrame(); f = f.parentFrame()) {
    const box = await (await f.frameElement())?.boundingBox();
    if (!box) break;
    const inner = await (await f.frameElement()).evaluate((el) => ({ l: el.clientLeft, t: el.clientTop }));
    x += box.x + inner.l;
    y += box.y + inner.t;
    // boundingBox() is already relative to the top page in Puppeteer: stop after the first hop.
    break;
  }
  return { x, y };
}

/** Finds the editor (in the page or one of its frames). */
async function findEditor(page, ed) {
  return waitFor(async () => {
    const contexts = ed.frame
      ? await Promise.all((await page.$$(ed.frame)).map((h) => h.contentFrame()))
      : [page.mainFrame(), ...page.frames().filter((f) => !ed.frameUrl || ed.frameUrl.test(f.url()))];
    for (const ctx of contexts.filter(Boolean)) {
      for (const sel of ed.sel.split(',').map((s) => s.trim())) {
        const handle = await ctx.$(sel).catch(() => null);
        if (handle && await handle.evaluate((e) => e.isContentEditable && e.getBoundingClientRect().height > 20)) return { ctx, sel, handle };
      }
    }
    return null;
  }, 20_000, 500);
}

async function run(browser, ed) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => { if (/penmend|pm-/i.test(e.stack || '')) errors.push(e.message); });
  try {
    await page.goto(ed.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    step(ed.name, 'loaded');
    const found = await findEditor(page, ed);
    step('found', Boolean(found), found?.sel);
    if (!found) return { name: ed.name, ok: false, detail: 'editor not found (site changed?)' };
    const { ctx, handle } = found;
    await handle.evaluate((e) => e.scrollIntoView({ block: 'center' }));
    step('scrolled');
    // A plain mouse click on the editor (ElementHandle.click() hangs on some pages).
    const { x: fx, y: fy } = await frameOffset(ctx);
    const eb = await handle.evaluate((e) => e.getBoundingClientRect().toJSON());
    await page.mouse.click(fx + eb.x + eb.width - 12, fy + eb.y + Math.min(eb.height - 8, 400));
    step('clicked');
    const typeSentence = async () => {
      await ctx.evaluate((e, atStart) => {
        e.focus();
        const sel = e.ownerDocument.getSelection();
        if (atStart) {
          const first = e.querySelector('p') || e;
          sel.selectAllChildren(first);
          sel.collapseToStart();
        } else {
          sel.selectAllChildren(e);
          sel.collapseToEnd();
        }
      }, handle, ed.at === 'start');
      step('caret placed');
      if (ed.at === 'start') {
        await page.keyboard.type('Their going to send it tomorow. ', { delay: 15 });
      } else {
        await page.keyboard.press('Enter');
        await page.keyboard.type('Their going to send it tomorow.', { delay: 15 });
      }
      return handle.evaluate((e) => e.innerText.includes('send it tomorow'));
    };
    // Demo pages sometimes move focus while they finish loading: if the keys didn't land, once more.
    if (!(await typeSentence()) && !(await typeSentence())) {
      return { name: ed.name, ok: false, detail: 'the typing never reached the editor (the page kept focus elsewhere)' };
    }
    step('typed');
    const words = await waitFor(async () => { const w = await painted(ctx); return w.includes('tomorow') && w; }, 12_000);
    if (!words) {
      if (shots) await page.screenshot({ path: path.join(shots, `editor-${ed.name.replace(/\W+/g, '')}-nounderline.png`) });
      const around = await handle.evaluate((e) => {
        const t = e.innerText;
        const i = t.indexOf('tomorow');
        return i < 0 ? `(not found) ...${t.slice(-80)}` : t.slice(Math.max(0, i - 50), i + 15);
      });
      const focus = await ctx.evaluate(() => `${document.activeElement?.tagName}.${String(document.activeElement?.className).slice(0, 40)}`);
      return { name: ed.name, ok: false, detail: `no underline; painted ${JSON.stringify(await painted(ctx))}; host ${JSON.stringify(await hostData(ctx))}; focus ${focus}; text ${JSON.stringify(around)}` };
    }
    const rect = await ctx.evaluate(() => {
      const r = [...CSS.highlights.get('pm-red')].find((x) => x.toString() === 'tomorow');
      return r.getBoundingClientRect().toJSON();
    });
    // Coordinates inside an iframe are relative to it; add the frame's offset.
    const { x: ox, y: oy } = await frameOffset(ctx);
    await page.mouse.click(ox + rect.x + rect.width / 2, oy + rect.y + rect.height / 2);
    const card = await waitFor(() => ctx.evaluate(() => {
      const b = [...(document.querySelector('penmend-ui')?.shadowRoot?.querySelectorAll('.pm-card .pm-sugg') || [])].find((x) => x.textContent === 'tomorrow');
      return b ? b.getBoundingClientRect().toJSON() : null;
    }), 4000);
    if (!card) {
      const hit = await ctx.evaluate((x, y) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')}` : 'nothing';
      }, rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (shots) await page.screenshot({ path: path.join(shots, `editor-${ed.name.replace(/\W+/g, '')}-noclick.png`) });
      return { name: ed.name, ok: false, detail: `underlined (${words.join(', ')}) but no card on click: ${(await hostData(ctx)).lastClick}; the click landed on ${hit}` };
    }
    await page.mouse.click(ox + card.x + card.width / 2, oy + card.y + card.height / 2);
    const fixed = await waitFor(async () => {
      const t = await handle.evaluate((e) => e.innerText);
      return t.includes('send it tomorrow.') && !t.includes('it tomorow');
    }, 4000);
    if (shots) await page.screenshot({ path: path.join(shots, `editor-${ed.name.replace(/\W+/g, '')}.png`) });
    const later = await sleep(800).then(() => handle.evaluate((e) => e.innerText));
    const kept = later.includes('send it tomorrow.');
    return {
      name: ed.name,
      ok: Boolean(fixed && kept && !errors.length),
      detail: `${words.join(', ')} → fix ${fixed ? 'applied' : 'NOT applied'}${fixed && !kept ? ', then reverted by the editor' : ''}${errors.length ? `; errors: ${errors.join(' | ')}` : ''}`,
    };
  } catch (e) {
    return { name: ed.name, ok: false, detail: e.message.split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

const fixtures = http.createServer((req, res) => {
  const file = path.join(ROOT, 'test/e2e/fixtures', path.basename(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(file));
});
await new Promise((r) => fixtures.listen(0, '127.0.0.1', r));
const LOCAL = `http://127.0.0.1:${fixtures.address().port}`;
for (const e of EDITORS) e.url = e.url.replace('LOCAL', LOCAL);

const scratch = fs.mkdtempSync(path.join(process.env.PM_E2E_TMP || os.tmpdir(), 'pm-editors-'));
let browser;
try {
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, pipe: true, enableExtensions: true, protocolTimeout: 30_000,
    userDataDir: path.join(scratch, 'profile'),
    args: ['--no-first-run', '--no-default-browser-check'], defaultViewport: { width: 1280, height: 900 },
  });
  const extId = await browser.installExtension(path.join(ROOT, 'dist-test'));
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}/`))).worker();
  await sw.evaluate(() => chrome.storage.sync.set({ debugHooks: true }));
  for (const ed of EDITORS.filter((e) => !only.length || only.includes(e.name))) {
    const r = await run(browser, ed);
    results.push(r);
    console.log(`${r.ok ? '✔' : '✖'} ${r.name}: ${r.detail}`);
  }
} finally {
  await browser?.close().catch(() => {});
  fixtures.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} editors passed`);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
