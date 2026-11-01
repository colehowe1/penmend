// One adapter per kind of text box: read its text, draw underlines, find the issue under the
// mouse, and change the text. Rich editors use highlights; textareas and inputs get a see-through
// copy of their text laid exactly over them, with the underlines drawn in the copy.
import { readContentEditable, rangeHoldsForeign } from './textmodel.js';
import { replaceInEditor, replaceInField } from './edit.js';
import { clipAncestors, visibleRect } from './dom.js';

export const CHANGED = 'The text changed in the meantime, so nothing was replaced. Copy it instead, or try again.';
export const FOREIGN = 'This part has a picture, quote or other element a rewrite would delete. Copy the text instead.';

function inRect(x, y, r, slack = 3) {
  return x >= r.left - 1 && x <= r.right + 1 && y >= r.top - slack && y <= r.bottom + slack;
}

export class EditorAdapter {
  constructor(el, registry) {
    this.el = el;
    this.kind = 'editor';
    this.registry = registry;
    this.model = null;
    this.ranges = new Map(); // issue id -> live Range
    registry.styleRootOf(el);
  }

  read() {
    this.model = readContentEditable(this.el);
    return this.model.text;
  }

  render(issues, activeId) {
    this.ranges.clear();
    const groups = { red: [], blue: [], active: [], activeBlue: [] };
    for (const i of issues) {
      const r = this.model?.rangeFor(i.start, i.end);
      if (!r) continue;
      this.ranges.set(i.id, r);
      groups[i.tone === 'blue' ? 'blue' : 'red'].push(r);
      if (i.id === activeId) groups[i.tone === 'blue' ? 'activeBlue' : 'active'].push(r);
    }
    this.registry.set(this, groups);
  }

  issueIdAt(x, y) {
    for (const [id, r] of this.ranges) {
      for (const rect of r.getClientRects()) if (inRect(x, y, rect)) return id;
    }
    return null;
  }

  rectFor(id) {
    const r = this.ranges.get(id);
    const rects = r ? [...r.getClientRects()] : [];
    return rects[0] || r?.getBoundingClientRect() || null;
  }

  /** Scrolls an issue into view inside the editor. */
  reveal(id) {
    const r = this.ranges.get(id);
    const node = r?.startContainer?.parentElement;
    node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  /** The selection inside this editor as text offsets { start, end }, or null. */
  selectionOffsets() {
    const root = this.el.getRootNode();
    const sel = (root !== document && root.getSelection?.()) || this.el.ownerDocument.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.el.contains(range.startContainer) || !this.el.contains(range.endContainer)) return null;
    const model = readContentEditable(this.el);
    const start = model.offsetAt(range.startContainer, range.startOffset);
    const end = model.offsetAt(range.endContainer, range.endOffset);
    if (start < 0 || end < 0) return null;
    return { start: Math.min(start, end), end: Math.max(start, end), text: model.text };
  }

  caretOffset() {
    const s = this.selectionOffsets();
    return s ? s.end : -1;
  }

  /**
   * Replaces text[start, end) if it still reads `expected`. Returns true, or a sentence saying why
   * not (the text moved on, or the stretch holds a picture, chip or quote a replace would delete).
   */
  replace(start, end, text, expected) {
    const model = readContentEditable(this.el);
    if (expected != null && model.text.slice(start, end) !== expected) return CHANGED;
    const range = model.rangeFor(start, end);
    if (!range) return FOREIGN;
    if (rangeHoldsForeign(range)) return FOREIGN;
    return replaceInEditor(this.el, range, text) ? true : CHANGED;
  }

  /** Replaces all of the author's text (not quoted replies or signatures) if it still reads `expected`. */
  replaceAll(text, expected) {
    const model = readContentEditable(this.el);
    if (expected != null && model.text !== expected) return CHANGED;
    const first = model.segs[0];
    const last = model.segs[model.segs.length - 1];
    if (!first) return CHANGED;
    const range = model.rangeFor(first.start, last.end);
    if (!range || rangeHoldsForeign(range)) return FOREIGN;
    return replaceInEditor(this.el, range, text.replace(/\n+$/, '')) ? true : CHANGED;
  }

