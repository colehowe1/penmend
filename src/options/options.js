// Settings. Every change saves at once (chrome.storage.sync); the API key saves on "Save key"
// into chrome.storage.local, which web pages and content scripts can't read.
import {
  loadSettings, saveSettings, onSettingsChanged, keySaved, DIALECTS, MAX_STYLE_CHARS, MAX_WORDS, cleanWord, aiCheckReady,
} from '../shared/settings.js';
import { MODELS, modelInfo, monthlyEstimate, costOf, formatDollars, ESTIMATE_BASIS } from '../shared/models.js';
import { CATEGORY_LABELS } from '../shared/categories.js';
import { MSG, request } from '../shared/messaging.js';

const $ = (id) => document.getElementById(id);
// The settings, plus whether this computer has a key (the key itself never syncs).
const withKey = async (s) => ({ ...s, hasApiKey: await keySaved() });
let settings = await withKey(await loadSettings());

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

let toastTimer = 0;
function toast(text = 'Saved') {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}

async function save(patch, message) {
  try {
    await saveSettings(patch);
    toast(message);
  } catch (e) {
    toast(`Couldn't save: ${e.message}`);
  }
}

function setStatus(id, text, kind = '') {
  const s = $(id);
  s.textContent = text;
  s.className = `status${kind ? ` ${kind}` : ''}`;
}

// ---- Claude ------------------------------------------------------------------------------------

async function refreshKeyUI() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  $('key').value = '';
  $('key').placeholder = apiKey ? `Saved: ${apiKey.slice(0, 10)}…${apiKey.slice(-4)}` : 'sk-ant-…';
  $('key-remove').hidden = !apiKey;
  $('key-save').textContent = apiKey ? 'Replace key' : 'Save key';
}

$('key-show').addEventListener('click', () => {
  const k = $('key');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('key-show').textContent = k.type === 'password' ? 'Show' : 'Hide';
});

$('key-save').addEventListener('click', async () => {
  const key = $('key').value.trim();
  if (!key) {
    setStatus('key-status', 'Paste your key first.', 'err');
    return;
  }
  if (!/^sk-ant-/.test(key)) {
    setStatus('key-status', 'That doesn\'t look like an Anthropic key (they start with "sk-ant-").', 'err');
    return;
  }
  setStatus('key-status', 'Checking the key…');
  const model = settings.checkModel || settings.rewriteModel || MODELS[0].id;
  try {
    await request(MSG.TEST_KEY, { apiKey: key, model });
  } catch (e) {
    setStatus('key-status', e.message, 'err');
    return;
  }
  await chrome.storage.local.set({ apiKey: key });
  await save({ keyEpoch: Date.now() }, 'Key saved'); // tells open pages to ask again
  setStatus('key-status', `Key works (tested with ${modelInfo(model).name}).`, 'ok');
  await refreshKeyUI();
});

$('key-remove').addEventListener('click', async () => {
  if (!confirm('Remove the API key from this browser? Claude checks and rewrites stop until you add one again.')) return;
  await chrome.storage.local.remove('apiKey');
  await save({ keyEpoch: Date.now() }, 'Key removed');
  setStatus('key-status', '');
  await refreshKeyUI();
});

function renderModels(containerId, field) {
  const box = $(containerId);
  box.replaceChildren(...MODELS.map((m) => {
    const perMonth = field === 'checkModel' ? monthlyEstimate(m.id, '') : monthlyEstimate('', m.id);
    return el('label', { class: 'model' },
      el('input', {
        type: 'radio', name: field, value: m.id, checked: settings[field] === m.id,
        onchange: () => save({ [field]: m.id }),
      }),
      el('div', { class: 'mname' }, m.name),
      el('div', { class: 'mblurb' }, m.blurb),
      el('div', { class: 'mcost' }, `≈ ${formatDollars(perMonth)} a month`),
    );
  }));
}

