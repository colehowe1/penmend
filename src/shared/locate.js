// Turns Claude's edits ({ find, replace } with a little context) into exact, minimal spans of the
// paragraph: where the change starts and ends, what was there, and what replaces it. Underlines
// cover whole words, so "recieve" is marked, never just its "ie".
import { tokenize, isWordChar, looksTechnical, surroundingToken, wordCount } from './text.js';

const QUOTES = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '“': '"', '”': '"', '„': '"', '‟': '"', ' ': ' ' };

/** Text with curly quotes straightened and whitespace runs collapsed, plus a map back to the original. */
function normalizeWithMap(s) {
  let out = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    let ch = QUOTES[s[i]] ?? s[i];
    if (/\s/.test(ch)) {
      if (out.endsWith(' ')) continue;
      ch = ' ';
    }
    out += ch;
    map.push(i);
  }
  map.push(s.length);
  return { out, map };
}

/** Every [start, end) where `needle` occurs in `text`: exact first, then quote/space-insensitive, then any case. */
export function findAll(text, needle) {
  const hits = [];
  if (!needle) return hits;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) hits.push([i, i + needle.length]);
  if (hits.length) return hits;
  const { out, map } = normalizeWithMap(text);
  const n = normalizeWithMap(needle).out;
  if (!n.trim()) return hits;
  for (const hay of [out, out.toLowerCase()]) {
    const nn = hay === out ? n : n.toLowerCase();
    for (let i = hay.indexOf(nn); i !== -1; i = hay.indexOf(nn, i + 1)) hits.push([map[i], map[i + nn.length]]);
    if (hits.length) return hits;
  }
  return hits;
}

const charLen = (tokens) => tokens.reduce((n, t) => n + t.length, 0);
const digitsOf = (t) => (t.match(/\d+/g) || []).join(',');

/**
 * The smallest changed stretch between a and b, by whole tokens: a's [aStart, aEnd) becomes
 * `insert`. `prefix`/`suffix` count the unchanged tokens on each side.
 */
export function minimalChange(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  let prefix = 0;
  while (prefix < ta.length && prefix < tb.length && ta[prefix] === tb[prefix]) prefix++;
  let suffix = 0;
  while (suffix < ta.length - prefix && suffix < tb.length - prefix
    && ta[ta.length - 1 - suffix] === tb[tb.length - 1 - suffix]) suffix++;
  return {
    aStart: charLen(ta.slice(0, prefix)),
    aEnd: a.length - charLen(ta.slice(ta.length - suffix)),
    insert: b.slice(charLen(tb.slice(0, prefix)), b.length - charLen(tb.slice(tb.length - suffix))),
    prefix,
    suffix,
    tokens: ta.length,
  };
}

/**
 * Grows [start, end) to whole words and returns { start, end, replacement }. A pure insertion
 * (start === end) takes the word before it ("However" -> "However,"), or the word after it at the
 * start of the text.
 */
export function expandToWords(text, start, end, replacement) {
  let a = start;
  let b = end;
  if (a === b) {
    if (a > 0 && !/\s/.test(text[a - 1])) {
      while (a > 0 && !/\s/.test(text[a - 1])) a--;
    } else if (b < text.length && !/\s/.test(text[b])) {
      while (b < text.length && !/\s/.test(text[b])) b++;
    } else if (a > 0) {
      a--; // only whitespace around: take one character so the change is visible
    } else if (b < text.length) {
      b++;
    }
  }
  while (a > 0 && isWordChar(text[a - 1]) && isWordChar(text[a] ?? '')) a--;
  while (b < text.length && isWordChar(text[b]) && isWordChar(text[b - 1] ?? '')) b++;
  return { start: a, end: b, replacement: text.slice(a, start) + replacement + text.slice(end, b) };
}

/**
 * Where Claude's change lands in the paragraph. `found` is the paragraph's own text that matched
 * Claude's `find`; when the two differ only in quote style, spacing or case, the change is lined
 * up token by token so those differences never count as edits.
 */
