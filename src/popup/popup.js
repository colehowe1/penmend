// The toolbar popup: on/off (everywhere and for this site), Claude's status and this month's cost.
import { loadSettings, saveSettings, keySaved, aiCheckReady } from '../shared/settings.js';
import { modelInfo, costOf, formatDollars } from '../shared/models.js';

const $ = (id) => document.getElementById(id);
const hasApiKey = await keySaved();
const settings = { ...await loadSettings(), hasApiKey };

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = '';
try {
  const url = new URL(tab?.url || '');
  if (/^https?:$/.test(url.protocol)) host = url.hostname;
} catch { /* not a web page */ }

$('enabled').checked = settings.enabled;
$('enabled').addEventListener('change', async (e) => {
  await saveSettings({ enabled: e.target.checked });
  render({ ...await loadSettings(), hasApiKey });
});

$('site').addEventListener('change', async (e) => {
  const s = await loadSettings();
  const sites = new Set(s.disabledSites);
  if (e.target.checked) sites.delete(host); else sites.add(host);
  await saveSettings({ disabledSites: [...sites] });
  render({ ...await loadSettings(), hasApiKey });
});

$('claude-setup').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#claude') });
  window.close();
});
$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$('pad').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pad/pad.html') });
  window.close();
});

function render(s) {
  $('site-name').textContent = host || 'Not available on this page';
  $('site').disabled = !host || !s.enabled;
  $('site').checked = Boolean(host) && !s.disabledSites.includes(host);
  const check = modelInfo(s.checkModel);
  const rewrite = modelInfo(s.rewriteModel);
  if (!s.hasApiKey) {
    $('claude-status').textContent = 'Not set up (local checks only)';
    $('claude-setup').textContent = 'Set up';
  } else {
    const how = aiCheckReady(s)
      ? `${check.name} checks ${s.aiMode === 'auto' ? 'as you type' : 'when you click'}`
      : 'Checks off';
    $('claude-status').textContent = `${how}${rewrite ? ` · rewrites with ${rewrite.name.replace('Claude ', '')}` : ''}`;
    $('claude-setup').textContent = 'Change';
  }
  $('engine').textContent = !s.enabled ? 'Off everywhere'
    : aiCheckReady(s) ? 'Harper on this computer + Claude' : 'Checking with Harper (on this computer)';
}

render(settings);

const { usage } = await chrome.storage.local.get('usage');
if (usage?.models && Object.keys(usage.models).length) {
  let dollars = 0;
  for (const [model, u] of Object.entries(usage.models)) dollars += costOf(model, u);
  const k = usage.kinds || {};
  const bits = [];
  if (k.check) bits.push(`${k.check} check${k.check === 1 ? '' : 's'}`);
  if (k.rewrite) bits.push(`${k.rewrite} rewrite${k.rewrite === 1 ? '' : 's'}`);
  $('usage').textContent = `About ${formatDollars(dollars)} of Claude${bits.length ? ` (${bits.join(', ')})` : ''}`;
  $('usage-row').hidden = false;
}

const commands = await chrome.commands.getAll();
const keys = commands.filter((c) => c.shortcut).map((c) => `${c.shortcut} ${c.name === 'open-panel' ? 'panel' : 'rewrite selection'}`);
$('keys').textContent = keys.length ? `Shortcuts: ${keys.join(' · ')}` : '';
