// Plain-text helpers shared by the content script, the service worker and the tests.

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

export function isWordChar(ch) {
  return Boolean(ch) && WORD_CHAR.test(ch);
}

/** Words, with inner apostrophes kept (they're, O'Neil), whitespace runs, and single other characters. */
const TOKEN = /[\p{L}\p{N}\p{M}_]+(?:['’][\p{L}\p{N}\p{M}_]+)*|\s+|[^\s]/gu;

export function tokenize(s) {
  return s.match(TOKEN) || [];
}

export function wordCount(s) {
  return (s.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
}

/** Non-empty lines of text with their offsets: { start, end, text }. */
export function splitParagraphs(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const piece = text.slice(start, i);
      if (piece.trim()) out.push({ start, end: i, text: piece });
      start = i + 1;
    }
  }
  return out;
}

/** A short stable hash (FNV-1a, 32 bit) plus the length, for caching results per paragraph. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}:${s.length}`;
}

/** Looks like a URL, an email address, a file path or a handle: never spell-checked. */
export function looksTechnical(token) {
  return /^(?:https?:\/\/|www\.)/i.test(token)
    || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(token)
    || /[\\/]/.test(token)
    || /^[@#]\w/.test(token)
    // a domain (example.com), but not a missing space after a full stop ("tomorow.Hi")
    || /\.[a-z]{2,4}$/.test(token) && /\w\.[a-z]/.test(token);
}

/** The whitespace-delimited chunk of text around [start, end). */
export function surroundingToken(text, start, end) {
  let a = start;
  let b = end;
  while (a > 0 && !/\s/.test(text[a - 1])) a--;
  while (b < text.length && !/\s/.test(text[b])) b++;
  return text.slice(a, b).replace(/^[("'“‘[]+|[)"'”’\],.;:!?]+$/g, '');
}

/**
 * Edits found in oldText that still apply to newText: those clear of the changed stretch, moved by
 * its change in length. Edits touching the changed stretch (a word still being typed) are dropped.
 */
export function carryEdits(oldText, newText, edits) {
  if (oldText === newText) return edits;
  let p = 0;
  while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
  let s = 0;
  while (s < oldText.length - p && s < newText.length - p
    && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
  const changedEnd = oldText.length - s;
  const delta = newText.length - oldText.length;
  return edits
    .filter((e) => e.end < p || e.start > changedEnd)
    .map((e) => (e.start > changedEnd ? { ...e, start: e.start + delta, end: e.end + delta } : e));
}

// Secrets people type or paste into web pages: never send these to Claude.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk-ant-|sk-|AKIA|ASIA|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|AIza|glpat-)[A-Za-z0-9_-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // a JWT
  /\b(?:password|passwd|pwd|passcode|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*\S{4,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i, // user:password@host
  // "the router password is Maple1234!", "Login is admin / Acme#2024", "pass: Summer2024!": a password
  // word, then within four words something with a digit or a symbol in it.
  /\b(?:password|passwd|passphrase|pass|pw|pwd|passcode|pin|login|logon|creds?|credentials|secret)\b(?:\W+\S{1,24}){0,4}?\W+(?=\S*[\d!@#$%^&*])\S{4,}/i,
  // "the gate code is 4821", "alarm code: 0420", "combo 1234"
  /\b(?:code|combo|combination|pin)\b(?:\s+(?:is|was|=|-))?\s*:?\s*#?\d{3,10}\b/i,
  /\b\d{3}-\d{2}-\d{4}\b/, // a US SSN
];
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
// Long random-looking strings, once links and file paths are taken out of the line.
const RANDOM = /(?=[A-Za-z0-9+_=-]*\d)(?=[A-Za-z0-9+_=-]*[A-Za-z])[A-Za-z0-9+_=-]{32,}/;
const LINKS_AND_PATHS = /\b(?:https?:\/\/|www\.)\S+|\S*[\\/]\S*/g;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Text that looks like it holds a password, key, token, PIN, card or ID number. */
export function looksSensitive(text) {
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  for (const m of text.match(CARD) || []) {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return RANDOM.test(text.replace(LINKS_AND_PATHS, ' '));
}

export function isAllCapsWord(s) {
  return /^[\p{Lu}\p{N}][\p{Lu}\p{N}&.\-]*$/u.test(s) && (s.match(/\p{Lu}/gu) || []).length >= 2;
}

// Punctuation the author doesn't use (Settings): semicolons, and dashes used as punctuation (an em
// dash, a double hyphen between words, a spaced en dash or hyphen). Hyphens inside words, ranges
// (9–5), list bullets at the start of a line and command flags (--force) don't count.
const SEMICOLONS = /;(?=\s|$)/g;
const DASHES = /(?<=\S)[ \t]*—[ \t]*(?=\S)|(?<=\w)--(?=\w)|(?<=\S)[ \t]+(?:--|–|-)[ \t]+(?=\S)/g;

/** How many of the punctuation marks the author avoids are in `text`. */
export function avoidedMarks(text, s) {
  const t = String(text ?? '');
  return (s.noSemicolons ? (t.match(SEMICOLONS) || []).length : 0) + (s.noDashes ? (t.match(DASHES) || []).length : 0);
}

/**
 * text[start, end) becoming `replacement` brings in punctuation the author avoids. Marks are
 * counted with a few characters on each side, since a fix is often a word or less ("we" -> "— we").
 */
export function addsAvoidedMarksAt(text, start, end, replacement, s) {
  const before = text.slice(Math.max(0, start - 3), start);
  const after = text.slice(end, end + 3);
  return avoidedMarks(before + replacement + after, s) > avoidedMarks(before + text.slice(start, end) + after, s);
}

/**
 * A rewrite without the punctuation the author avoids (each kind only when the original had none
 * of it): a dash becomes a comma, and a semicolon ends the sentence.
 */
export function withoutAvoidedMarks(text, original, s) {
  let out = String(text ?? '');
  if (s.noDashes && !avoidedMarks(original, { noDashes: true })) {
    // Each dash becomes a comma, merged with a comma beside it, or dropped before a full stop.
    out = out.replace(DASHES, '\u0000')
      .replace(/,?[ \t]*\u0000[ \t]*(?:,[ \t]*)?(?=[.!?])/g, '')
      .replace(/,?[ \t]*\u0000[ \t]*(?:,[ \t]*)?/g, ', ');
  }
  if (s.noSemicolons && !avoidedMarks(original, { noSemicolons: true })) {
    out = out.replace(/;[ \t]+(\p{Ll})/gu, (m, c) => `. ${c.toUpperCase()}`).replace(SEMICOLONS, '.');
  }
  return out;
}

/**
 * Claude's sentence rewrites in a paragraph after one fix was applied there (text[start, end)
 * became `replacement`). A rewrite around the fix stays: it already includes the fix, so only what
 * it replaces moves on. A rewrite elsewhere moves with the text; the one that was applied goes.
 */
export function keepRewrites(rewrites, text, start, end, replacement) {
  const delta = replacement.length - (end - start);
  const next = text.slice(0, start) + replacement + text.slice(end);
  const out = [];
  for (const r of rewrites) {
    if (r.end <= start) out.push(r);
    else if (r.start >= end) out.push({ ...r, start: r.start + delta, end: r.end + delta });
    else if (r.start <= start && end <= r.end && !(r.start === start && r.end === end)) {
      const original = next.slice(r.start, r.end + delta);
      if (original !== r.replacement) out.push({ ...r, end: r.end + delta, original });
    }
  }
  return out;
}
