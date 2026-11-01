// The service worker: answers the page scripts (local lint, Claude checks and rewrites), owns the
// context menu and keyboard shortcuts, and keeps the API key away from web pages.
import { MSG, PORT_REWRITE } from '../shared/messaging.js';
import { loadSettings, normalizeSettings } from '../shared/settings.js';
import { REWRITE_MODES } from './prompts.js';
import * as harper from './harper.js';
import * as claude from './claude.js';
import * as budget from './budget.js';
import { menuBuilder } from './menus.js';

// The key and the usage meter: extension pages and this worker only, never content scripts.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })?.catch?.(() => {});

// A load that started before a settings change mustn't be cached after it (it could hold the old
// dictionary or style notes until the next change), so each change bumps the generation.
let settingsCache = null;
let settingsGen = 0;
async function settings() {
  if (settingsCache) return settingsCache;
  const gen = settingsGen;
  const loaded = await loadSettings();
  if (gen === settingsGen) settingsCache = loaded;
  return loaded;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') { settingsCache = null; settingsGen += 1; }
});

const MENU_ROOT = 'pm-root';
const MENU_MODES = ['improve', 'shorten', 'professional', 'friendly', 'simplify', 'fix', 'mine'];

const buildMenus = menuBuilder(chrome, () => [
  { id: MENU_ROOT, title: 'Rewrite with Penmend', contexts: ['selection'] },
  ...MENU_MODES.map((mode) => ({ id: `pm-${mode}`, parentId: MENU_ROOT, title: REWRITE_MODES[mode].label, contexts: ['selection'] })),
  { id: 'pm-custom', parentId: MENU_ROOT, title: 'Custom…', contexts: ['selection'] },
]);

/** A manifest match pattern ("https://docs.google.com/document/*") as a RegExp. */
function matchPattern(pattern) {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^$()|[\]{}\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Tabs that were open before an install or update don't have the (new) content script. Put it in,
 * so Penmend works there without a reload; a copy left over from the old version steps aside
 * when the new one says hello (content/index.js).
 */
async function injectIntoOpenTabs() {
  const manifest = chrome.runtime.getManifest();
  const { js, css, exclude_matches: excluded = [] } = manifest.content_scripts[0];
  const skip = excluded.map(matchPattern);
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || tab.discarded || skip.some((re) => re.test(tab.url || ''))) return;
    const target = { tabId: tab.id, allFrames: true };
    try {
      await chrome.scripting.insertCSS({ target, files: css });
      await chrome.scripting.executeScript({ target, files: js });
    } catch { /* a page we may not script (the Web Store, an error page) */ }
  }));
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  buildMenus();
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#welcome') });
  if (reason === 'install' || reason === 'update') injectIntoOpenTabs().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { buildMenus(); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id || !String(info.menuItemId).startsWith('pm-')) return;
  const mode = String(info.menuItemId).slice(3);
  chrome.tabs.sendMessage(tab.id, { type: MSG.REWRITE_SELECTION, mode, selectionText: info.selectionText || '' }, { frameId: info.frameId ?? 0 }).catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: MSG.COMMAND, command }).catch(() => {});
});

// Only Penmend's own pages (Settings, popup, pad) may ask these; web pages' content scripts can't.
const PAGES_ONLY = new Set([MSG.TEST_KEY, MSG.LEARN_STYLE, MSG.RULE_INFO, MSG.OPEN_PAD]);

function bad(message) {
  return new claude.FriendlyError(message, 'bad-request');
}

/** AI_CHECK's paragraphs: at most 20, each a short string, 12,000 characters in all. */
function checkParagraphs(paragraphs) {
  if (!Array.isArray(paragraphs) || !paragraphs.length || paragraphs.length > 20) throw bad('Too many paragraphs at once.');
  let total = 0;
  const out = paragraphs.map((p, i) => {
    const text = String(p?.text ?? '');
    if (text.length > 6_000) throw bad('A paragraph is too long.');
    total += text.length;
    return { id: i + 1, text, inProgress: Boolean(p?.inProgress) };
  });
  if (total > 12_000) throw bad('Too much text at once.');
  return out;
}

const handlers = {
  async [MSG.STATUS]() {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    return { hasApiKey: Boolean(apiKey) };
  },
  async [MSG.WARM]() {
    harper.warm(await settings());
    return {};
  },
  async [MSG.LINT]({ text }) {
    const t = String(text ?? '');
    if (t.length > 150_000) throw bad('This text is too long to check.');
    return { lints: await harper.lint(t, await settings()) };
  },
  async [MSG.AI_CHECK]({ paragraphs }) {
    const checked = checkParagraphs(paragraphs);
    await budget.guard();
    return { results: await claude.check(checked, await settings()) };
  },
  async [MSG.TEST_KEY]({ apiKey, model }) {
    await claude.testKey(apiKey, model);
    return {};
  },
  async [MSG.LEARN_STYLE]({ samples }) {
    await budget.guard();
    return { notes: await claude.learnStyle(String(samples ?? '').slice(0, 20_000), await settings()) };
  },
  async [MSG.RULE_INFO]() {
    return { descriptions: await harper.ruleDescriptions() };
  },
  async [MSG.OPEN_OPTIONS]({ section }) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`options/options.html${section ? `#${section}` : ''}`) });
    return {};
  },
  async [MSG.OPEN_PAD]() {
    await chrome.tabs.create({ url: chrome.runtime.getURL('pad/pad.html') });
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  if (PAGES_ONLY.has(msg.type) && !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) {
    sendResponse({ ok: false, error: 'Not available here.', code: 'bad-request' });
    return false;
  }
  handler(msg, sender).then(
    (result) => sendResponse({ ok: true, ...result }),
    (e) => {
      const err = claude.explainError(e);
      sendResponse({ ok: false, error: err.message, code: err.code });
    },
  );
  return true; // the reply comes later
});

// Rewrites stream over a port: { type: 'start', text, mode, instruction, before, after } in;
// { type: 'delta', text } ... then { type: 'done', text } or { type: 'error', error, code } out.
// Disconnecting the port cancels the request.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_REWRITE || port.sender?.id !== chrome.runtime.id) return;
  const controller = new AbortController();
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
    controller.abort();
  });
  const post = (m) => {
    if (open) port.postMessage(m);
  };
  let started = false;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'start' || started) return; // one rewrite per port
    started = true;
    try {
      const job = {
        text: String(msg.text ?? ''),
        mode: String(msg.mode ?? ''),
        instruction: String(msg.instruction ?? '').slice(0, 600),
        before: String(msg.before ?? '').slice(-1_200),
        after: String(msg.after ?? '').slice(0, 1_200),
      };
      if (!job.text.trim()) throw bad('Nothing to rewrite.');
      if (job.text.length > 20_000) throw bad('That is too much text to rewrite at once.');
      await budget.guard();
      const s = normalizeSettings(await settings());
      const text = await claude.rewrite(job, s, (delta) => post({ type: 'delta', text: delta }), controller.signal);
      post({ type: 'done', text });
    } catch (e) {
      const err = claude.explainError(e);
      if (err.code !== 'aborted') post({ type: 'error', error: err.message, code: err.code });
    }
  });
});
