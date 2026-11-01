// The writing pad: a page of the extension itself, for drafting text that goes somewhere Penmend
// can't reach (the Outlook app, a phone). The draft is kept in chrome.storage.local, on this computer.
import { Controller } from '../content/controller.js';
import { loadSettings, onSettingsChanged, keySaved } from '../shared/settings.js';
import { wordCount } from '../shared/text.js';
import { MSG, request } from '../shared/messaging.js';

const editor = document.getElementById('editor');
const meta = document.getElementById('meta');
const status = document.getElementById('status');

const plainText = () => editor.innerText.replace(/\n$/, '');

function updateMeta() {
  const text = plainText();
  const words = wordCount(text);
  meta.textContent = `${words} word${words === 1 ? '' : 's'} · ${text.length} characters`;
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ padDraft: plainText() }), 400);
}

// Paste as plain text: formatting from elsewhere would only get in the way here.
editor.addEventListener('paste', (e) => {
  const text = e.clipboardData?.getData('text/plain');
  if (text == null) return;
  e.preventDefault();
  document.execCommand('insertText', false, text);
});
editor.addEventListener('input', () => {
  updateMeta();
  saveSoon();
});

document.getElementById('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(plainText());
  status.textContent = 'Copied. Paste it wherever it needs to go.';
  setTimeout(() => { status.textContent = ''; }, 3000);
});
document.getElementById('clear').addEventListener('click', () => {
  if (plainText() && !confirm('Clear the pad? This can\'t be undone.')) return;
  editor.textContent = '';
  chrome.storage.local.set({ padDraft: '' });
  updateMeta();
  editor.focus();
});
document.getElementById('settings').addEventListener('click', () => request(MSG.OPEN_OPTIONS, {}));

const { padDraft } = await chrome.storage.local.get('padDraft');
if (padDraft) editor.textContent = padDraft;
updateMeta();

const ctl = new Controller({ ...await loadSettings(), hasApiKey: await keySaved() }, { extensionPage: true });
ctl.start();
onSettingsChanged(async (s) => ctl.updateSettings({ ...s, hasApiKey: await keySaved() }));
editor.focus();
