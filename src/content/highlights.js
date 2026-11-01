// Underlines in rich editors use the CSS Custom Highlight API: the browser paints styled Ranges
// (highlights.css) without a single change to the page's DOM, and keeps them in place while the
// text reflows or scrolls. One registry per document holds every editor's ranges.

export const NAMES = { red: 'pm-red', blue: 'pm-blue', active: 'pm-active', activeBlue: 'pm-active-blue' };

export const HIGHLIGHT_CSS = `
::highlight(pm-red) { text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: #e5484d; text-decoration-thickness: 2px; text-underline-offset: 3px; text-decoration-skip-ink: none; }
::highlight(pm-blue) { text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: #3e7bfa; text-decoration-thickness: 2px; text-underline-offset: 3px; text-decoration-skip-ink: none; }
::highlight(pm-active) { background-color: rgba(229, 72, 77, 0.18); }
::highlight(pm-active-blue) { background-color: rgba(62, 123, 250, 0.16); }
`;

export function highlightsSupported() {
  return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
}

export class HighlightRegistry {
  constructor() {
    this.byOwner = new Map(); // owner -> { red: Range[], blue: Range[], active: Range[], activeBlue: Range[] }
    this.styled = new WeakSet(); // shadow roots that got the ::highlight rules
  }

  set(owner, groups) {
    this.byOwner.set(owner, groups);
    this.flush();
  }

  delete(owner) {
    if (this.byOwner.delete(owner)) this.flush();
  }

  flush() {
    if (!highlightsSupported()) return;
    for (const [key, name] of Object.entries(NAMES)) {
      const ranges = [];
      for (const g of this.byOwner.values()) if (g[key]) ranges.push(...g[key]);
      if (ranges.length) {
        const hl = new Highlight(...ranges);
        hl.priority = key.startsWith('active') ? 2 : 1;
        CSS.highlights.set(name, hl);
      } else {
        CSS.highlights.delete(name);
      }
    }
  }

  /** Editors inside a shadow root need the ::highlight rules inside that root too. */
  styleRootOf(el) {
    const root = el.getRootNode();
    if (!(root instanceof ShadowRoot) || this.styled.has(root)) return;
    const style = document.createElement('style');
    style.textContent = HIGHLIGHT_CSS;
    style.setAttribute('data-pm-ui', '');
    root.appendChild(style);
    this.styled.add(root);
  }
}