function renderClaude() {
  renderModels('check-models', 'checkModel');
  renderModels('rewrite-models', 'rewriteModel');
  for (const r of document.querySelectorAll('input[name="aiMode"]')) r.checked = r.value === settings.aiMode;
  const both = settings.checkModel && settings.rewriteModel;
  $('estimate').textContent = both
    ? `Estimated: about ${formatDollars(monthlyEstimate(settings.checkModel, settings.rewriteModel))} a month at ${ESTIMATE_BASIS}.`
    : 'Choose a model for checks and one for rewrites. Nothing is sent to Claude until you do.';
  const pill = $('claude-pill');
  const on = settings.hasApiKey && (aiCheckReady(settings) || settings.rewriteModel);
  pill.textContent = on ? 'On' : settings.hasApiKey ? 'Choose models' : 'Off';
  pill.classList.toggle('on', Boolean(on));
}

for (const r of document.querySelectorAll('input[name="aiMode"]')) {
  r.addEventListener('change', () => save({ aiMode: r.value }));
}

$('test').addEventListener('click', async () => {
  const model = settings.checkModel || settings.rewriteModel;
  if (!settings.hasApiKey) return setStatus('test-status', 'Save a key first.', 'err');
  if (!model) return setStatus('test-status', 'Choose a model first.', 'err');
  setStatus('test-status', 'Testing…');
  try {
    await request(MSG.TEST_KEY, { model });
    setStatus('test-status', `Connected: ${modelInfo(model).name} answered.`, 'ok');
  } catch (e) {
    setStatus('test-status', e.message, 'err');
  }
});

// The daily limit lives in chrome.storage.local, next to the key, where only extension pages and the
// service worker can change it. Saving it also bumps keyEpoch so open pages pick up "Claude is
// allowed again" right away.
const DEFAULT_DAILY = 2;

async function renderBudget() {
  const { budget, usage } = await chrome.storage.local.get(['budget', 'usage']);
  if (document.activeElement !== $('daily')) $('daily').value = Number(budget?.dailyDollars ?? DEFAULT_DAILY).toFixed(2);
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const spent = usage?.day === today ? usage.daySpend || 0 : 0;
  $('today').textContent = !spent ? 'Nothing spent today yet.'
    : spent < 0.01 ? 'Spent today: under $0.01' : `Spent today: about ${formatDollars(spent)}`;
}

$('daily').addEventListener('change', async () => {
  const v = Math.max(0.1, Math.min(1000, Number($('daily').value) || DEFAULT_DAILY));
  await chrome.storage.local.set({ budget: { dailyDollars: v } });
  await save({ keyEpoch: Date.now() }, `Daily limit: $${v.toFixed(2)}`);
  renderBudget();
});

// ---- Style -------------------------------------------------------------------------------------

function renderStyle() {
  $('useStyle').checked = settings.useStyle;
  if (document.activeElement !== $('styleNotes')) $('styleNotes').value = settings.styleNotes;
  $('style-count').textContent = String($('styleNotes').value.length);
}

$('useStyle').addEventListener('change', (e) => save({ useStyle: e.target.checked }));
let styleTimer = 0;
$('styleNotes').addEventListener('input', () => {
  $('style-count').textContent = String($('styleNotes').value.length);
  clearTimeout(styleTimer);
  styleTimer = setTimeout(() => save({ styleNotes: $('styleNotes').value.slice(0, MAX_STYLE_CHARS) }), 700);
});

$('learn').addEventListener('click', async () => {
  const samples = $('samples').value.trim();
  if (samples.length < 80) return setStatus('learn-status', 'Paste a bit more of your writing first.', 'err');
  if (!settings.hasApiKey || !(settings.rewriteModel || settings.checkModel)) {
    return setStatus('learn-status', 'Set up Claude above first (a key and a model).', 'err');
  }
  setStatus('learn-status', 'Claude is reading your samples…');
  $('learn').disabled = true;
  try {
    const { notes } = await request(MSG.LEARN_STYLE, { samples: samples.slice(0, 20_000) });
    $('proposal').textContent = notes;
    $('learned').hidden = false;
    setStatus('learn-status', '');
  } catch (e) {
    setStatus('learn-status', e.message, 'err');
  } finally {
    $('learn').disabled = false;
  }
});

