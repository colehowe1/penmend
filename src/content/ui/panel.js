// The panel the badge opens: every issue in the text box with one-click fixes, "Fix all", a Claude
// check on demand, and rewrites of the whole text.
import { h } from '../dom.js';
import { placeBox, icon, ICONS } from './ui.js';
import { rewriteView, MODES } from './rewrite.js';
import { aiCheckReady, rewriteReady } from '../../shared/settings.js';

export class Panel {
  constructor(ctl) {
    this.ctl = ctl;
    this.session = null;
    this.el = null;
    this.view = 'issues';
    this.rewrite = null;
  }

  get isOpen() {
    return Boolean(this.el);
  }

  toggle(session) {
    if (this.el && this.session === session) this.close();
    else this.open(session);
  }

  open(session, view = 'issues', opts = {}) {
    this.close();
    this.session = session;
    this.view = view;
    this.el = h('div', { class: 'pm-float pm-panel', role: 'dialog', 'aria-label': 'Penmend' });
    this.ctl.ui.add(this.el);
    this.ctl.card.close();
    this.render(opts);
  }

  close() {
    this.rewrite?.destroy();
    this.rewrite = null;
    this.el?.remove();
    this.el = null;
    this.session = null;
  }

  /** Called when the session's issues change. */
  refresh(session) {
    if (this.el && this.session === session && this.view === 'issues') this.render();
  }

  render(opts = {}) {
    const s = this.session;
    if (!this.el || !s) return;
    const settings = this.ctl.settings;
    const head = h('div', { class: 'pm-head' },
      h('span', { class: 'pm-logo' }, icon(ICONS.mark, { width: 2.6 })),
      h('div', {},
        h('div', { class: 'pm-title' }, this.view === 'rewrite' ? 'Rewrite this text' : 'Penmend'),
        h('div', { class: 'pm-sub' }, this.subtitle(s))),
      h('button', { class: 'pm-x', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => this.close() }, '×'));

    if (this.view === 'rewrite') {
      this.rewrite?.destroy();
      const original = s.text; // Replace only if the box still reads exactly what was rewritten
      this.rewrite = rewriteView({
        text: original,
        settings,
        secretBox: !s.claudeAllowed,
        canReplace: true,
        onReplace: (next) => this.ctl.replaceAll(s, next, original),
        onBack: () => { this.view = 'issues'; this.render(); },
        autoMode: opts.mode,
        focusCustom: opts.focusCustom,
      });
      this.el.replaceChildren(head, h('div', { class: 'pm-body' }, this.rewrite.el));
      this.place();
      return;
    }

    // Rewrites of sentences that also have fixes aren't underlined; the list still has them.
    const all = [...s.issues, ...s.hiddenRewrites].sort((a, b) => a.start - b.start || a.end - b.end);
    const list = all.length
      ? all.map((i) => this.item(s, i))
      : [h('div', { class: 'pm-empty' }, icon(ICONS.check, { width: 3 }), s.text.trim() ? 'Nothing to fix here.' : 'Start typing and Penmend will check as you go.')];

    const fixable = s.issues.filter((i) => i.tone !== 'blue' && i.suggestions.length);
    const foot = [];
    const actions = [];
    if (fixable.length > 1) {
      actions.push(h('button', { class: 'pm-btn primary', onclick: () => this.ctl.fixAll(s) }, `Fix all ${fixable.length} errors`));
    }
    if (aiCheckReady(settings) && s.claudeAllowed) {
      actions.push(h('button', {
        class: 'pm-btn',
        disabled: s.claudeBusy || !s.text.trim(),
        onclick: () => s.checkWithClaude({ manual: true }),
      }, s.claudeBusy ? 'Claude is checking…' : 'Check with Claude'));
    }
    if (actions.length) foot.push(h('div', { class: 'pm-row' }, actions));
    if (s.claudeError) foot.push(h('div', { class: 'pm-note err' }, `Claude: ${s.claudeError}`));
    if (!s.claudeAllowed && rewriteReady(settings)) {
      foot.push(h('div', { class: 'pm-note' }, 'Claude stays out of this box: it looks like it is for passwords, keys or code.'));
    } else if (s.sensitiveCount && aiCheckReady(settings)) {
      const n = s.sensitiveCount;
      foot.push(h('div', { class: 'pm-note' }, `Claude skipped ${n} line${n === 1 ? '' : 's'} that look${n === 1 ? 's' : ''} like ${n === 1 ? 'it holds' : 'they hold'} a password, key or number to keep private.`));
    }

    if (rewriteReady(settings) && s.claudeAllowed) {
      const hasStyle = settings.useStyle && String(settings.styleNotes || '').trim();
      foot.push(h('div', { class: 'pm-label' }, 'Rewrite all of it'));
      foot.push(h('div', { class: 'pm-row' },
        MODES.filter(([m]) => ['improve', 'shorten', 'professional', 'friendly', hasStyle ? 'mine' : ''].includes(m))
          .map(([mode, label]) => h('button', {
            class: 'pm-btn',
            disabled: !s.text.trim(),
            onclick: () => { this.view = 'rewrite'; this.render({ mode }); },
          }, label)),
        h('button', {
          class: 'pm-btn',
          disabled: !s.text.trim(),
          onclick: () => { this.view = 'rewrite'; this.render({ focusCustom: true }); },
        }, 'More…')));
    } else if (!rewriteReady(settings)) {
      foot.push(h('div', { class: 'pm-note' }, 'Add a Claude API key for deeper checks and rewrites. ',
        h('button', { class: 'pm-link', onclick: () => this.ctl.openSettings('claude') }, 'Set up Claude')));
    }
    foot.push(h('div', { class: 'pm-row' },
      h('button', { class: 'pm-link', onclick: () => this.ctl.openSettings() }, 'Settings'),
      h('span', { class: 'pm-note' }, '·'),
      h('button', { class: 'pm-link', onclick: () => this.ctl.disableSite() }, `Turn off on ${this.ctl.siteLabel()}`)));

    this.el.replaceChildren(head, h('div', { class: 'pm-body' }, list), h('div', { class: 'pm-foot' }, foot));
    this.place();
  }

