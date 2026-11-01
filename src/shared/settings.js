// Settings live in chrome.storage.sync: small, not secret, readable by content scripts, and they
// follow the Chrome profile to other computers. The API key and the usage meter live in
// chrome.storage.local, which the service worker restricts to extension pages (never content
// scripts). Whether this computer has a key is asked of the service worker (MSG.STATUS), since the
// key itself doesn't sync; `keyEpoch` changes whenever a key is saved or removed, so every page
// asks again.
import { SEED_DICTIONARY, SEED_STYLE, SEED_PUNCTUATION } from './seed.js';

export const DEFAULTS = Object.freeze({
  enabled: true,
  disabledSites: [],
  dialect: 'American',
  categories: { spelling: true, grammar: true, punctuation: true, style: true },
  ignoreAllCaps: true,
  nativeSpellcheckOff: true,
  checkInputs: false,
  selectionButton: true,
  hoverCards: true,
  dictionary: SEED_DICTIONARY,
  disabledRules: [],
  neverFlag: [],
  aiMode: 'auto', // 'auto' (when you pause typing) | 'manual' (only when you click) | 'off'
  checkModel: '', // '' until chosen in Settings: no Claude calls before that
  rewriteModel: '',
  keyEpoch: 0,
  useStyle: true,
  styleNotes: SEED_STYLE,
  rewriteSuggestions: true, // Claude may offer a clearer version of a hard-to-read sentence
  noSemicolons: SEED_PUNCTUATION.noSemicolons, // never suggest a semicolon, in checks or rewrites
  noDashes: SEED_PUNCTUATION.noDashes, // never suggest a dash (— – --)
  debugHooks: false, // honored only by the test build (npm run e2e): an open shadow root, data-* counts
});

export const DIALECTS = ['American', 'British', 'Canadian', 'Australian', 'Indian'];
export const MAX_STYLE_CHARS = 2000;
// chrome.storage.sync holds at most 8 KB per setting, so the lists stay well under that.
export const MAX_WORDS = 600;
export const MAX_WORD_CHARS = 48;
export const MAX_NEVER_FLAG = 150;

export function normalizeSettings(raw = {}) {
  return {
    ...DEFAULTS,
    ...raw,
    categories: { ...DEFAULTS.categories, ...(raw.categories || {}) },
  };
}

export async function loadSettings() {
  return normalizeSettings(await chrome.storage.sync.get(null));
}

/** Saves settings; turns Chrome's quota errors into a sentence. */
export async function saveSettings(patch) {
  try {
    await chrome.storage.sync.set(patch);
  } catch (e) {
    if (/quota/i.test(String(e?.message))) throw new Error('That list is full. Remove a few entries in Penmend settings.');
    throw e;
  }
}

/** Calls cb(settings) whenever any synced setting changes. Returns an unsubscribe function. */
export function onSettingsChanged(cb) {
  const listener = (changes, area) => {
    if (area === 'sync') loadSettings().then(cb, () => {});
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** For extension pages: is a Claude key saved on this computer? */
export async function keySaved() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return Boolean(apiKey);
}

/**
 * Claude checks can run: a key on this computer, a model, and checks not switched off.
 * `s.hasApiKey` is filled in by whoever loaded the settings (MSG.STATUS or keySaved()).
 */
export function aiCheckReady(s) {
  return Boolean(s.hasApiKey && s.checkModel && s.aiMode !== 'off');
}

/** Claude rewrites can run (independent of the check mode). */
export function rewriteReady(s) {
  return Boolean(s.hasApiKey && s.rewriteModel);
}

/** The site a frame belongs to: the top page's hostname, also inside iframes. */
export function siteHostname(loc = globalThis.location) {
  try {
    const origins = loc.ancestorOrigins;
    if (origins && origins.length) return new URL(origins[origins.length - 1]).hostname;
  } catch { /* fall through */ }
  return loc.hostname || '';
}

export function isSiteDisabled(s, host) {
  return Boolean(host) && s.disabledSites.includes(host);
}

/** A dictionary word as stored: one line, no angle brackets, not too long. */
export function cleanWord(word) {
  return String(word || '').replace(/[\r\n\t<>]/g, ' ').trim().slice(0, MAX_WORD_CHARS);
}

/** Adds a word, keeping the list unique (case-sensitive, like the checkers). */
export async function addDictionaryWord(word) {
  const w = cleanWord(word);
  if (!w || /\s/.test(w)) return;
  const s = await loadSettings();
  if (s.dictionary.includes(w)) return;
  if (s.dictionary.length >= MAX_WORDS) throw new Error(`Your dictionary is full (${MAX_WORDS} words). Remove some in Penmend settings.`);
  await saveSettings({ dictionary: [...s.dictionary, w] });
}

export async function addNeverFlag(entry) {
  const clip = (t) => String(t ?? '').replace(/[\r\n<>]/g, ' ').trim().slice(0, 120);
  const e = { original: clip(entry.original), replacement: clip(entry.replacement) };
  if (!e.original) return;
  const s = await loadSettings();
  const key = (x) => `${x.original}\u0001${x.replacement ?? ''}`;
  if (s.neverFlag.some((x) => key(x) === key(e))) return;
  await saveSettings({ neverFlag: [...s.neverFlag, e].slice(-MAX_NEVER_FLAG) });
}

export async function disableRule(rule) {
  const s = await loadSettings();
  if (rule && /^\w{1,80}$/.test(rule) && !s.disabledRules.includes(rule)) {
    await saveSettings({ disabledRules: [...s.disabledRules, rule] });
  }
}
