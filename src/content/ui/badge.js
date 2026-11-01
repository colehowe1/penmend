// The round badge in the corner of the text box you're in: a check when all is well, the number of
// issues otherwise, a spinning ring while Claude is checking. Click it for the panel.
import { visibleRect } from '../dom.js';
import { icon, ICONS } from './ui.js';

export class Badge {
  constructor(ctl) {
    this.ctl = ctl;
    this.session = null;
    this.el = document.createElement('button');
    this.el.className = 'pm-badge';
    this.el.type = 'button';
    this.el.style.display = 'none';
    this.el.addEventListener('click', (e) => {
      if (e.isTrusted && this.session) this.ctl.panel.toggle(this.session);
    });
    ctl.ui.add(this.el);
  }

  /** Shows the badge for a session (or hides it for null) and refreshes its look. */
  show(session) {
    this.session = session && session.kind !== 'input' ? session : null;
    this.update();
  }

  update() {
    const s = this.session;
    if (!s || s.disposed) {
      this.el.style.display = 'none';
      return;
    }
    const red = s.issues.filter((i) => i.tone !== 'blue').length;
    const blue = s.issues.length - red + s.hiddenRewrites.length;
    const total = red + blue;
    this.el.className = `pm-badge${total ? (red ? ' red' : ' blue') : ''}${s.claudeBusy ? ' busy' : ''}${s.localError ? ' off' : ''}`;
    this.el.replaceChildren(total ? String(total > 99 ? '99+' : total) : icon(ICONS.check, { width: 3 }));
    const parts = [total ? `${total} suggestion${total === 1 ? '' : 's'}` : 'No issues found'];
    if (s.claudeBusy) parts.push('Claude is checking…');
    else if (s.claudeError) parts.push(`Claude: ${s.claudeError}`);
    if (s.localError) parts.push(s.localError);
    this.el.title = `Penmend: ${parts.join(' · ')}`;
    this.el.setAttribute('aria-label', this.el.title);
    this.position();
  }

  position() {
    const s = this.session;
    if (!s || s.disposed) return;
    const r = s.el.getBoundingClientRect();
    const v = visibleRect(r, []);
    if (!v || v.height < 26 || v.width < 60) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = 'grid';
    const scrollbar = s.kind === 'textarea' ? Math.max(0, s.el.offsetWidth - s.el.clientWidth - s.el.clientLeft * 2) : 0;
    const size = 24;
    const inset = v.height < 60 ? 4 : 8;
    const o = this.ctl.ui.origin();
    this.el.style.left = `${Math.round(v.right - size - inset - scrollbar - o.x)}px`;
    this.el.style.top = `${Math.round(v.bottom - size - inset - o.y)}px`;
  }
}
