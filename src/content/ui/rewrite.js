// Rewrites with Claude: mode buttons, the text streaming in as Claude writes it, then the changes
// marked up, with Replace / Copy / Try again. Used by the panel (whole text) and the selection menu.
import { h } from '../dom.js';
import { tokenize, looksSensitive } from '../../shared/text.js';
import { PORT_REWRITE, extensionAlive } from '../../shared/messaging.js';
import { modelInfo } from '../../shared/models.js';

export const MODES = [
  ['improve', 'Improve'],
  ['shorten', 'Shorten'],
  ['professional', 'More professional'],
  ['friendly', 'Friendlier'],
  ['simplify', 'Simpler'],
  ['fix', 'Fix errors only'],
  ['mine', 'Sound like me'],
];

/** Word-level changes between a and b as a fragment of text, <del> and <ins>. */
export function diffFragment(a, b) {
  const x = tokenize(a);
  const y = tokenize(b);
  const frag = document.createDocumentFragment();
  if (x.length * y.length > 4_000_000) {
    frag.append(b);
    return frag;
  }
  // Longest common subsequence, then walk it.
  const n = x.length;
  const m = y.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let mode = null;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    frag.append(mode ? h(mode, {}, buf) : document.createTextNode(buf));
    buf = '';
  };
  const push = (kind, s) => {
    if (kind !== mode) {
      flush();
      mode = kind;
    }
    buf += s;
  };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      push(null, x[i]);
      i++;
      j++;
    } else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) {
      push('del', x[i++]); // what goes out reads before what comes in
    } else {
      push('ins', y[j++]);
    }
  }
  flush();
  return frag;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.documentElement.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/**
 * The rewrite UI. opts: { text, before, after, settings, canReplace, onReplace(newText) -> bool,
 * onBack?, autoMode?, focusCustom? }. Returns { el, destroy }.
 */
export function rewriteView(opts) {
  const { text, settings } = opts;
  const el = h('div', { class: 'pm-rw' });
  let port = null;
  let result = '';
  let lastRun = null;
  let sendAnyway = false;
  // Context around a selection goes along only if it doesn't look like it holds a secret.
  const before = looksSensitive(opts.before || '') ? '' : opts.before || '';
  const after = looksSensitive(opts.after || '') ? '' : opts.after || '';
  const hasStyle = settings.useStyle && String(settings.styleNotes || '').trim();
  const modelName = modelInfo(settings.rewriteModel)?.name || 'Claude';

  const stop = () => {
    if (port) {
      try {
        port.disconnect();
      } catch { /* already closed */ }
      port = null;
    }
  };

  function showModes() {
    stop();
    const input = h('input', { type: 'text', placeholder: 'Or say what to change, e.g. "make it a bullet list"', 'aria-label': 'Custom rewrite instruction' });
    const go = () => {
      if (input.value.trim()) run('custom', input.value.trim());
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.isTrusted) go();
    });
    el.replaceChildren(
      h('div', { class: 'pm-row' }, MODES.filter(([m]) => m !== 'mine' || hasStyle)
        .map(([mode, label]) => h('button', { class: 'pm-btn', onclick: () => run(mode) }, label))),
      h('div', { class: 'pm-custom' }, input, h('button', { class: 'pm-btn primary', onclick: go }, 'Go')),
      opts.onBack ? h('div', { class: 'pm-row' }, h('button', { class: 'pm-link', onclick: () => opts.onBack() }, '‹ Back')) : null,
    );
    if (opts.focusCustom) setTimeout(() => input.focus(), 0);
  }

  function run(mode, instruction = '') {
    stop();
    lastRun = [mode, instruction];
    result = '';
    if (!sendAnyway && (opts.secretBox || looksSensitive(text))) {
      el.replaceChildren(
        h('div', { class: 'pm-note err' }, opts.secretBox
          ? 'This box looks like it is for passwords, keys or code. Claude would see everything in it.'
          : 'This looks like it includes a password, key, PIN or card number. Claude would see it.'),
        h('div', { class: 'pm-row' },
          h('button', { class: 'pm-btn', onclick: () => { sendAnyway = true; run(mode, instruction); } }, 'Send it anyway'),
          h('button', { class: 'pm-btn primary', onclick: () => showModes() }, 'Cancel')),
      );
      return;
    }
    const out = h('div', { class: 'pm-rw-text', 'aria-live': 'polite' });
    const status = h('div', { class: 'pm-rw-status' }, h('span', { class: 'pm-spin' }), `Rewriting with ${modelName}…`,
      h('button', { class: 'pm-link pm-toggle', onclick: () => { stop(); showModes(); } }, 'Stop'));
    el.replaceChildren(status, out);
    if (!extensionAlive()) {
      fail('Penmend was updated. Reload this page to use it here again.');
      return;
    }
    port = chrome.runtime.connect({ name: PORT_REWRITE });
    const mine = port;
    port.onMessage.addListener((m) => {
      if (port !== mine) return;
      if (m.type === 'delta') {
        result += m.text;
        out.textContent = result;
        out.scrollTop = out.scrollHeight;
      } else if (m.type === 'done') {
        result = m.text;
        port = null;
        mine.disconnect();
        showResult();
      } else if (m.type === 'error') {
        port = null;
        mine.disconnect();
        fail(m.error);
      }
    });
    port.onDisconnect.addListener(() => {
      if (port === mine) {
        port = null;
        fail('The rewrite stopped unexpectedly. Try again.');
      }
    });
    port.postMessage({ type: 'start', text, mode, instruction, before, after });
  }

  function fail(message) {
    el.replaceChildren(
      h('div', { class: 'pm-note err' }, message),
      h('div', { class: 'pm-row' },
        lastRun ? h('button', { class: 'pm-btn', onclick: () => run(...lastRun) }, 'Try again') : null,
        h('button', { class: 'pm-btn', onclick: () => showModes() }, 'Back')),
    );
  }

  function showResult() {
    let showChanges = true;
    const out = h('div', { class: 'pm-rw-text' });
    const toggle = h('button', { class: 'pm-link pm-toggle' });
    const paint = () => {
      out.replaceChildren(showChanges ? diffFragment(text, result) : document.createTextNode(result));
      toggle.textContent = showChanges ? 'Show result only' : 'Show changes';
    };
    toggle.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      showChanges = !showChanges;
      paint();
    });
    paint();
    const note = h('span', { class: 'pm-note' });
    el.replaceChildren(
      h('div', { class: 'pm-rw-status' }, `Rewritten by ${modelName}`, toggle),
      out,
      h('div', { class: 'pm-row' },
        opts.canReplace ? h('button', {
          class: 'pm-btn primary',
          onclick: () => {
            const done = opts.onReplace(result);
            if (done !== true) note.textContent = typeof done === 'string' ? done : 'Nothing was replaced. Copy it instead, or try again.';
          },
        }, 'Replace') : null,
        h('button', {
          class: `pm-btn${opts.canReplace ? '' : ' primary'}`,
          onclick: async () => { note.textContent = (await copyText(result)) ? 'Copied.' : 'Copy failed: select the text and copy it.'; },
        }, 'Copy'),
        h('button', { class: 'pm-btn', onclick: () => run(...lastRun) }, 'Try again'),
        h('button', { class: 'pm-btn', onclick: () => showModes() }, 'Other options'),
      ),
      note,
    );
  }

  if (opts.autoMode) run(opts.autoMode);
  else showModes();
  return { el, destroy: stop };
}
