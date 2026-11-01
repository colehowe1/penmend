// The layer Penmend draws in: one custom element per document, with a shadow root holding the
// styles, the text box overlays and the floating card/badge/panel. It sits above the page and
// takes no clicks except on its own controls.
import { UI_CSS } from './styles.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A small stroke icon from SVG path data. */
export function icon(d, { fill = 'none', viewBox = '0 0 24 24', width = 2.2 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  for (const part of [].concat(d)) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', part);
    p.setAttribute('fill', fill);
    p.setAttribute('stroke', fill === 'none' ? 'currentColor' : 'none');
    p.setAttribute('stroke-width', String(width));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  return svg;
}

export const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  mark: ['M5.5 11.5l4 4 9-9.5', 'M5.5 19.5h13'], // Penmend's mark: a check over a line of text
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 15l.7 2.1 2.1.7-2.1.7L19 20.6l-.7-2.1-2.1-.7 2.1-.7z'],
};

export class UI {
  /** debug: an open shadow root, so tests (and you, in DevTools) can look inside. */
  constructor({ debug = false } = {}) {
    this.host = document.createElement('penmend-ui');
    this.host.setAttribute('data-pm-ui', '');
    this.host.style.cssText = 'all: initial !important; position: fixed !important; inset: 0 auto auto 0 !important; width: 0 !important; height: 0 !important; overflow: visible !important; z-index: 2147483647 !important; pointer-events: none !important; display: block !important;';
    // Closed: the page's scripts can't reach in to read or press anything.
    this.shadow = this.host.attachShadow({ mode: debug ? 'open' : 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    this.layer = document.createElement('div');
    this.layer.className = 'pm';
    this.shadow.append(style, this.layer);
    this.container = null;
    this.mount(document.documentElement);
  }

  /**
   * Mounts the layer where it can be seen and used. Next to a field in an open modal <dialog> or
   * popover, the layer goes inside it (outside, a modal dialog makes everything inert) and is itself
   * shown as a popover: in the browser's top layer, above the dialog, positioned against the window
   * and never clipped by the dialog's own scroll box. Elsewhere, on <html>.
   */
  mountFor(field) {
    let top = null;
    // Walk up through shadow roots too: an editor inside a web component inside a dialog.
    for (let n = field; n && !top; n = n.parentElement || n.getRootNode?.().host || null) {
      if (n.nodeType === 1 && (n.matches('dialog[open]:modal') || n.matches('[popover]:popover-open'))) top = n;
    }
    this.mount(top || document.documentElement);
  }

  mount(container) {
    const top = container !== document.documentElement;
    if (this.container !== container || !this.host.isConnected) {
      if (this.host.matches(':popover-open')) this.host.hidePopover();
      this.container = container;
      container.appendChild(this.host);
      if (top) this.host.setAttribute('popover', 'manual');
      else this.host.removeAttribute('popover');
    }
    if (top) {
      try { // to the top of the top layer, above whatever the page opened since
        if (this.host.matches(':popover-open')) this.host.hidePopover();
        this.host.showPopover();
      } catch { /* not connected yet, or no popover support: stays in the dialog */ }
    }
  }

  /** Keeps the host attached if the page wiped it out (some apps replace <html>'s children). */
  ensureMounted() {
    if (!this.host.isConnected) this.mount(document.documentElement);
  }

  add(node) {
    this.ensureMounted();
    this.layer.append(node);
    return node;
  }

  /**
   * Where this layer's (0, 0) really is on screen. Normally the viewport's corner, but inside a
   * dialog with a transform (a common way to center one) "fixed" positions are relative to the
   * dialog, so everything placed in the layer subtracts this.
   */
  origin() {
    const r = this.host.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  contains(node) {
    return node === this.host || this.host.contains(node) || this.shadow.contains(node);
  }

  /** A short note at the bottom of the screen, gone after a while. */
  toast(text, ms = 6000) {
    const t = document.createElement('div');
    t.className = 'pm-toast';
    t.setAttribute('role', 'status');
    t.textContent = text;
    this.add(t);
    setTimeout(() => t.remove(), ms);
  }

  destroy() {
    this.host.remove();
  }
}

/**
 * Places a floating box next to an anchor rect: below it if it fits, else above; if neither fits
 * (a short frame), on the roomier side with its height capped and its content scrolling, so it
 * never sits on top of the word it explains. Kept inside the viewport.
 */
export function placeBox(box, anchor, { gap = 6, align = 'start', origin = { x: 0, y: 0 } } = {}) {
  box.style.maxHeight = '';
  box.style.overflowY = '';
  const w = Math.min(box.offsetWidth, window.innerWidth - 16);
  const hgt = box.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = align === 'end' ? anchor.right - w : anchor.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  const below = vh - anchor.bottom - gap - 8;
  const above = anchor.top - gap - 8;
  let top;
  if (hgt <= below) {
    top = anchor.bottom + gap;
  } else if (hgt <= above) {
    top = anchor.top - gap - hgt;
  } else {
    const room = Math.max(72, Math.max(below, above));
    box.style.maxHeight = `${room}px`;
    box.style.overflowY = 'auto';
    top = below >= above ? anchor.bottom + gap : anchor.top - gap - Math.min(hgt, room);
  }
  top = Math.max(8, Math.min(top, vh - Math.min(hgt, box.offsetHeight) - 8));
  box.style.maxWidth = `${vw - 16}px`;
  box.style.left = `${Math.round(left - origin.x)}px`;
  box.style.top = `${Math.round(top - origin.y)}px`;
}