async function useLearned(append) {
  const notes = $('proposal').textContent.trim();
  const next = append && settings.styleNotes.trim() ? `${settings.styleNotes.trim()}\n${notes}` : notes;
  $('styleNotes').value = next.slice(0, MAX_STYLE_CHARS);
  await save({ styleNotes: $('styleNotes').value, useStyle: true }, 'Style saved');
  $('learned').hidden = true;
  $('samples').value = '';
}
$('learn-replace').addEventListener('click', () => useLearned(false));
$('learn-add').addEventListener('click', () => useLearned(true));
$('learn-discard').addEventListener('click', () => { $('learned').hidden = true; });

// ---- Checking ----------------------------------------------------------------------------------

$('dialect').replaceChildren(...DIALECTS.map((d) => el('option', { value: d }, `${d} English`)));
$('dialect').addEventListener('change', (e) => save({ dialect: e.target.value }));

const SWITCHES = ['hoverCards', 'ignoreAllCaps', 'nativeSpellcheckOff', 'checkInputs', 'selectionButton',
  'rewriteSuggestions', 'noSemicolons', 'noDashes'];

function renderChecking() {
  $('dialect').value = settings.dialect;
  $('categories').replaceChildren(...Object.entries(CATEGORY_LABELS).map(([cat, label]) => el('label', {},
    el('input', {
      type: 'checkbox', checked: settings.categories[cat],
      onchange: (e) => save({ categories: { ...settings.categories, [cat]: e.target.checked } }),
    }), label)));
  for (const id of SWITCHES) $(id).checked = settings[id];
}
for (const id of SWITCHES) {
  $(id).addEventListener('change', (e) => save({ [id]: e.target.checked }));
}

// ---- Dictionary, rules, never-flag ---------------------------------------------------------------

let ruleDescriptions = null;