  /** The caret as a live DOM Range (it follows edits elsewhere in the editor), or null. */
  liveCaret() {
    const root = this.el.getRootNode();
    const sel = (root !== document && root.getSelection?.()) || this.el.ownerDocument.getSelection();
    if (!sel?.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return this.el.contains(r.startContainer) ? r.cloneRange() : null;
  }

  /** Puts the selection back to a Range from liveCaret(). True if it could. */
  selectRange(range) {
    if (!range.startContainer.isConnected || !this.el.contains(range.startContainer)) return false;
    const root = this.el.getRootNode();
    const sel = (root !== document && root.getSelection?.()) || this.el.ownerDocument.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  /** Puts the caret at a text offset. */
  setCaret(offset) {
    const caret = readContentEditable(this.el).caretAt(offset);
    if (!caret) return;
    const root = this.el.getRootNode();
    const sel = (root !== document && root.getSelection?.()) || this.el.ownerDocument.getSelection();
    sel.removeAllRanges();
    sel.addRange(caret);
  }

  dispose() {
    this.registry.delete(this);
    this.ranges.clear();
  }
}

// Computed styles that decide where text wraps; the overlay copies them from the text box.
const MIRROR_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'fontFeatureSettings',
  'fontVariationSettings', 'fontKerning', 'fontOpticalSizing', 'fontSizeAdjust', 'letterSpacing', 'wordSpacing',
  'lineHeight', 'textTransform', 'textIndent', 'textAlign', 'textRendering', 'direction', 'unicodeBidi', 'tabSize',
  'whiteSpace', 'overflowWrap', 'wordBreak', 'hyphens', 'lineBreak', 'writingMode',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
];

export class FieldAdapter {
  constructor(el, ui) {
    this.el = el;
    this.kind = el.tagName === 'TEXTAREA' ? 'textarea' : 'input';
    this.ui = ui;
    this.mirror = ui.add(document.createElement('div'));
    this.mirror.className = 'pm-mirror';
    this.inner = document.createElement('div');
    this.inner.className = 'pm-mirror-inner';
    this.mirror.append(this.inner);
    this.spans = new Map(); // issue id -> span
    this.lastRect = '';
    this.clips = clipAncestors(el);
    this.onScroll = () => this.syncScroll();
    el.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObserver = new ResizeObserver(() => {
      this.copyStyles();
      this.position(true);
    });
    this.resizeObserver.observe(el);
    this.copyStyles();
  }

  read() {
    return this.el.value;
  }

  copyStyles() {
    const cs = getComputedStyle(this.el);
    const s = this.inner.style;
    for (const p of MIRROR_PROPS) s[p] = cs[p];
    if (this.kind === 'input') {
      s.whiteSpace = 'pre';
      const contentHeight = this.el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      s.lineHeight = `${Math.max(0, contentHeight)}px`;
      s.height = `${this.el.clientHeight}px`;
      s.width = 'max-content';
      s.minWidth = `${this.el.clientWidth}px`;
    } else {
      s.width = `${this.el.clientWidth}px`;
      s.height = 'auto';
    }
    s.boxSizing = 'border-box';
  }

  render(issues, activeId) {
    const text = this.el.value;
    const parts = [];
    this.spans.clear();
    let at = 0;
    for (const i of issues) {
      if (i.start < at || i.end > text.length) continue;
      if (i.start > at) parts.push(document.createTextNode(text.slice(at, i.start)));
      const span = document.createElement('span');
      span.className = `pm-u ${i.tone === 'blue' ? 'blue' : 'red'}${i.id === activeId ? ' active' : ''}`;
      span.textContent = text.slice(i.start, i.end);
      this.spans.set(i.id, span);
      parts.push(span);
      at = i.end;
    }
    parts.push(document.createTextNode(`${text.slice(at)}​`));
    this.inner.replaceChildren(...parts);
    this.position(true);
  }

