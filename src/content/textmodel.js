// Reads a rich editor (contenteditable) as plain text and keeps a map from every text offset back
// to the DOM, so an issue at text[12..19] becomes a Range over the right text nodes.

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI',
  'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH',
  'THEAD', 'TR', 'UL',
]);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
// Pictures, emoji images, widgets: they read as one opaque character, so "and 😃 images" doesn't
// become "and  images" with a double space to flag.
const OBJECT_TAGS = new Set([
  'SVG', 'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'BUTTON', 'SELECT',
  'TEXTAREA', 'INPUT', 'MATH',
]);
// Parts that aren't the author's new writing: the email being replied to (Gmail, Apple Mail and
// Thunderbird's type=cite, Proton, Yahoo, Outlook), signatures, code blocks. A quote block someone
// writes in a document (CKEditor, Tiptap, Notion) is their writing, so plain <blockquote> is checked.
const SKIP = [
  '.gmail_quote', '.gmail_extra', '.gmail_signature', '[data-smartmail="gmail_signature"]', 'blockquote[type="cite"]',
  '.protonmail_quote', '.yahoo_quoted', '[id^="divRplyFwdMsg"]', '.moz-cite-prefix', '.moz-signature',
  '#Signature', '[id^="Signature"]', 'pre', '[data-pm-skip]',
].join(',');
// Outlook on the web: everything from here down is the message being replied to.
const STOP = '#appendonsend, [id^="appendonsend"]';
// Read for context but never underlined or edited: mention chips, inline code.
const OPAQUE = '[contenteditable="false"], code, kbd, samp';

const ZERO_WIDTH = /[​-‍⁠﻿]/;
const COLLAPSIBLE = /[ \t\n\r\f]/;

export class TextModel {
  /**
   * segs: [{ start, end, node, offset }] sorted by start: text[start, end) is node.data[offset, ...).
   * opaque: [[start, end)] stretches the checkers may read but nothing may touch.
   */
  constructor(root, text, segs, opaque) {
    this.root = root;
    this.text = text;
    this.segs = segs;
    this.opaque = opaque;
  }

  /** A DOM Range for text[start, end), or null if it can't be mapped (gone, or in opaque text). */
  rangeFor(start, end) {
    if (end <= start || this.opaque.some(([a, b]) => start < b && a < end)) return null;
    const { segs } = this;
    let lo = 0;
    let hi = segs.length;
    while (lo < hi) { // first segment ending after start
      const mid = (lo + hi) >> 1;
      if (segs[mid].end > start) hi = mid; else lo = mid + 1;
    }
    const i = lo;
    lo = i;
    hi = segs.length;
    while (lo < hi) { // first segment starting at or after end
      const mid = (lo + hi) >> 1;
      if (segs[mid].start >= end) hi = mid; else lo = mid + 1;
    }
    const j = lo - 1;
    if (i >= segs.length || j < i) return null;
    const a = segs[i];
    const b = segs[j];
    const s = Math.max(start, a.start);
    const e = Math.min(end, b.end);
    if (e <= s) return null;
    try {
      const range = a.node.ownerDocument.createRange();
      range.setStart(a.node, a.offset + (s - a.start));
      range.setEnd(b.node, b.offset + (e - b.start));
      return range;
    } catch {
      return null; // the editor changed under us; the next read rebuilds the map
    }
  }

  /** A collapsed Range (a caret) at a text offset: inside the segment holding it, else the next one. */
  caretAt(offset) {
    const seg = this.segs.find((s) => offset >= s.start && offset <= s.end) || this.segs.find((s) => s.start >= offset)
      || this.segs[this.segs.length - 1];
    if (!seg) return null;
    const at = Math.min(Math.max(offset, seg.start), seg.end);
    try {
      const range = seg.node.ownerDocument.createRange();
      range.setStart(seg.node, seg.offset + (at - seg.start));
      range.collapse(true);
      return range;
    } catch {
      return null;
    }
  }

