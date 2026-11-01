// The content script, injected into every page and frame. It stays a single focus listener (no
// storage reads, no UI) until you first click into a text box, use a shortcut, or the right-click
// menu, and only then starts.
//
// After an update the service worker injects the new version into open tabs. The new copy says
// hello; an old copy still on the page hears it and steps aside. An old copy that loses its
// extension without a replacement tells you to reload the page.
import { Controller } from './controller.js';
import { deepActiveElement } from './dom.js';
import { loadSettings, onSettingsChanged } from '../shared/settings.js';
import { MSG, request, extensionAlive } from '../shared/messaging.js';

const HELLO = 'penmend-hello';

(() => {
  // Once per build per frame (Chrome keeps an old build's globals in this world after an update).
  const key = `__penmend_${__PM_BUILD__}`;
  if (globalThis[key]) return;
  globalThis[key] = true;

  let ctl = null;
  let starting = null;
  let retired = false;

  /** Settings plus whether this computer has a Claude key (the key itself stays in the worker). */
  async function currentSettings() {
    const settings = await loadSettings();
    let hasApiKey = false;
    try {
      ({ hasApiKey } = await request(MSG.STATUS));
    } catch { /* no worker answer: treat as no key */ }
    return { ...settings, hasApiKey };
  }

  function start() {
    if (ctl || retired || !extensionAlive()) return starting;
    starting ||= (async () => {
      const settings = await currentSettings();
      if (retired) return null;
      document.removeEventListener('focusin', onFocus, true);
      ctl = new Controller(settings);
      ctl.start();
      onSettingsChanged(async () => {
        if (!ctl || retired) return;
        ctl.updateSettings(await currentSettings());
      });
      return ctl;
    })().catch(() => null);
    return starting;
  }

  function onFocus(e) {
    if (e && !e.isTrusted) return;
    const el = deepActiveElement();
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)) start();
  }

  // Tell an older copy (if any) to step aside, then listen for a newer one. Dispatching is
  // synchronous, so our own listener, added after, doesn't hear our own hello.
  document.dispatchEvent(new CustomEvent(HELLO));
  document.addEventListener(HELLO, () => {
    // Only an orphaned copy (its extension updated or removed) steps aside; a page's script sending
    // the same event to switch Penmend off is ignored.
    if (retired || extensionAlive()) return;
    retired = true;
    document.removeEventListener('focusin', onFocus, true);
    ctl?.shutdown();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (retired || !msg || typeof msg.type !== 'string') return;
    // Shortcuts go to every frame of the tab; only the focused one should act.
    if (msg.type === MSG.COMMAND && !document.hasFocus()) return;
    Promise.resolve(start()).then((c) => c?.onMessage(msg));
  });
  document.addEventListener('focusin', onFocus, true);
  onFocus();
})();