  /**
   * Lays the overlay over the text box's padding box, clipped like the box itself, and hides it
   * while something covers the box. Coverage is looked at on every pass (a menu can open over a box
   * that doesn't move); the geometry only when the box moved.
   */
  position(force = false) {
    const r = this.el.getBoundingClientRect();
    const visible = this.el.isConnected && r.width > 0 && r.height > 0 ? visibleRect(r, this.clips) : null;
    if (!visible || this.covered(visible)) {
      this.mirror.style.display = 'none';
      this.lastRect = '';
      return;
    }
    const key = `${r.left},${r.top},${r.width},${r.height},${this.el.clientWidth},${this.el.clientHeight}`;
    if (!force && key === this.lastRect) return;
    this.lastRect = key;
    const left = r.left + this.el.clientLeft;
    const top = r.top + this.el.clientTop;
    const o = this.ui.origin();
    const m = this.mirror.style;
    m.display = 'block';
    m.left = `${left - o.x}px`;
    m.top = `${top - o.y}px`;
    m.width = `${this.el.clientWidth}px`;
    m.height = `${this.el.clientHeight}px`;
    const clip = [
      Math.max(0, visible.top - top), Math.max(0, left + this.el.clientWidth - visible.right),
      Math.max(0, top + this.el.clientHeight - visible.bottom), Math.max(0, visible.left - left),
    ];
    m.clipPath = clip.some((v) => v > 0) ? `inset(${clip.map((v) => `${v}px`).join(' ')})` : '';
    this.syncScroll();
  }

  /**
   * Something (a menu, a modal) sits over the middle of the box: hide the underlines with it. Asked
   * in the box's own tree, so a box inside a web component isn't "covered" by its own host.
   */
  covered(v) {
    const root = this.el.getRootNode();
    if (root.activeElement === this.el) return false;
    const scope = typeof root.elementFromPoint === 'function' ? root : this.el.ownerDocument;
    const top = scope.elementFromPoint(v.left + v.width / 2, v.top + v.height / 2);
    if (!top || top === this.el || this.el.contains(top) || this.ui.contains(top)) return false;
    for (let host = root.host; host; host = host.getRootNode().host) if (host === top) return false;
    return true;
  }

  syncScroll() {
    this.inner.style.transform = `translate(${-this.el.scrollLeft}px, ${-this.el.scrollTop}px)`;
  }

  issueIdAt(x, y) {
    for (const [id, span] of this.spans) {
      for (const rect of span.getClientRects()) if (inRect(x, y, rect)) return id;
    }
    return null;
  }

  rectFor(id) {
    const span = this.spans.get(id);
    return span ? span.getClientRects()[0] || span.getBoundingClientRect() : null;
  }

  reveal(id) {
    const span = this.spans.get(id);
    if (!span) return;
    const top = span.offsetTop - this.inner.offsetTop;
    if (top < this.el.scrollTop || top > this.el.scrollTop + this.el.clientHeight - 20) {
      this.el.scrollTop = Math.max(0, top - this.el.clientHeight / 3);
    }
  }

  selectionOffsets() {
    const { selectionStart: start, selectionEnd: end } = this.el;
    if (start == null || end == null) return null;
    return { start, end, text: this.el.value };
  }

  caretOffset() {
    return this.el.selectionEnd ?? -1;
  }

  replace(start, end, text, expected) {
    if (expected != null && this.el.value.slice(start, end) !== expected) return CHANGED;
    return replaceInField(this.el, start, end, text) ? true : CHANGED;
  }

  replaceAll(text, expected) {
    if (expected != null && this.el.value !== expected) return CHANGED;
    return replaceInField(this.el, 0, this.el.value.length, this.kind === 'input' ? text.replace(/\s*\n\s*/g, ' ') : text) ? true : CHANGED;
  }

  setCaret(offset) {
    const at = Math.max(0, Math.min(offset, this.el.value.length));
    this.el.setSelectionRange(at, at);
  }

  dispose() {
    this.el.removeEventListener('scroll', this.onScroll);
    this.resizeObserver.disconnect();
    this.mirror.remove();
    this.spans.clear();
  }
}
