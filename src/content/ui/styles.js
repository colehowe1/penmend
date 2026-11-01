// Styles for everything Penmend draws on a page. They live inside a shadow root, so the page's
// CSS can't reach them and they can't reach the page.

export const UI_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.pm {
  --bg: #ffffff; --fg: #1d2129; --muted: #667085; --line: #e6e8ec; --soft: #f5f7fa; --hover: #f2f4f7;
  --red: #e5484d; --red-soft: #fdecec; --blue: #3e7bfa; --blue-soft: #eaf1ff; --green: #12a150;
  --accent: #0f766e; --accent-fg: #ffffff; --ins: #dcfce7; --ins-fg: #05603a; --del: #fde8e8; --del-fg: #b42318;
  --shadow: 0 12px 32px rgba(16, 24, 40, 0.18), 0 2px 6px rgba(16, 24, 40, 0.08);
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif;
  color: var(--fg);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .pm {
    --bg: #1d2129; --fg: #eef0f3; --muted: #9aa3b2; --line: #333a46; --soft: #262c36; --hover: #2a313c;
    --red-soft: #3a2224; --blue-soft: #1e2b45; --ins: #12391f; --ins-fg: #8ce99a; --del: #3d1d1d; --del-fg: #ffa8a8;
    --shadow: 0 12px 32px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3);
  }
}
button { font: inherit; color: inherit; }
button:focus-visible, textarea:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* Text box overlays (textarea / input underlines) */
.pm-mirror { position: fixed; overflow: hidden; pointer-events: none; z-index: 1; }
.pm-mirror-inner { position: absolute; left: 0; top: 0; margin: 0; border: 0; color: transparent; background: transparent; }
.pm-u { color: transparent; text-decoration-line: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; text-decoration-skip-ink: none; border-radius: 2px; }
.pm-u.red { text-decoration-color: var(--red); }
.pm-u.blue { text-decoration-color: var(--blue); }
.pm-u.active { background: rgba(229, 72, 77, 0.18); }
.pm-u.blue.active { background: rgba(62, 123, 250, 0.16); }

/* Floating pieces */
.pm-float { position: fixed; z-index: 3; pointer-events: auto; background: var(--bg); border: 1px solid var(--line); box-shadow: var(--shadow); }

/* Badge */
.pm-badge { position: fixed; z-index: 2; pointer-events: auto; width: 24px; height: 24px; border-radius: 50%;
  display: grid; place-items: center; cursor: pointer; border: 2px solid var(--bg); padding: 0;
  background: var(--green); color: #fff; font-weight: 700; font-size: 11px; line-height: 1;
  box-shadow: 0 2px 8px rgba(16, 24, 40, 0.25); transition: transform 0.12s ease; }
.pm-badge:hover { transform: scale(1.08); }
.pm-badge.red { background: var(--red); }
.pm-badge.blue { background: var(--blue); }
.pm-badge.off { background: #98a2b3; }
.pm-badge svg { width: 13px; height: 13px; }
.pm-badge.busy::after { content: ""; position: absolute; inset: -4px; border-radius: 50%;
  border: 2px solid transparent; border-top-color: var(--accent); animation: pm-spin 0.8s linear infinite; }
@keyframes pm-spin { to { transform: rotate(360deg); } }

/* Issue card */
.pm-card { width: 316px; border-radius: 12px; padding: 12px 14px 10px; }
.pm-card-head { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--muted); }
.pm-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--red); flex: none; }
.pm-dot.blue { background: var(--blue); }
.pm-src { font-size: 10.5px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: var(--soft); color: var(--muted); }
.pm-x { margin-left: auto; border: 0; background: none; cursor: pointer; color: var(--muted); font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 6px; }
.pm-x:hover { background: var(--hover); color: var(--fg); }
.pm-fixes { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 10px 0 8px; }
.pm-orig { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--red); margin-right: 2px; word-break: break-word; }
.pm-arrow { color: var(--muted); }
.pm-sugg { border: 0; background: var(--green); color: #fff; font-weight: 600; padding: 4px 10px; border-radius: 8px; cursor: pointer; max-width: 100%; word-break: break-word; text-align: left; }
.pm-sugg:hover { filter: brightness(1.06); }
.pm-sugg.alt { background: var(--bg); color: var(--fg); border: 1px solid var(--line); }
.pm-sugg.alt:hover { background: var(--hover); }
.pm-sugg.del { background: var(--red); }
.pm-msg { color: var(--fg); }
.pm-card-rw { margin: 10px 0 8px; max-height: 200px; }
.pm-rw-link { display: block; margin: 8px 0 2px; color: var(--accent); font-weight: 600; }
.pm-msg b { font-weight: 600; }
.pm-actions { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); }
.pm-link { border: 0; background: none; padding: 0; color: var(--muted); font-size: 12px; cursor: pointer; }
.pm-link:hover { color: var(--fg); text-decoration: underline; }

