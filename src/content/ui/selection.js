// Rewriting a selection: a small "Rewrite" pill appears by selected text in a text box; it, the
// right-click menu and Alt+Shift+R open a menu of rewrites for just that selection. Selected text
// outside a text box can be rewritten too, and copied.
import { h, debounce } from '../dom.js';
import { placeBox, icon, ICONS } from './ui.js';
import { rewriteView } from './rewrite.js';
import { rewriteReady } from '../../shared/settings.js';
import { wordCount } from '../../shared/text.js';

const CONTEXT_CHARS = 600;

export class SelectionTools {
  constructor(ctl) {
    this.ctl = ctl;
    this.pill = null;
    this.menu = null;
    this.view = null;
    this.lastPointer = null; // where the mouse went up, for selections in textareas
    this.update = debounce(() => this.refresh(), 180);
  }

  /** The current selection worth rewriting: { session?, start?, end?, text, before, after, rect }. */
  current() {
    const s = this.ctl.active;
    if (s) {
      const sel = s.adapter.selectionOffsets();
      if (sel && sel.end > sel.start) {
        const text = sel.text.slice(sel.start, sel.end);
        return {
          session: s, start: sel.start, end: sel.end, text,
          before: sel.text.slice(Math.max(0, sel.start - CONTEXT_CHARS), sel.start),
          after: sel.text.slice(sel.end, sel.end + CONTEXT_CHARS),
          rect: this.rectFor(s),
        };
      }
    }
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString();
    if (!text.trim()) return null;
    const range = sel.getRangeAt(0);
    const rects = [...range.getClientRects()];
    return { text, before: '', after: '', rect: rects[rects.length - 1] || range.getBoundingClientRect() };
  }

  rectFor(session) {
    if (session.kind === 'editor') {
      const sel = document.getSelection();
      if (sel?.rangeCount) {
        const rects = [...sel.getRangeAt(0).getClientRects()];
        if (rects.length) return rects[rects.length - 1];
      }
    }
    const p = this.lastPointer;
    if (p && Date.now() - p.t < 4000) return { left: p.x, right: p.x, top: p.y - 10, bottom: p.y + 10 };
    const r = session.el.getBoundingClientRect();
    return { left: r.right - 120, right: r.right - 120, top: r.top, bottom: r.top + 24 };
  }

  refresh() {
    if (this.menu) return;
    const s = this.ctl.settings;
    const cur = this.ctl.active && s.selectionButton && rewriteReady(s) ? this.current() : null;
    if (!cur || !cur.session || !cur.session.claudeAllowed || wordCount(cur.text) < 2) {
      this.hidePill();
      return;
    }
    if (!this.pill) {
      this.pill = h('button', { class: 'pm-pill', type: 'button', title: 'Rewrite the selected text with Claude (Alt+Shift+R)' },
        icon(ICONS.sparkle, { fill: 'currentColor' }), 'Rewrite');
      this.pill.addEventListener('click', (e) => { if (e.isTrusted) this.openMenu(); });
      this.ctl.ui.add(this.pill);
    }
    placeBox(this.pill, cur.rect, { origin: this.ctl.ui.origin(), gap: 8 });
  }

  hidePill() {
    this.pill?.remove();
    this.pill = null;
  }

  /**
   * Opens the rewrite menu for the current selection. mode: start that rewrite right away.
   * fallbackText: what Chrome says is selected (right-click menu), for selections this script
   * can't see, such as inside a text box Penmend doesn't check; those can be copied, not replaced.
   */
  openMenu(mode, fallbackText = '') {
    let cur = this.current();
    if (!cur && fallbackText.trim()) {
      const p = this.lastPointer;
      const x = p ? p.x : window.innerWidth / 2;
      const y = p ? p.y : window.innerHeight / 3;
      cur = { text: fallbackText, before: '', after: '', rect: { left: x, right: x, top: y - 10, bottom: y + 10 } };
    }
    this.hidePill();
    if (!cur) return false;
    this.closeMenu();
    const settings = this.ctl.settings;
    if (!rewriteReady(settings)) {
      this.ctl.openSettings('claude');
      return true;
    }
    const { session } = cur;
    this.view = rewriteView({
      text: cur.text,
      before: cur.before,
      after: cur.after,
      settings,
      secretBox: Boolean(session && !session.claudeAllowed),
      canReplace: Boolean(session),
      onReplace: (next) => {
        const done = session.adapter.replace(cur.start, cur.end, next, cur.text);
        if (done === true) this.closeMenu();
        return done;
      },
      autoMode: mode && mode !== 'custom' ? mode : null,
      focusCustom: mode === 'custom',
    });
    this.menu = h('div', { class: 'pm-float pm-menu', role: 'dialog', 'aria-label': 'Rewrite selection' },
      h('div', { class: 'pm-head' },
        h('span', { class: 'pm-logo' }, icon(ICONS.mark, { width: 2.6 })),
        h('div', { class: 'pm-title' }, 'Rewrite selection'),
        h('button', { class: 'pm-x', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => this.closeMenu() }, '×')),
      h('div', { class: 'pm-menu-body' }, this.view.el));
    this.ctl.ui.add(this.menu);
    this.anchor = cur.rect;
    placeBox(this.menu, cur.rect, { origin: this.ctl.ui.origin(), gap: 8 });
    // Re-place as the content grows (streaming text).
    this.resizer = new ResizeObserver(() => this.menu && placeBox(this.menu, this.anchor, { origin: this.ctl.ui.origin(), gap: 8 }));
    this.resizer.observe(this.menu);
    return true;
  }

  closeMenu() {
    this.view?.destroy();
    this.view = null;
    this.resizer?.disconnect();
    this.resizer = null;
    this.menu?.remove();
    this.menu = null;
  }

  close() {
    this.closeMenu();
    this.hidePill();
  }
}
