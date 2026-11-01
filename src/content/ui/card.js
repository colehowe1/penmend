// The card that opens when you click an underlined word: the fix(es), why, and what else you can do.
// A sentence rewrite's card shows the new sentence, with what it adds marked.
import { h, richText } from '../dom.js';
import { placeBox } from './ui.js';
import { diffFragment } from './rewrite.js';

/** The rewritten sentence, with the words it brings in marked (what it drops isn't shown). */
function rewriteView(original, replacement) {
  const frag = diffFragment(original, replacement);
  for (const d of frag.querySelectorAll('del')) d.remove();
  return h('div', { class: 'pm-rw-text pm-card-rw' }, frag);
}

export class Card {
  constructor(ctl) {
    this.ctl = ctl;
    this.el = null;
    this.session = null;
    this.issue = null;
  }

  get isOpen() {
    return Boolean(this.el);
  }

  /**
   * hover: opened by resting the mouse on the word; it closes again when the mouse leaves.
   * at: the issue whose place the card opens at, if not the issue's own (a rewrite opened from a fix).
   */
  open(session, issue, { hover = false, at = null } = {}) {
    this.close();
    if (!issue) return;
    this.session = session;
    this.issue = issue;
    this.at = at;
    this.byHover = hover;
    session.setActive(issue.id);
    const blue = issue.tone === 'blue';
    const fixes = issue.rewrite
      ? [rewriteView(issue.original, issue.suggestions[0]),
        h('div', { class: 'pm-fixes' }, h('button', {
          class: 'pm-sugg',
          title: 'Put this version in the text',
          onclick: () => this.ctl.applyFix(session, issue, issue.suggestions[0]),
        }, 'Use this version'))]
      : issue.suggestions.length
      ? h('div', { class: 'pm-fixes' },
        issue.original.trim() ? h('span', { class: 'pm-orig' }, issue.original) : null,
        h('span', { class: 'pm-arrow' }, '→'),
        issue.suggestions.map((s, n) => h('button', {
          class: `pm-sugg${n ? ' alt' : ''}${s === '' ? ' del' : ''}`,
          title: s === '' ? 'Remove it' : `Use "${s}"`,
          onclick: () => this.ctl.applyFix(session, issue, s),
        }, s === '' ? 'Remove' : s)))
      : null;
    // A fix inside a sentence Claude would also rewrite: the card offers the rewrite too.
    const rewrite = !issue.rewrite && issue.rewriteId ? session.issueById(issue.rewriteId) : null;
    const actions = [
      h('button', { class: 'pm-link', onclick: () => this.ctl.ignore(session, issue) }, 'Ignore'),
    ];
    if (issue.cat === 'spelling' && /^\S+$/.test(issue.original.trim())) {
      actions.push(h('button', { class: 'pm-link', onclick: () => this.ctl.addWord(issue.original.trim()) }, 'Add to dictionary'));
    }
    if (issue.rewrite) {
      actions.push(h('button', { class: 'pm-link', title: 'Claude stops offering sentence rewrites (Settings can turn them back on)', onclick: () => this.ctl.turnOffRewrites() }, 'Turn off rewrites'));
    } else if (issue.source === 'local' && issue.rule && issue.rule !== 'SpellCheck') {
      actions.push(h('button', { class: 'pm-link', title: `Turns off Harper's "${issue.rule}" check everywhere`, onclick: () => this.ctl.turnOffRule(issue.rule) }, 'Turn off this check'));
    } else if (issue.source !== 'local') {
      actions.push(h('button', { class: 'pm-link', title: 'Claude won\'t suggest this change again', onclick: () => this.ctl.neverFlag(issue) }, 'Never flag this'));
    }
    this.el = h('div', { class: 'pm-float pm-card', role: 'dialog', 'aria-label': `${issue.label} suggestion` },
      h('div', { class: 'pm-card-head' },
        h('span', { class: `pm-dot${blue ? ' blue' : ''}` }),
        h('span', {}, issue.label),
        issue.source !== 'local' ? h('span', { class: 'pm-src', title: 'Suggested by Claude' }, 'Claude') : null,
        h('button', { class: 'pm-x', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => this.close() }, '×')),
      fixes,
      issue.message ? h('div', { class: 'pm-msg' }, richText(issue.message)) : null,
      rewrite ? h('button', { class: 'pm-link pm-rw-link', onclick: () => this.open(session, rewrite, { at: issue.id }) }, 'Rewrite the whole sentence ›') : null,
      h('div', { class: 'pm-actions' }, actions));
    this.ctl.ui.add(this.el);
    if (!this.position()) this.close();
  }

  /** Keeps the card under its word; closes it once the word scrolls out of sight. */
  position() {
    if (!this.el) return false;
    // A rewrite that isn't underlined itself opens at the issue inside its sentence.
    const adapter = this.session.adapter;
    const rect = adapter.rectFor(this.issue.id)
      || (this.at && adapter.rectFor(this.at))
      || (this.issue.anchorId ? adapter.rectFor(this.issue.anchorId) : null);
    if (!rect || rect.bottom < 0 || rect.top > window.innerHeight) {
      this.close();
      return false;
    }
    placeBox(this.el, rect, { origin: this.ctl.ui.origin(), gap: 6 });
    return true;
  }

  closeFor(session) {
    if (this.session === session) this.close();
  }

  close() {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    if (this.session && !this.session.disposed) this.session.setActive(null);
    this.session = null;
    this.issue = null;
    this.at = null;
    this.byHover = false;
  }
}
