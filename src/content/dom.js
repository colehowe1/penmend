// DOM helpers for the content script.

/**
 * Creates an element: h('div', { class: 'x', onclick: fn }, 'text', child). Text is always text,
 * never HTML. Handlers only run for real input: a page script can't press our buttons.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), (e) => { if (e.isTrusted) v(e); });
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Harper writes `code` spans with backticks; show them bold, as text. */
export function richText(message) {
  const frag = document.createDocumentFragment();
  String(message).split(/(`[^`]+`)/).forEach((part) => {
    if (/^`[^`]+`$/.test(part)) frag.append(h('b', {}, part.slice(1, -1)));
    else if (part) frag.append(document.createTextNode(part));
  });
  return frag;
}

/** The focused element, looking inside open shadow roots. */
export function deepActiveElement(doc = document) {
  let el = doc.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** The outermost contenteditable element containing el (the editor's root). */
export function editingHost(el) {
  let host = el;
  for (let p = el.parentElement; p && p.isContentEditable; p = p.parentElement) host = p;
  return host;
}

const TEXT_INPUT_TYPES = new Set(['text', '']);

export function isTextInput(el) {
  if (el.tagName !== 'INPUT') return false;
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (!TEXT_INPUT_TYPES.has(type)) return false;
  const role = (el.getAttribute('role') || '').toLowerCase();
  if (role === 'combobox' || role === 'searchbox' || el.getAttribute('list')) return false;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (/(user|name|email|tel|address|postal|cc-|one-time|password)/.test(ac)) return false;
  const hint = `${el.name} ${el.id} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`.toLowerCase();
  return !/\b(search|find|filter|query|user(name)?|login|e-?mail|phone|zip|postal|code|url|address|city|first|last|name)\b/.test(hint);
}

const CODE_EDITORS = '.CodeMirror, .cm-editor, .cm-content, .monaco-editor, .ace_editor, [data-pm-off]';

/** Fields the page says not to touch: Grammarly's opt-out attributes, code editors, read-only. */
export function optedOut(el) {
  if (el.readOnly || el.disabled || el.getAttribute('aria-readonly') === 'true') return true;
  for (let p = el; p && p.nodeType === 1; p = p.parentElement) {
    if (p.getAttribute('data-gramm') === 'false' || p.getAttribute('data-gramm_editor') === 'false'
      || p.getAttribute('data-enable-grammarly') === 'false') return true;
  }
  return Boolean(el.closest(CODE_EDITORS));
}

/** Big enough to be a real text box (not an off-screen key catcher). */
export function looksVisible(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 24 || r.height < 12) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
}

/** The text a field shows, for textarea/input. */
export function fieldValue(el) {
  return el.value ?? '';
}

/** Scroll containers that can clip el, innermost first, plus the viewport as a final clip. */
export function clipAncestors(el) {
  const out = [];
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY)) out.push(p);
  }
  return out;
}

/** The visible part of rect after clipping by ancestors and the viewport, or null. */
export function visibleRect(rect, ancestors) {
  let { left, top, right, bottom } = rect;
  for (const a of ancestors) {
    const r = a.getBoundingClientRect();
    left = Math.max(left, r.left);
    top = Math.max(top, r.top);
    right = Math.min(right, r.right);
    bottom = Math.min(bottom, r.bottom);
  }
  left = Math.max(left, 0);
  top = Math.max(top, 0);
  right = Math.min(right, window.innerWidth);
  bottom = Math.min(bottom, window.innerHeight);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}