  subtitle(s) {
    if (this.view === 'rewrite') return 'With Claude, using your style settings';
    const n = s.issues.length + s.hiddenRewrites.length;
    const parts = [n ? `${n} suggestion${n === 1 ? '' : 's'}` : 'All clear'];
    if (s.claudeBusy) parts.push('Claude is checking…');
    else if (s.claudeChecked) parts.push('checked by Claude');
    return parts.join(' · ');
  }

  item(s, i) {
    const sugg = i.suggestions[0];
    const line = i.rewrite
      ? h('span', {}, h('b', {}, sugg.length > 160 ? `${sugg.slice(0, 157).trimEnd()}…` : sugg))
      : sugg == null
      ? h('span', {}, h('s', {}, i.original))
      : sugg === ''
        ? h('span', {}, 'Remove ', h('s', {}, i.original))
        : h('span', {}, i.original.trim() ? [h('s', {}, i.original), ' → '] : 'Add ', h('b', {}, sugg));
    return h('div', {
      class: 'pm-item',
      title: 'Show it in the text',
      onclick: () => this.ctl.revealIssue(s, i),
    },
    h('span', { class: `pm-dot${i.tone === 'blue' ? ' blue' : ''}` }),
    h('div', {},
      h('div', { class: 'pm-item-line' }, line),
      h('div', { class: 'pm-item-msg' }, `${i.label}${i.source !== 'local' ? ' · Claude' : ''}${i.message ? ` · ${i.message.replace(/`/g, '')}` : ''}`)),
    h('div', { class: 'pm-item-btns' },
      sugg != null ? h('button', {
        class: 'pm-mini go',
        title: i.rewrite ? 'Use this version of the sentence' : 'Apply this fix',
        onclick: (e) => { e.stopPropagation(); this.ctl.applyFix(s, i, sugg); },
      }, i.rewrite ? 'Use' : 'Fix') : null,
      h('button', {
        class: 'pm-mini',
        title: 'Ignore',
        'aria-label': 'Ignore',
        onclick: (e) => { e.stopPropagation(); this.ctl.ignore(s, i); },
      }, '×')));
  }

  /** Next to the badge, inside the viewport. */
  place() {
    if (!this.el || !this.session) return;
    const badge = this.ctl.badge.el;
    const anchor = badge.style.display !== 'none'
      ? badge.getBoundingClientRect()
      : this.session.el.getBoundingClientRect();
    placeBox(this.el, anchor, { origin: this.ctl.ui.origin(), gap: 8, align: 'end' });
  }
}