  /** Text offset of a DOM point (a caret or selection end), or -1 if it is outside the text. */
  offsetAt(node, offset) {
    if (!node || !this.root.contains(node)) return -1;
    if (node.nodeType === Node.TEXT_NODE) {
      let best = -1;
      for (const s of this.segs) {
        if (s.node !== node) continue;
        const len = s.end - s.start;
        if (offset < s.offset) return best >= 0 ? best : s.start;
        if (offset <= s.offset + len) return s.start + (offset - s.offset);
        best = s.end;
      }
      if (best >= 0) return best;
    }
    const point = node.ownerDocument.createRange();
    try {
      point.setStart(node, offset);
    } catch {
      return -1;
    }
    for (const s of this.segs) {
      if (point.comparePoint(s.node, s.offset) >= 0) return s.start;
    }
    return this.text.length;
  }
}

// Things a whole-text rewrite can't put back: pictures, quotes, signatures, tables, chips.
const FOREIGN = `img, picture, video, audio, iframe, object, embed, svg, canvas, table, hr, button, input, select, textarea, [contenteditable="false"], ${SKIP}, ${STOP}`;

/** True if replacing this Range would also delete something other than text and line breaks. */
export function rangeHoldsForeign(range) {
  const frag = range.cloneContents();
  return Boolean(frag.querySelector?.(FOREIGN));
}

/** Builds the TextModel for an editor root. */
export function readContentEditable(root) {
  const ws = getComputedStyle(root).whiteSpace;
  const collapse = ws === 'normal' || ws === 'nowrap' || ws === 'pre-line';
  const keepNewlines = ws === 'pre-line';
  let text = '';
  const segs = [];
  const opaque = [];
  let stopped = false;

  const lineBreak = () => {
    if (text && !text.endsWith('\n')) text += '\n';
  };

  const addText = (node, isOpaque) => {
    const data = node.data;
    if (isOpaque) {
      const before = text.length;
      text += data.replace(/[\s ]+/g, ' ').replace(/[​-‍⁠﻿]/g, '');
      if (text.length > before) opaque.push([before, text.length]);
      return;
    }
    let segStart = -1;
    let textStart = 0;
    const close = () => {
      if (segStart >= 0) segs.push({ start: textStart, end: text.length, node, offset: segStart });
      segStart = -1;
    };
    for (let i = 0; i < data.length; i++) {
      let ch = data[i];
      if (ZERO_WIDTH.test(ch)) {
        close();
        continue;
      }
      if (ch === ' ') {
        ch = ' ';
      } else if (collapse && COLLAPSIBLE.test(ch) && !(keepNewlines && ch === '\n')) {
        if (!text || text.endsWith(' ') || text.endsWith('\n')) {
          close();
          continue;
        }
        ch = ' ';
      } else if (ch === '\r') {
        close();
        continue;
      }
      if (segStart < 0) {
        segStart = i;
        textStart = text.length;
      }
      text += ch;
    }
    close();
  };

  const walk = (parent, isOpaque) => {
    for (let n = parent.firstChild; n && !stopped; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE) {
        addText(n, isOpaque);
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      if (n.matches(STOP)) {
        stopped = true;
        return;
      }
      const tag = n.localName.toUpperCase(); // tagName is lowercase for SVG and MathML
      if (tag === 'BR') {
        text += isOpaque ? ' ' : '\n';
        continue;
      }
      if (DROP_TAGS.has(tag) || n.hidden) continue;
      if (OBJECT_TAGS.has(tag)) {
        opaque.push([text.length, text.length + 1]);
        text += '\ufffc';
        continue;
      }
      if (n.matches(SKIP)) {
        lineBreak();
        continue;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) lineBreak();
      walk(n, isOpaque || n.matches(OPAQUE));
      if (block) lineBreak();
    }
  };

  walk(root, false);
  return new TextModel(root, text, segs, opaque);
}