function placeChange(found, find, replace) {
  const change = minimalChange(find, replace);
  if (found === find) return { start: change.aStart, end: change.aEnd, insert: change.insert };
  const tf = tokenize(found);
  if (tf.length !== change.tokens) {
    const c = minimalChange(found, replace);
    return { start: c.aStart, end: c.aEnd, insert: c.insert };
  }
  const start = charLen(tf.slice(0, change.prefix));
  const end = found.length - charLen(tf.slice(tf.length - change.suffix));
  let insert = change.insert;
  // Claude lower-cased the quote but the text is capitalized there: keep the text's capital.
  const was = found[start];
  const quoted = find[change.aStart];
  if (insert && was && quoted && was !== quoted && was === was.toUpperCase() && quoted === quoted.toLowerCase()) {
    insert = insert[0].toUpperCase() + insert.slice(1);
  }
  return { start, end, insert };
}

/**
 * Locates Claude's edits in one paragraph. edits: [{ find, replace, type, why }]. Returns
 * [{ start, end, original, replacement, type, why }] sorted by start, without overlaps, and without
 * edits whose `find` text isn't in the paragraph.
 */
export function locateEdits(paragraph, edits) {
  const out = [];
  const taken = (a, b) => out.some((e) => a < e.end && e.start < b);
  for (const edit of edits || []) {
    const find = String(edit.find ?? '');
    const replace = String(edit.replace ?? '');
    if (!find || find === replace) continue;
    const hit = findAll(paragraph, find).find(([a, b]) => !taken(a, b));
    if (!hit) continue;
    const [fa, fb] = hit;
    const change = placeChange(paragraph.slice(fa, fb), find, replace);
    if (change.start === change.end && !change.insert) continue;
    const span = expandToWords(paragraph, fa + change.start, fa + change.end, change.insert);
    const original = paragraph.slice(span.start, span.end);
    if (original === span.replacement || taken(span.start, span.end)) continue;
    // Numbers, prices, IDs and links are the author's: a "fix" that changes them is dropped.
    if (digitsOf(original) !== digitsOf(span.replacement) || looksTechnical(surroundingToken(paragraph, span.start, span.end))) continue;
    out.push({ start: span.start, end: span.end, original, replacement: span.replacement, type: edit.type, why: edit.why });
  }
  return out.sort((x, y) => x.start - y.start);
}

// A sentence rewrite is offered only for a sentence this long, and only when it changes at least a
// few words (anything smaller is a fix, and Claude lists fixes on their own).
const MIN_REWRITE_WORDS = 8;
const MIN_REWRITE_CHANGE = 3;

const sortedDigits = (t) => (t.match(/\d+/g) || []).sort().join(',');
/** Links, email addresses and file paths in a text: a rewrite has to keep each one exactly. */
const technicalTokens = (t) => t.split(/\s+/)
  .map((w) => w.replace(/^[("'“‘[]+|[)"'”’\],.;:!?]+$/g, ''))
  .filter((w) => w && looksTechnical(w));

/**
 * Locates Claude's sentence rewrites in one paragraph. edits: [{ find, replace, why }], each `find`
 * a whole sentence, replaced as a whole. Rewrites may overlap the paragraph's fixes (a rewrite
 * includes them) but never each other. Dropped: rewrites of short sentences, ones that change only
 * a word or two, ones that grow the sentence a lot, and ones that change a number, a link or an
 * email address. Returns [{ start, end, original, replacement, type: 'rewrite', why }].
 */
export function locateRewrites(paragraph, edits) {
  const out = [];
  for (const edit of edits || []) {
    const find = String(edit.find ?? '').trim();
    const replace = String(edit.replace ?? '').trim();
    if (!find || !replace || find === replace || wordCount(find) < MIN_REWRITE_WORDS) continue;
    const hit = findAll(paragraph, find).find(([a, b]) => !out.some((e) => a < e.end && e.start < b));
    if (!hit) continue;
    const [start, end] = hit;
    const original = paragraph.slice(start, end);
    const change = minimalChange(original, replace);
    if (Math.max(wordCount(original.slice(change.aStart, change.aEnd)), wordCount(change.insert)) < MIN_REWRITE_CHANGE) continue;
    if (replace.length > original.length * 1.5 + 20) continue;
    if (sortedDigits(original) !== sortedDigits(replace)) continue;
    if (technicalTokens(original).some((t) => !replace.includes(t))) continue;
    out.push({ start, end, original, replacement: replace, type: 'rewrite', why: edit.why });
  }
  return out.sort((x, y) => x.start - y.start);
}
