// Runs Penmend in one document (a page, or a frame inside it): notices which text box you're in,
// keeps one Session per text box, and owns the card, badge, panel and selection tools.
import { Session } from './session.js';
import { UI } from './ui/ui.js';
import { Card } from './ui/card.js';
import { Badge } from './ui/badge.js';
import { Panel } from './ui/panel.js';
import { SelectionTools } from './ui/selection.js';
import { HighlightRegistry, highlightsSupported } from './highlights.js';
import { deepActiveElement, editingHost, isTextInput, looksVisible, optedOut } from './dom.js';
import {
  aiCheckReady, isSiteDisabled, siteHostname, saveSettings, addDictionaryWord, addNeverFlag, disableRule,
} from '../shared/settings.js';
import { MSG, request } from '../shared/messaging.js';

// Claude errors that need the user to change something: stop automatic checks until settings change.
const BLOCKING = new Set(['auth', 'permission', 'model', 'billing', 'no-key', 'no-model', 'budget', 'bad-request']);
// The test build (npm run e2e) honors the debugHooks setting; the release build never does.
const TEST_BUILD = typeof __PM_TEST__ !== 'undefined' && __PM_TEST__;
// Keep the local checker loaded while you write; let it go after this long without typing.
const WARM_IDLE_MS = 3 * 60_000;
// Hover cards, like Grammarly: open after resting on an underline, close after leaving it.
const HOVER_OPEN_MS = 350;
const HOVER_CLOSE_MS = 450;
const HOVER_AFTER_TYPING_MS = 900;

export class Controller {
  constructor(settings, { extensionPage = false } = {}) {
    this.settings = settings;
    this.extensionPage = extensionPage;
    this.sessions = new Map(); // element -> Session
    this.active = null;
    this.site = extensionPage ? '' : siteHostname();
    this.claudeBlocked = null;
    this.claudeBackoffUntil = 0;
    this.running = false;
    this.frame = 0;
    this.hover = { open: 0, close: 0, frame: 0, x: 0, y: 0, target: null, onUi: false };
  }

  get enabledHere() {
    return this.settings.enabled && !isSiteDisabled(this.settings, this.site);
  }

