// One text box being checked: reads its text as you type, asks Harper (every pause, ~250 ms) and
// Claude (longer pauses, per changed paragraph), merges both, and draws the result.
import { EditorAdapter, FieldAdapter } from './adapters.js';
import { fromHarper, fromClaude, mergeIssues, filterIssues, placeRewrites, ignoreKey } from './issues.js';
import { request, MSG, ExtensionGoneError } from '../shared/messaging.js';
import { splitParagraphs, hashString, wordCount, carryEdits, keepRewrites, looksSensitive } from '../shared/text.js';
import { debounce } from './dom.js';

const MAX_LOCAL_CHARS = 120_000;
const CLAUDE_BATCH_CHARS = 6_000;
const CLAUDE_MAX_PARAGRAPH = 6_000;
const CLAUDE_CACHE = 400;
// Automatic checks per text box: at most this much in any 10 minutes, then "Check with Claude" only.
// (The service worker also holds a daily spending limit across everything.)
const AUTO_WINDOW_MS = 10 * 60_000;
const AUTO_MAX_REQUESTS = 30;
const AUTO_MAX_CHARS = 60_000;
const MANUAL_MAX_ROUNDS = 25;
// Automatic checks only follow your own typing: a key, paste or drop in this box this recently.
const USER_EDIT_MS = 15_000;
const FINISHED = /[.!?…:]["'”’)\]]*\s*$/;
// Boxes for keys, code and configuration: Claude never sees them. Whole words of the box's name,
// id, class, label or placeholder ("api_key", "sshKey", "env-config"), never fragments of words
// ("description" is not "script").
const SECRET_WORDS = new Set(['password', 'passwd', 'passcode', 'passphrase', 'secret', 'secrets', 'token',
  'tokens', 'apikey', 'credential', 'credentials', 'ssh', 'privatekey', 'certificate', 'cert', 'env',
  'dotenv', 'config', 'json', 'yaml', 'yml', 'sql', 'regex', 'script', 'code', 'snippet', 'pin', 'otp', 'mfa']);
// Password managers: Claude stays off their pages entirely.
const VAULT_HOSTS = /(^|\.)(1password\.com|1password\.eu|bitwarden\.(com|eu)|lastpass\.com|dashlane\.com|keepersecurity\.(com|eu)|proton\.me)$/;
// Keys that change text (not arrows, shortcuts, or modifier keys on their own).
const EDIT_KEYS = new Set(['Backspace', 'Delete', 'Enter', 'Tab']);

function identifierWords(text) {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function fieldLooksSecret(el) {
  const words = [el.name, el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('aria-label'),
    el.getAttribute('placeholder'), el.getAttribute('data-testid'), el.getAttribute('autocomplete')]
    .flatMap(identifierWords);
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  // Joined pairs: "api key", "private key", "access token".
  return words.some((w, i) => ['api', 'private', 'access', 'secret'].includes(w) && ['key', 'token'].includes(words[i + 1]));
}

export class Session {
  constructor(ctl, el, kind) {
    this.ctl = ctl;
    this.el = el;
    this.kind = kind; // 'editor' | 'textarea' | 'input'
    this.adapter = kind === 'editor' ? new EditorAdapter(el, ctl.registry) : new FieldAdapter(el, ctl.ui);
    this.text = ''; // the text the current issues were computed for
    this.shown = ''; // the text the underlines are drawn for (moves ahead while you type)
    this.local = [];
    this.claude = new Map(); // paragraph hash -> located edits (offsets within the paragraph)
    this.carried = new Map(); // paragraph hash -> edits carried over from before the last change
    this.inflight = new Set();
    this.paragraphs = [];
    this.issues = [];
    this.rewrites = []; // Claude's sentence rewrites (some are drawn among the issues: placeRewrites)
    this.activeId = null;
    this.ignored = new Set();
    this.lintSeq = 0;
    this.dirty = true;
    this.claudeBusy = false;
    this.claudeError = null;
    this.claudeChecked = false;
    this.claudeAllowed = !fieldLooksSecret(el) && !VAULT_HOSTS.test(ctl.site || '');
    this.autoLog = []; // [time, chars] of automatic Claude requests
    this.failed = new Map(); // paragraph hash -> why Claude couldn't check it (not re-sent until it changes)
    this.splitBatches = false; // after a too-long answer: one paragraph per request
    this.lastUserEdit = 0; // a real key, paste, drop or cut in this box (a page's script can't fake these)
    this.lastTyped = 0; // any typing at all, for hover cards and closing the card
    this.localError = null;
    this.disposed = false;

    this.lintSoon = debounce(() => this.lint(), 250);
    this.claudeSoon = debounce(() => this.checkWithClaude(), 1600);
    this.onInput = (e) => {
      if (e.isTrusted) this.noteTyping();
      this.followTyping();
      this.lintSoon();
    };
    // Some editors (CKEditor 5) cancel beforeinput and change the text themselves, so no 'input'
    // event follows: notice typing from the keys, pastes and drops too.
    this.onUserEdit = (e) => {
      if (!e.isTrusted) return;
      if (e.type === 'keydown') {
        if (e.isComposing || e.metaKey || e.ctrlKey || (e.key.length !== 1 && !EDIT_KEYS.has(e.key))) return;
      }
      if (e.type !== 'beforeinput') this.lastUserEdit = Date.now();
      this.noteTyping();
    };
    el.addEventListener('input', this.onInput);
    for (const type of ['keydown', 'beforeinput', 'paste', 'drop', 'cut']) el.addEventListener(type, this.onUserEdit, true);
    // Accent dead keys and Asian input methods build a character before inserting it: wait for it.
    this.onCompose = (e) => {
      this.composing = e.type === 'compositionstart';
      if (!this.composing) {
        if (e.isTrusted) this.lastUserEdit = Date.now();
        this.lintSoon();
      }
    };
    el.addEventListener('compositionstart', this.onCompose);
    el.addEventListener('compositionend', this.onCompose);
    if (kind === 'editor') {
      // Text the page changes itself (signatures, undo, collaborators) doesn't fire 'input'.
      this.observer = new MutationObserver(() => this.lintSoon());
      this.observer.observe(el, { childList: true, subtree: true, characterData: true });
    }
    this.applySpellcheckSetting();
    this.lint();
  }

  /** Re-check with new settings (dictionary, categories...). */
  settingsChanged() {
    this.applySpellcheckSetting();
    this.dirty = true;
    this.lint();
  }

  /** Chrome's own red squiggles, off while Penmend checks the box (Settings), restored after. */
  applySpellcheckSetting(force) {
    const off = force ?? (this.ctl.settings.nativeSpellcheckOff && !this.disposed);
    const el = this.el;
    if (off && !el.hasAttribute('data-pm-spellcheck')) {
      el.setAttribute('data-pm-spellcheck', el.getAttribute('spellcheck') ?? '');
      el.setAttribute('spellcheck', 'false');
    } else if (!off && el.hasAttribute('data-pm-spellcheck')) {
      const prev = el.getAttribute('data-pm-spellcheck');
      if (prev === '') el.removeAttribute('spellcheck');
      else el.setAttribute('spellcheck', prev);
      el.removeAttribute('data-pm-spellcheck');
    }
  }

  /**
   * Plain text boxes: while you type, slide the underlines along with the text right away (rich
   * editors' highlights follow the text by themselves), instead of waiting for the next check.
   */
  followTyping() {
    if (this.kind === 'editor' || this.disposed || this.composing) return;
    const now = this.adapter.read();
    if (now === this.shown) return;
    this.issues = carryEdits(this.shown, now, this.issues);
    this.rewrites = carryEdits(this.shown, now, this.rewrites);
    this.shown = now;
    this.shifted = true; // these aren't the checked issues any more: rebuild when the text is back
    this.adapter.render(this.issues, this.activeId);
    this.ctl.sessionUpdated(this);
  }

  /** You're typing here: close the card, hold Claude until the next pause, keep the checker warm. */
  noteTyping() {
    this.lastTyped = Date.now();
    this.ctl.card.closeFor(this);
    this.claudeSoon.cancel();
    this.ctl.typingIn(this);
  }

  /** Recent typing of your own in this box, in the box that has focus, in a window you're using. */
  get userActive() {
    return Date.now() - this.lastUserEdit < USER_EDIT_MS && this.ctl.active === this
      && document.hasFocus() && document.visibilityState === 'visible';
  }

  /** Housekeeping: a page that sets the text from code fires no input event; notice it anyway. */
  noticeSilentChange() {
    if (this.disposed || this.kind === 'editor') return;
    if (this.adapter.read() !== this.shown) {
      this.followTyping();
      this.lintSoon();
    }
  }

  async lint() {
    if (this.disposed) return;
    if (this.composing) return; // compositionend checks again
    const text = this.adapter.read();
    if (text === this.text && !this.dirty) {
      if (this.shifted) this.rebuild(); // typed and deleted again: back to the checked issues
      // Same words, maybe new DOM (bold, a link, a list): editor highlights need fresh ranges.
      else if (this.kind === 'editor') this.adapter.render(this.issues, this.activeId);
      return;
    }
    if (text === this.inflightText && !this.dirty) return; // already being checked
    this.dirty = false;
    const seq = ++this.lintSeq;
    this.inflightText = text;
    const previous = this.paragraphs;
    let lints = [];
    if (text.length > MAX_LOCAL_CHARS) {
      this.localError = 'This text is too long to check as you type.';
    } else if (text.trim()) {
      try {
        ({ lints } = await request(MSG.LINT, { text }));
        this.localError = null;
      } catch (e) {
        if (e instanceof ExtensionGoneError) return this.ctl.shutdown({ gone: true });
        this.localError = `The spelling checker had a problem: ${e.message}`;
      }
    }
    if (this.inflightText === text) this.inflightText = null;
    if (seq !== this.lintSeq || this.disposed) return;
    if (this.adapter.read() !== text) {
      this.dirty = true; // typed while we were checking: check the newest text instead
      this.lintSoon();
      return;
    }
    this.text = text;
    this.local = fromHarper(lints, text);
    this.carryClaude(previous);
    this.rebuild();
    this.scheduleClaude();
  }

  /**
   * After an edit, keeps Claude's findings for the parts of each paragraph that didn't change, so
   * underlines don't vanish while you type elsewhere (they're shown until Claude re-checks).
   */
  carryClaude(previous) {
    const next = splitParagraphs(this.text).map((p) => ({ ...p, hash: hashString(p.text) }));
    const fresh = new Map();
    next.forEach((p, idx) => {
      if (this.claude.has(p.hash)) return;
      const old = previous[idx];
      const oldEdits = old && (this.claude.get(old.hash) || this.carried.get(old.hash));
      if (oldEdits && oldEdits.length) fresh.set(p.hash, carryEdits(old.text, p.text, oldEdits));
    });
    this.carried = fresh;
    this.paragraphs = next;
  }

  rebuild() {
    if (this.disposed) return;
    const fromAi = [];
    for (const p of this.paragraphs) {
      const edits = this.claude.get(p.hash) || this.carried.get(p.hash);
      if (edits) fromAi.push(...fromClaude(edits, p.start, p.hash));
    }
    const checked = this.paragraphs.filter((p) => this.claude.has(p.hash)).map((p) => [p.start, p.end]);
    const settings = this.ctl.settings;
    const merged = mergeIssues(this.local, fromAi.filter((i) => !i.rewrite), checked);
    const rewrites = settings.rewriteSuggestions ? fromAi.filter((i) => i.rewrite) : [];
    const placed = placeRewrites(
      filterIssues(merged, this.text, settings, this.ignored),
      filterIssues(rewrites, this.text, settings, this.ignored),
    );
    this.issues = placed.issues;
    this.rewrites = placed.rewrites;
    if (this.activeId && !this.issueById(this.activeId)) this.activeId = null;
    this.shown = this.text;
    this.shifted = false;
    this.adapter.render(this.issues, this.activeId);
    this.ctl.sessionUpdated(this);
  }

  setActive(id) {
    if (this.activeId === id || this.disposed) return;
    this.activeId = id;
    this.adapter.render(this.issues, this.activeId);
  }

  /** Rewrites not underlined themselves (they hide behind a fix in their sentence). */
  get hiddenRewrites() {
    return this.rewrites.filter((r) => r.anchorId);
  }

  issueById(id) {
    return this.issues.find((i) => i.id === id) || this.rewrites.find((r) => r.id === id) || null;
  }

  /**
   * True while the issues on screen match the text in the box. They follow your typing in text
   * boxes right away (followTyping), so a fix can go in before the next check comes back.
   */
  get current() {
    return !this.disposed && this.adapter.read() === this.shown;
  }

  /**
   * Paragraphs that look like they hold a password, key or card number (on their own, or as the
   * line after "Password:"): Claude never gets them. Cached per text.
   */
  sensitiveHashes() {
    if (this.sensitiveFor === this.text) return this.sensitive;
    this.sensitive = new Set();
    this.paragraphs.forEach((p, i) => {
      const prev = this.paragraphs[i - 1];
      if (looksSensitive(p.text) || (prev && looksSensitive(`${prev.text} ${p.text}`))) this.sensitive.add(p.hash);
    });
    this.sensitiveFor = this.text;
    return this.sensitive;
  }

  /** How many paragraphs Claude isn't shown because they look like they hold a secret. */
  get sensitiveCount() {
    return this.sensitiveHashes().size;
  }

  /** Paragraphs Claude hasn't seen yet in their current form, and may see. */
  pendingParagraphs() {
    const secret = this.sensitiveHashes();
    return this.paragraphs.filter((p) => wordCount(p.text) >= 3 && p.text.length <= CLAUDE_MAX_PARAGRAPH
      && !this.claude.has(p.hash) && !this.inflight.has(p.hash) && !this.failed.has(p.hash)
      && !secret.has(p.hash) && !/<\/?paragraph/i.test(p.text));
  }

  /** Automatic checks still allowed in this box (a cap per 10 minutes against runaway cost). */
  autoBudgetLeft(chars) {
    const now = Date.now();
    this.autoLog = this.autoLog.filter(([t]) => now - t < AUTO_WINDOW_MS);
    const used = this.autoLog.reduce((n, [, c]) => n + c, 0);
    return this.autoLog.length < AUTO_MAX_REQUESTS && used + chars <= AUTO_MAX_CHARS;
  }

  scheduleClaude() {
    if (this.userActive && this.claudeAllowed && this.ctl.claudeAutoReady() && this.pendingParagraphs().length) {
      this.claudeSoon();
    }
  }

  async checkWithClaude({ manual = false, round = 0 } = {}) {
    if (this.disposed || this.claudeBusy) return;
    if (manual ? !this.ctl.claudeManualReady() : !(this.userActive && this.claudeAllowed && this.ctl.claudeAutoReady())) return;
    if (!this.claudeAllowed) {
      this.claudeError = 'This box looks like it holds keys or code, so Claude stays out of it.';
      this.ctl.sessionUpdated(this);
      return;
    }
    const pending = this.pendingParagraphs();
    if (!pending.length) {
      if (manual) {
        this.claudeChecked = true;
        this.ctl.sessionUpdated(this);
      }
      return;
    }
    const caret = this.adapter.caretOffset();
    // Nearest the caret first: in a long document, what you're working on gets checked first.
    const away = (p) => (caret < p.start ? p.start - caret : caret > p.end ? caret - p.end : 0);
    if (caret >= 0) pending.sort((a, b) => away(a) - away(b));
    const batch = [];
    let size = 0;
    for (const p of pending) {
      if (batch.length && (this.splitBatches || size + p.text.length > CLAUDE_BATCH_CHARS)) break;
      batch.push(p);
      size += p.text.length;
    }
    if (!manual && !this.autoBudgetLeft(size)) {
      this.claudeError = 'Paused automatic Claude checks in this box after a lot of text. Click "Check with Claude" to go on.';
      this.ctl.sessionUpdated(this);
      return;
    }
    if (!manual) this.autoLog.push([Date.now(), size]);
    for (const p of batch) this.inflight.add(p.hash);
    this.claudeBusy = true;
    this.ctl.sessionUpdated(this);
    try {
      const { results } = await request(MSG.AI_CHECK, {
        paragraphs: batch.map((p, n) => ({
          id: n + 1,
          text: p.text,
          inProgress: !manual && caret >= p.start && caret <= p.end && !FINISHED.test(p.text),
        })),
      });
      for (const r of results) {
        const p = batch[r.id - 1];
        if (p) this.claude.set(p.hash, r.edits);
      }
      this.claudeError = null;
      this.claudeChecked = true;
      this.ctl.claudeSucceeded();
    } catch (e) {
      if (e instanceof ExtensionGoneError) return this.ctl.shutdown({ gone: true });
      this.claudeError = e.message;
      if (['parse', 'max-tokens', 'refusal'].includes(e.code)) {
        // This text itself is the trouble: a batch of several is retried one paragraph at a time;
        // a single paragraph isn't sent again until you change it.
        if (batch.length > 1) {
          this.splitBatches = true;
          this.claudeError = null;
        } else {
          this.failed.set(batch[0].hash, e.code);
        }
      } else {
        this.ctl.claudeFailed(e);
      }
    } finally {
      for (const p of batch) this.inflight.delete(p.hash);
      this.claudeBusy = false;
    }
    if (this.disposed) return;
    this.trimClaudeCache();
    this.rebuild();
    // Go on only while each round makes progress: the batch's paragraphs are now cached, or a batch
    // that was too much at once is about to go again one paragraph at a time.
    const resplit = batch.length > 1 && this.splitBatches && !batch.some((p) => this.claude.has(p.hash));
    const progressed = resplit || batch.every((p) => this.claude.has(p.hash) || this.failed.has(p.hash));
    if (this.claudeError || !progressed || !this.pendingParagraphs().length) return;
    if (manual) {
      if (round + 1 < MANUAL_MAX_ROUNDS) this.checkWithClaude({ manual, round: round + 1 });
    } else {
      this.scheduleClaude();
    }
  }

  /** Drops the oldest cached results for paragraphs that are no longer in the box. */
  trimClaudeCache() {
    if (this.claude.size <= CLAUDE_CACHE) return;
    const live = new Set(this.paragraphs.map((p) => p.hash));
    for (const hash of this.claude.keys()) {
      if (this.claude.size <= CLAUDE_CACHE) break;
      if (!live.has(hash)) this.claude.delete(hash);
    }
  }

  /** Where the caret should go after text[start, end) became `replacement`, from where it was. */
  static caretAfter(caret, start, end, replacement) {
    if (caret < 0) return -1;
    if (caret <= start) return caret;
    if (caret >= end) return caret + replacement.length - (end - start);
    return start + replacement.length;
  }

  /**
   * Applies a fix, keeps Claude's other findings in that paragraph, and puts the caret back where
   * you were typing. Returns true, or a sentence saying why not.
   */
  applyFix(issue, replacement) {
    if (this.composing) return 'Finish the character you are typing first.';
    if (!this.current) {
      this.dirty = true;
      this.lint();
      return 'The text changed; check again.';
    }
    const sel = this.adapter.selectionOffsets();
    // Rich editors: a caret on another line (an empty one, after a picture) is put back exactly as
    // it was; a caret in the text being fixed is moved by offsets.
    const caret = this.kind === 'editor' ? this.adapter.liveCaret() : null;
    const fixed = this.kind === 'editor' ? this.adapter.model?.rangeFor(issue.start, issue.end) : null;
    const caretElsewhere = caret && fixed && caret.startContainer !== fixed.startContainer && caret.startContainer !== fixed.endContainer;
    // The paragraph offsets belong to the checked text: only then can Claude's other findings in it
    // be carried over (decided before the fix, whose input event moves the on-screen text on).
    const para = this.shown === this.text ? this.paragraphs.find((p) => issue.start >= p.start && issue.end <= p.end) : null;
    const done = this.adapter.replace(issue.start, issue.end, replacement, issue.original);
    if (done !== true) {
      this.dirty = true;
      this.lint();
      return done;
    }
    if (!(caretElsewhere && this.adapter.selectRange(caret)) && sel) {
      this.adapter.setCaret(Session.caretAfter(sel.end, issue.start, issue.end, replacement));
    }
    if (para) this.carryOwnFixes(para, [{ start: issue.start - para.start, end: issue.end - para.start, replacement }]);
    this.lintSoon.cancel();
    this.lint();
    return true;
  }

  /**
   * After our own fixes in a paragraph Claude has read ([{ start, end, replacement }], offsets in
   * the paragraph): what's left of Claude's findings stays valid, so the new text needs no new
   * check. A sentence rewrite around a fix stays too (it already has the fix in it).
   */
  carryOwnFixes(para, fixes) {
    let edits = this.claude.get(para.hash);
    if (!edits) return;
    let text = para.text;
    for (const f of [...fixes].sort((a, b) => b.start - a.start)) {
      const next = text.slice(0, f.start) + f.replacement + text.slice(f.end);
      edits = [
        ...carryEdits(text, next, edits.filter((x) => x.type !== 'rewrite')),
        ...keepRewrites(edits.filter((x) => x.type === 'rewrite'), text, f.start, f.end, f.replacement),
      ];
      text = next;
    }
    this.claude.set(hashString(text), edits);
  }

  /** Every red issue's first fix, last to first so earlier offsets stay right; the caret stays put. */
  fixAll() {
    if (!this.current) return;
    const sel = this.adapter.selectionOffsets();
    let caret = sel ? sel.end : -1;
    const fixes = this.issues.filter((i) => i.tone !== 'blue' && i.suggestions.length).sort((a, b) => b.start - a.start);
    const paragraphs = this.shown === this.text ? this.paragraphs : []; // offsets of the checked text
    const done = [];
    let expected = this.shown;
    for (const i of fixes) {
      if (this.adapter.read() !== expected) break; // something else changed the text: stop
      if (this.adapter.replace(i.start, i.end, i.suggestions[0], i.original) !== true) break;
      done.push(i);
      caret = Session.caretAfter(caret, i.start, i.end, i.suggestions[0]);
      expected = this.adapter.read();
    }
    for (const p of paragraphs) {
      const mine = done.filter((i) => i.start >= p.start && i.end <= p.end)
        .map((i) => ({ start: i.start - p.start, end: i.end - p.start, replacement: i.suggestions[0] }));
      if (mine.length) this.carryOwnFixes(p, mine);
    }
    if (caret >= 0) this.adapter.setCaret(caret);
    this.dirty = true;
    this.lint();
  }

  ignore(issue) {
    this.ignored.add(ignoreKey(issue));
    this.rebuild();
  }

  /** Paragraphs need Claude again (style notes or model changed). */
  forgetClaude() {
    this.claude.clear();
    this.carried.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lintSoon.cancel();
    this.claudeSoon.cancel();
    this.el.removeEventListener('input', this.onInput);
    for (const type of ['keydown', 'beforeinput', 'paste', 'drop', 'cut']) this.el.removeEventListener(type, this.onUserEdit, true);
    this.el.removeEventListener('compositionstart', this.onCompose);
    this.el.removeEventListener('compositionend', this.onCompose);
    this.observer?.disconnect();
    this.adapter.dispose();
    this.applySpellcheckSetting(false);
  }
}