function renderLists() {
  $('dict-count').textContent = String(settings.dictionary.length);
  $('words').replaceChildren(...[...settings.dictionary].sort((a, b) => a.localeCompare(b)).map((w) => el('span', { class: 'chip' }, w,
    el('button', {
      type: 'button', title: `Remove "${w}"`, 'aria-label': `Remove ${w}`,
      onclick: () => save({ dictionary: settings.dictionary.filter((x) => x !== w) }, 'Removed'),
    }, '×'))));

  $('rules').replaceChildren(...settings.disabledRules.map((r) => el('div', { class: 'row-item' },
    el('div', {}, el('div', {}, r.replace(/([a-z])([A-Z])/g, '$1 $2')),
      el('div', { class: 'sub' }, (ruleDescriptions?.[r] || '').replace(/[`*]/g, ''))),
    el('button', {
      type: 'button', title: 'Turn back on', 'aria-label': `Turn ${r} back on`,
      onclick: () => save({ disabledRules: settings.disabledRules.filter((x) => x !== r) }, 'Turned back on'),
    }, '×'))));

  $('never').replaceChildren(...settings.neverFlag.map((n, idx) => el('div', { class: 'row-item' },
    el('div', {}, `"${n.original}"`, n.replacement ? el('span', { class: 'sub' }, ` (not "${n.replacement}")`) : null),
    el('button', {
      type: 'button', title: 'Remove', 'aria-label': 'Remove',
      onclick: () => save({ neverFlag: settings.neverFlag.filter((_, i) => i !== idx) }, 'Removed'),
    }, '×'))));

  $('site-list').replaceChildren(...settings.disabledSites.map((s) => el('div', { class: 'row-item' },
    el('div', {}, s),
    el('button', {
      type: 'button', title: 'Turn back on for this site', 'aria-label': `Turn back on for ${s}`,
      onclick: () => save({ disabledSites: settings.disabledSites.filter((x) => x !== s) }, 'Turned back on'),
    }, '×'))));
}

async function addWord() {
  const words = $('word').value.split(/[\s,]+/).map(cleanWord).filter(Boolean);
  if (!words.length) return;
  const next = [...new Set([...settings.dictionary, ...words])];
  if (next.length > MAX_WORDS) {
    toast(`The dictionary holds ${MAX_WORDS} words. Remove some first.`);
    return;
  }
  await save({ dictionary: next }, words.length > 1 ? `Added ${words.length} words` : 'Added');
  $('word').value = '';
}
$('word-add').addEventListener('click', addWord);
$('word').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addWord();
});

// ---- Shortcuts, usage --------------------------------------------------------------------------

async function renderShortcuts() {
  const commands = await chrome.commands.getAll();
  const names = { 'open-panel': 'Open the panel for the text box you\'re in', 'rewrite-selection': 'Rewrite the selected text' };
  $('shortcuts').replaceChildren(...commands.filter((c) => names[c.name]).map((c) => el('div', { class: 'row-item' },
    el('div', {}, names[c.name]), el('span', { class: 'kbd' }, c.shortcut || 'not set'))));
}
$('shortcuts-edit').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

async function renderUsage() {
  const { usage } = await chrome.storage.local.get('usage');
  const rows = Object.entries(usage?.models || {});
  if (!rows.length) {
    $('usage-table').replaceChildren(el('p', { class: 'help' }, 'No Claude use yet this month.'));
    return;
  }
  let total = 0;
  const fmt = (n) => n.toLocaleString();
  const body = rows.map(([model, u]) => {
    const dollars = costOf(model, u);
    total += dollars;
    return el('tr', {},
      el('td', {}, modelInfo(model)?.name || model), el('td', {}, fmt(u.requests)),
      el('td', {}, fmt(u.input + u.cacheRead + u.cacheWrite)), el('td', {}, fmt(u.output)), el('td', {}, formatDollars(dollars)));
  });
  const k = usage.kinds || {};
  $('usage-table').replaceChildren(
    el('table', {},
      el('thead', {}, el('tr', {}, ['Model', 'Requests', 'Tokens in', 'Tokens out', 'Cost'].map((t) => el('th', {}, t)))),
      el('tbody', {}, body),
      el('tfoot', {}, el('tr', {}, el('td', {}, 'Total'), el('td', {}), el('td', {}), el('td', {}), el('td', {}, formatDollars(total))))),
    el('p', { class: 'help' }, `${usage.month}: ${k.check || 0} checks, ${k.rewrite || 0} rewrites, ${k.style || 0} style summaries.`));
}
$('usage-reset').addEventListener('click', async () => {
  if (!confirm('Reset this month\'s usage counter?')) return;
  await chrome.storage.local.remove('usage');
  renderUsage();
});

// ---- Wiring ------------------------------------------------------------------------------------

function renderAll() {
  renderClaude();
  renderStyle();
  renderChecking();
  renderLists();
}

onSettingsChanged(async (s) => {
  settings = await withKey(s);
  renderAll();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.usage) {
    renderUsage();
    renderBudget();
  }
});

renderAll();
renderBudget();
refreshKeyUI();
renderShortcuts();
renderUsage();
if (location.hash === '#welcome' || (!settings.hasApiKey && !settings.checkModel)) $('welcome').hidden = false;
if (location.hash && location.hash !== '#welcome') document.querySelector(location.hash)?.scrollIntoView();
// Rule descriptions come from Harper itself; only load it when there are turned-off rules to describe.
if (settings.disabledRules.length) {
  request(MSG.RULE_INFO).then(({ descriptions }) => {
    ruleDescriptions = descriptions;
    renderLists();
  }).catch(() => {});
}