  get debugOn() {
    return TEST_BUILD && Boolean(this.settings.debugHooks);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.ui = new UI({ debug: this.debugOn });
    this.registry = new HighlightRegistry();
    this.card = new Card(this);
    this.badge = new Badge(this);
    this.panel = new Panel(this);
    this.selection = new SelectionTools(this);
    // Clicks on our controls must not take focus (or the caret) away from the text box.
    this.ui.layer.addEventListener('mousedown', (e) => {
      if (!e.target.closest('input, textarea')) e.preventDefault();
    });
    this.ui.layer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeFloating();
    });
    this.listen(document, 'focusin', this.onFocusIn, true);
    this.listen(document, 'focusout', this.onFocusOut, true);
    this.listen(document, 'pointerdown', this.onPointerDown, true);
    this.listen(document, 'pointerup', this.onPointerUp, true);
    this.listen(document, 'click', this.onClick, true);
    this.listen(document, 'mousemove', this.onMouseMove, { capture: true, passive: true });
    this.listen(document, 'keydown', this.onKeyDown, true);
    this.listen(document, 'selectionchange', () => this.selection.update());
    this.listen(window, 'scroll', this.onScroll, { capture: true, passive: true });
    this.listen(window, 'resize', this.onScroll, { passive: true });
    this.sweep = setInterval(() => this.housekeeping(), 1000);
    this.debug('build', typeof __PM_BUILD__ === 'string' ? __PM_BUILD__ : 'dev');
    if (this.enabledHere) this.focus(deepActiveElement());
  }

  listen(target, type, fn, opts) {
    const bound = fn.bind(this);
    target.addEventListener(type, bound, opts);
    (this.unlisten ||= []).push(() => target.removeEventListener(type, bound, opts));
  }

  // ---- Which text box are we in? -------------------------------------------------------------

  /** { el, kind } for a text box Penmend should check, or null. */
  editableFor(el) {
    if (!el || el.nodeType !== 1 || this.ui.contains(el)) return null;
    const field = (kind) => {
      if (optedOut(el) || !looksVisible(el)) return null;
      // A page that turned spellcheck off on a plain field usually means "not prose" (codes, IDs).
      if (el.getAttribute('spellcheck') === 'false' && !el.hasAttribute('data-pm-spellcheck')) return null;
      return { el, kind };
    };
    if (el.tagName === 'TEXTAREA') return field('textarea');
    if (el.tagName === 'INPUT') return this.settings.checkInputs && isTextInput(el) ? field('input') : null;
    if (el.isContentEditable && highlightsSupported()) {
      const host = editingHost(el);
      return !optedOut(host) && looksVisible(host) ? { el: host, kind: 'editor' } : null;
    }
    return null;
  }

  onFocusIn() {
    if (this.enabledHere) this.focus(deepActiveElement());
  }

  onFocusOut(e) {
    if (e.relatedTarget && this.ui.contains(e.relatedTarget)) return;
    setTimeout(() => {
      if (!this.running) return;
      const el = deepActiveElement();
      if (this.ui.contains(el)) return;
      if (!this.editableFor(el) && !this.panel.isOpen && !this.selection.menu) this.setActive(null);
    }, 0);
  }

  focus(el) {
    const target = this.editableFor(el);
    if (!target) {
      if (!this.panel.isOpen && !this.selection.menu) this.setActive(null);
      return;
    }
    let s = this.sessions.get(target.el);
    if (!s || s.disposed) {
      s = new Session(this, target.el, target.kind);
      this.sessions.set(target.el, s);
    }
    this.setActive(s);
  }

  setActive(s) {
    if (this.active === s) return;
    this.active = s;
    if (s) this.ui.mountFor(s.el);
    this.keepWarm();
    if (this.panel.isOpen && this.panel.session !== s) this.panel.close();
    if (this.card.session && this.card.session !== s) this.card.close();
    this.selection.update();
    this.badge.show(s);
    this.tick();
  }

  /**
   * Chrome stops the extension's background worker after ~30 s without messages, and loading the
   * local checker again takes ~2-3 s. So: start it as soon as you click into a text box, and ping
   * it every 20 s while you're in one (and the tab is visible), so underlines keep coming in ~0.3 s.
   */
  keepWarm() {
    clearInterval(this.warmTimer);
    this.warmTimer = 0;
    if (!this.active) return;
    this.warmSince = Date.now();
    const ping = () => {
      const s = this.active;
      const idle = !s || Date.now() - Math.max(this.warmSince, s.lastTyped) > WARM_IDLE_MS;
      if (idle) { // stop; typing or focusing a box starts it again
        clearInterval(this.warmTimer);
        this.warmTimer = 0;
        return;
      }
      if (document.visibilityState === 'visible' && document.hasFocus()) request(MSG.WARM).catch(() => {});
    };
    ping();
    this.warmTimer = setInterval(ping, 20_000);
  }

  /** A session saw you type: make sure the checker is being kept warm. */
  typingIn(s) {
    if (this.active === s && !this.warmTimer) this.keepWarm();
  }

  sessionFor(target) {
    if (!target) return null;
    for (const [el, s] of this.sessions) if (el === target || el.contains(target)) return s;
    return null;
  }

  // ---- Page events ---------------------------------------------------------------------------

  onPointerDown(e) {
    if (!e.isTrusted || e.composedPath().includes(this.ui.host)) return;
    this.card.close();
    this.selection.close();
    if (this.panel.isOpen && !(this.panel.session && this.panel.session.el.contains(e.composedPath()[0]))) this.panel.close();
  }

  onPointerUp(e) {
    if (e.isTrusted) this.selection.lastPointer = { x: e.clientX, y: e.clientY, t: Date.now() };
  }

  /** A click on an underlined word opens its card (and keeps it open). */
  onClick(e) {
    if (!this.running || !e.isTrusted || e.composedPath().includes(this.ui.host)) return;
    const why = (reason) => this.debug('lastClick', reason);
    const s = this.sessionFor(e.composedPath()[0]);
    if (!s || s.disposed) return why('not in a checked text box');
    const sel = s.adapter.selectionOffsets();
    if (sel && sel.end > sel.start) return why('text selected'); // selecting text, not clicking a word
    const id = s.adapter.issueIdAt(e.clientX, e.clientY);
    if (!id) return why('no underline under the click');
    if (!s.current) return why('text changed since the last check');
    const issue = s.issueById(id);
    if (issue) this.card.open(s, issue);
    return why(issue ? 'card' : 'issue gone');
  }

  /** Resting the mouse on an underline opens its card; moving away closes it (unless you clicked it). */
  onMouseMove(e) {
    if (!this.running || !e.isTrusted || !this.settings.hoverCards) return;
    const h = this.hover;
    const path = e.composedPath();
    h.onUi = path.includes(this.ui.host);
    h.x = e.clientX;
    h.y = e.clientY;
    h.target = path[0];
    h.buttons = e.buttons;
    if (!h.frame) h.frame = requestAnimationFrame(() => {
      h.frame = 0;
      this.checkHover();
    });
  }

  checkHover() {
    const h = this.hover;
    const card = this.card;
    if (h.onUi) { // on our card (or other controls): keep it
      clearTimeout(h.close);
      h.close = 0;
      return;
    }
    const s = h.buttons ? null : this.sessionFor(h.target);
    const id = s && !s.disposed && Date.now() - s.lastTyped > HOVER_AFTER_TYPING_MS ? s.adapter.issueIdAt(h.x, h.y) : null;
    if (id) {
      clearTimeout(h.close);
      h.close = 0;
      if (card.isOpen && card.issue?.id === id) return;
      clearTimeout(h.open);
      h.open = setTimeout(() => {
        h.open = 0;
        if (!this.running || h.onUi || s.disposed || s.adapter.issueIdAt(h.x, h.y) !== id || !s.current) return;
        const issue = s.issueById(id);
        if (issue && !(card.isOpen && !card.byHover)) card.open(s, issue, { hover: true });
      }, card.isOpen ? 80 : HOVER_OPEN_MS);
    } else {
      clearTimeout(h.open);
      h.open = 0;
      if (card.isOpen && card.byHover && !h.close) {
        h.close = setTimeout(() => {
          h.close = 0;
          if (!h.onUi && this.card.byHover) this.card.close();
        }, HOVER_CLOSE_MS);
      }
    }
  }

  onKeyDown(e) {
    if (e.isTrusted && e.key === 'Escape' && (this.card.isOpen || this.panel.isOpen || this.selection.menu)) {
      this.closeFloating();
      e.stopPropagation();
    }
  }

  onScroll() {
    this.tick();
    if (!this.frame) this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.reposition();
    });
  }

  reposition() {
    for (const s of this.sessions.values()) if (s.adapter.position) s.adapter.position();
    this.badge.position();
    this.card.position();
    this.panel.place();
    this.selection.update();
  }

  /**
   * Follows the focused text box every frame for a few seconds after anything happens (layouts
   * shift without scroll events: a toolbar opens, an image loads); housekeeping covers the rest.
   */
  tick() {
    this.lastActivity = Date.now();
    if (this.ticking || !this.active) return;
    this.ticking = true;
    const step = () => {
      if (!this.running || !this.active || Date.now() - this.lastActivity > 3000) {
        this.ticking = false;
        return;
      }
      this.active.adapter.position?.();
      this.badge.position();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  housekeeping() {
    for (const [el, s] of this.sessions) {
      if (!el.isConnected) {
        s.dispose();
        this.sessions.delete(el);
        if (this.active === s) this.setActive(null);
      } else {
        s.noticeSilentChange();
        s.adapter.position?.();
      }
    }
    this.badge.position();
    if (this.panel.isOpen && this.panel.session?.disposed) this.panel.close();
  }

  closeFloating() {
    this.card.close();
    this.panel.close();
    this.selection.close();
  }

  // ---- Called by sessions and the UI -------------------------------------------------------------

  sessionUpdated(s) {
    if (this.active === s) this.tick();
    if (this.badge.session === s) this.badge.update();
    this.panel.refresh(s);
    if (this.card.session === s && !s.issueById(this.card.issue.id)) this.card.close();
    this.mirrorTestState();
  }

  /** Test and debugging hooks (Settings debugHooks only): counts on our element. */
  debug(key, value) {
    if (this.debugOn) this.ui.host.dataset[key] = String(value);
  }

  mirrorTestState() {
    if (!this.debugOn) return;
    let red = 0;
    let blue = 0;
    let claude = 0;
    let painted = 0;
    let rewrites = 0;
    for (const s of this.sessions.values()) {
      rewrites += s.rewrites.length;
      for (const i of s.issues) {
        if (i.tone === 'blue') blue++; else red++;
        if (i.source !== 'local') claude++;
      }
      painted += (s.adapter.ranges || s.adapter.spans)?.size || 0;
    }
    this.debug('painted', painted);
    this.debug('sessions', JSON.stringify([...this.sessions.values()].map((s) => ({
      kind: s.kind, len: s.text.length, issues: s.issues.map((i) => i.original), drawn: (s.adapter.ranges || s.adapter.spans)?.size || 0,
      lint: s.lintSeq, local: s.local.map((i) => `${i.original}@${i.start}:${i.rule}`), err: s.localError,
      around: s.local.map((i) => JSON.stringify(s.text.slice(Math.max(0, i.start - 12), i.end + 12))),
    }))));
    this.debug('issues', red + blue);
    this.debug('red', red);
    this.debug('blue', blue);
    this.debug('claude', claude);
    this.debug('rewrites', rewrites);
  }

  applyFix(s, issue, replacement) {
    this.card.close();
    const done = s.applyFix(issue, replacement);
    if (done !== true && typeof done === 'string') this.ui.toast(done, 4000);
  }

  fixAll(s) {
    s.fixAll();
  }

  /** Replaces the box's whole text with a rewrite of `original`. True, or a sentence why not. */
  replaceAll(s, text, original) {
    const done = s.adapter.replaceAll(text, original);
    if (done === true) {
      this.panel.close();
      s.dirty = true;
      s.lint();
    }
    return done;
  }

  revealIssue(s, issue) {
    s.adapter.reveal(issue.anchorId || issue.id);
    s.setActive(issue.id);
    setTimeout(() => {
      if (!s.disposed && s.issueById(issue.id)) this.card.open(s, s.issueById(issue.id));
    }, 60);
  }

  ignore(s, issue) {
    this.card.close();
    s.ignore(issue);
  }

  async saveOrSay(work) {
    try {
      await work();
    } catch (e) {
      this.ui.toast(e.message, 5000);
    }
  }

  addWord(word) {
    this.card.close();
    return this.saveOrSay(() => addDictionaryWord(word));
  }

  neverFlag(issue) {
    this.card.close();
    return this.saveOrSay(() => addNeverFlag({ original: issue.original, replacement: issue.suggestions[0] ?? '' }));
  }

  turnOffRule(rule) {
    this.card.close();
    return this.saveOrSay(() => disableRule(rule));
  }

  turnOffRewrites() {
    this.card.close();
    return this.saveOrSay(() => saveSettings({ rewriteSuggestions: false }));
  }

  disableSite() {
    if (!this.site) return undefined;
    this.closeFloating();
    return this.saveOrSay(() => saveSettings({ disabledSites: [...new Set([...this.settings.disabledSites, this.site])] }));
  }

  siteLabel() {
    return this.site || 'this page';
  }

  openSettings(section) {
    request(MSG.OPEN_OPTIONS, { section }).catch(() => {});
  }

  // ---- Claude readiness --------------------------------------------------------------------------

  claudeAutoReady() {
    return aiCheckReady(this.settings) && this.settings.aiMode === 'auto' && !this.claudeBlocked
      && Date.now() >= this.claudeBackoffUntil;
  }

  claudeManualReady() {
    return Boolean(this.settings.hasApiKey && this.settings.checkModel && this.settings.aiMode !== 'off');
  }

  claudeSucceeded() {
    this.claudeBackoffUntil = 0;
  }

  claudeFailed(e) {
    if (BLOCKING.has(e.code)) this.claudeBlocked = e.message;
    else this.claudeBackoffUntil = Date.now() + 30_000;
  }

  // ---- Settings, commands, shutdown -------------------------------------------------------------

  updateSettings(settings) {
    const old = this.settings;
    this.settings = settings;
    this.claudeBlocked = null;
    this.claudeBackoffUntil = 0;
    if (!this.enabledHere) {
      this.closeFloating();
      for (const s of this.sessions.values()) s.dispose();
      this.sessions.clear();
      this.setActive(null);
      this.mirrorTestState();
      return;
    }
    // Claude's earlier findings depend on these; dictionary and "never flag" are applied as filters.
    const recheck = ['styleNotes', 'useStyle', 'dialect', 'checkModel'].some((k) => old[k] !== settings[k])
      || (settings.rewriteSuggestions && !old.rewriteSuggestions);
    for (const s of this.sessions.values()) {
      if (recheck) s.forgetClaude();
      s.settingsChanged();
    }
    if (!this.active) this.focus(deepActiveElement());
    if (this.panel.isOpen) this.panel.render();
  }

  onMessage(msg) {
    if (!this.running) return;
    if (msg.type === MSG.COMMAND) {
      if (msg.command === 'open-panel' && this.active) this.panel.toggle(this.active);
      if (msg.command === 'rewrite-selection') this.selection.openMenu();
    } else if (msg.type === MSG.REWRITE_SELECTION) {
      this.selection.openMenu(msg.mode, msg.selectionText);
    }
  }

  /**
   * Takes everything off the page and stops (underlines included: a newer copy taking over after an
   * update hasn't drawn any yet). gone: the extension was updated or turned off with no replacement
   * here: say so once, so the missing underlines don't look like "no mistakes".
   */
  shutdown({ gone = false } = {}) {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.sweep);
    clearInterval(this.warmTimer);
    for (const off of this.unlisten || []) off();
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    this.registry.flush();
    if (gone && this.active) {
      this.closeFloating();
      this.badge.show(null);
      this.ui.toast('Penmend was updated or turned off. Reload this page to keep checking here.', 8000);
      setTimeout(() => this.ui.destroy(), 8200);
    } else {
      this.ui.destroy();
    }
    this.active = null;
  }
}