/* Panel */
.pm-panel { width: 372px; max-height: min(520px, calc(100vh - 24px)); border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; }
.pm-head { display: flex; align-items: center; gap: 8px; padding: 12px 12px 10px 14px; border-bottom: 1px solid var(--line); }
.pm-logo { width: 20px; height: 20px; border-radius: 6px; background: var(--accent); color: #fff; display: grid; place-items: center; flex: none; }
.pm-logo svg { width: 14px; height: 14px; }
.pm-title { font-weight: 700; font-size: 13.5px; }
.pm-sub { color: var(--muted); font-size: 12px; }
.pm-body { overflow: auto; flex: 1 1 auto; min-height: 0; }
.pm-empty { padding: 18px 14px; color: var(--muted); display: flex; gap: 10px; align-items: center; }
.pm-empty svg { width: 18px; height: 18px; color: var(--green); flex: none; }
.pm-item { display: grid; grid-template-columns: 8px 1fr auto; gap: 10px; align-items: start; padding: 9px 12px 9px 14px; cursor: pointer; border-bottom: 1px solid var(--line); }
.pm-item:last-child { border-bottom: 0; }
.pm-item:hover { background: var(--hover); }
.pm-item .pm-dot { margin-top: 6px; }
.pm-item-line { word-break: break-word; }
.pm-item-line s { color: var(--muted); text-decoration-color: var(--red); }
.pm-item-line b { color: var(--green); font-weight: 600; }
.pm-item-msg { color: var(--muted); font-size: 12px; margin-top: 2px; }
.pm-item-btns { display: flex; gap: 4px; align-items: center; }
.pm-mini { border: 1px solid var(--line); background: var(--bg); border-radius: 7px; padding: 3px 8px; font-size: 11.5px; font-weight: 600; cursor: pointer; }
.pm-mini:hover { background: var(--hover); }
.pm-mini.go { background: var(--green); border-color: var(--green); color: #fff; }
.pm-foot { border-top: 1px solid var(--line); padding: 10px 12px 12px 14px; display: flex; flex-direction: column; gap: 9px; background: var(--soft); }
.pm-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.pm-label { font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.pm-btn { border: 1px solid var(--line); background: var(--bg); padding: 5px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; }
.pm-btn:hover { background: var(--hover); }
.pm-btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.pm-btn.primary:hover { filter: brightness(1.08); }
.pm-btn:disabled { opacity: 0.55; cursor: default; }
.pm-note { font-size: 12px; color: var(--muted); }
.pm-note.err { color: var(--del-fg); }
.pm-note .pm-link { color: var(--accent); font-weight: 600; }
.pm-custom { display: flex; gap: 6px; }
.pm-custom input { flex: 1; min-width: 0; border: 1px solid var(--line); border-radius: 8px; padding: 5px 8px; background: var(--bg); color: var(--fg); font: inherit; font-size: 12px; }

/* Rewrite view */
.pm-rw { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.pm-rw-text { white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto; padding: 10px 12px; background: var(--soft); border-radius: 10px; border: 1px solid var(--line); }
.pm-rw-text ins { background: var(--ins); color: var(--ins-fg); text-decoration: none; border-radius: 3px; }
.pm-rw-text del { background: var(--del); color: var(--del-fg); border-radius: 3px; }
.pm-rw-status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.pm-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent); animation: pm-spin 0.8s linear infinite; flex: none; }
.pm-toggle { margin-left: auto; }

/* A short note (e.g. "reload this page") */
.pm-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 4; pointer-events: auto;
  max-width: min(460px, calc(100vw - 32px)); padding: 10px 16px; border-radius: 12px; background: var(--fg); color: var(--bg);
  font-weight: 600; box-shadow: var(--shadow); }

/* Selection rewrite: pill and menu */
.pm-pill { position: fixed; z-index: 3; pointer-events: auto; display: flex; align-items: center; gap: 5px; border: 0; cursor: pointer;
  padding: 4px 10px 4px 8px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; font-size: 12px; box-shadow: var(--shadow); }
.pm-pill svg { width: 13px; height: 13px; }
.pm-menu { width: 340px; border-radius: 12px; overflow: hidden; }
.pm-menu .pm-head { padding: 10px 12px; }
.pm-menu-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 9px; }
`;
