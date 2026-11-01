// Issues: one shape for both engines, plus the rules for merging and filtering them.
//
// { id, start, end, original, suggestions: [string], cat, tone, label, message, source, rule?, why? }
// source: 'local' (Harper), 'claude', or 'both' (the same fix from each). Claude's sentence
// rewrites are issues too ({ rewrite: true }), kept apart from the fixes: see placeRewrites.
import { harperCategory, aiCategory } from '../shared/categories.js';
import { isAllCapsWord, looksTechnical, surroundingToken, addsAvoidedMarksAt } from '../shared/text.js';

function dedupe(list) {
  const seen = new Set();
  return list.filter((s) => {
    const k = s.trim() === '' ? s : s.trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Harper's lints for `text` -> issues. Ids stay the same while the issue stays put. */
export function fromHarper(lints, text) {
  return lints.map((l) => {
    const original = text.slice(l.start, l.end);
    const c = harperCategory(l.kind);
    const suggestions = dedupe(l.suggestions.map((s) => {
      if (s.kind === 'remove') return '';
      if (s.kind === 'insert-after') return original + s.text;
      return s.text;
    }).filter((s) => s !== original)).slice(0, 4);
    return {
      id: `l:${l.rule}:${l.start}:${l.end}`, start: l.start, end: l.end, original, suggestions,
      cat: c.cat, tone: c.tone, label: c.label, message: l.message, source: 'local', rule: l.rule,
    };
  });
}

/** Claude's located edits for one paragraph (starting at `base`, with hash `hash`) -> issues. */
export function fromClaude(edits, base, hash = '') {
  return edits.map((e) => {
    const c = aiCategory(e.type);
    const rewrite = e.type === 'rewrite';
    return {
      id: `${rewrite ? 'r' : 'c'}:${hash}:${base + e.start}:${base + e.end}`, start: base + e.start, end: base + e.end, original: e.original,
      suggestions: [e.replacement], cat: c.cat, tone: c.tone, label: c.label,
      message: e.why || '', source: 'claude', why: e.why, ...(rewrite ? { rewrite } : {}),
    };
  });
}

/**
 * Both engines together. `checked`: [start, end) of paragraphs Claude has read in their current
 * form. There Claude's verdict wins: local findings it didn't share are dropped (Harper's rules
 * misfire on sentences Claude reads correctly), except plain lowercase misspellings, and on a
 * clash Claude's finding replaces the local one. Elsewhere: the same span from both becomes one
 * issue (Claude's fix and reason first); a Claude issue wrapping local ones replaces them; on a
 * partial clash the local one stays (Claude's finding there is out of date).
 */
export function mergeIssues(local, claude, checked = []) {
  const inChecked = (i) => checked.some(([a, b]) => i.start >= a && i.end <= b);
  const overlaps = (x, y) => x.start < y.end && y.start < x.end;
  const out = [];
  for (const l of local) {
    if (inChecked(l) && !claude.some((a) => overlaps(a, l))
      && !(l.cat === 'spelling' && !/^\p{Lu}/u.test(l.original))) continue;
    out.push({ ...l });
  }
  for (const a of claude) {
    const clashing = out.filter((l) => overlaps(l, a));
    if (!clashing.length) {
      out.push(a);
      continue;
    }
    const same = clashing.length === 1 && clashing[0].start === a.start && clashing[0].end === a.end
      ? clashing[0] : null;
    if (same) {
      same.suggestions = dedupe([...a.suggestions, ...same.suggestions]).slice(0, 4);
      same.message = a.message || same.message;
      same.source = 'both';
      continue;
    }
    if (inChecked(a) || clashing.every((l) => a.start <= l.start && l.end <= a.end)) {
      for (const l of clashing) out.splice(out.indexOf(l), 1);
      out.push(a);
    }
  }
  return out.sort((x, y) => x.start - y.start || x.end - y.end);
}

/**
 * The key "Ignore" remembers an issue by, for the rest of the visit. A rewrite by its new version
 * alone: what it replaces changes when you fix a word inside the sentence.
 */
export function ignoreKey(issue) {
  if (issue.rewrite) return `rewrite\u0001${issue.suggestions[0] ?? ''}`;
  return `${issue.original}\u0001${issue.suggestions[0] ?? ''}\u0001${issue.label}`;
}

/**
 * Drops issues the settings rule out, and ones the user ignored here. Suggestions that bring in
 * punctuation the author doesn't use go (and an issue left with none of its suggestions).
 */
export function filterIssues(issues, text, settings, ignored) {
  const dict = new Set(settings.dictionary.map((w) => w.toLowerCase()));
  const never = settings.neverFlag;
  return issues.map((i) => {
    if (!i.suggestions.length) return i;
    const suggestions = i.suggestions.filter((s) => !addsAvoidedMarksAt(text, i.start, i.end, s, settings));
    if (suggestions.length === i.suggestions.length) return i;
    return suggestions.length ? { ...i, suggestions } : null;
  }).filter((i) => {
    if (!i) return false;
    if (!settings.categories[i.cat]) return false;
    if (ignored.has(ignoreKey(i))) return false;
    if (i.rule && settings.disabledRules.includes(i.rule)) return false;
    if (never.some((n) => n.original === i.original && (!n.replacement || i.suggestions.includes(n.replacement)))) return false;
    if (i.cat === 'spelling') {
      const word = i.original.trim();
      if (dict.has(word.toLowerCase())) return false;
      if (settings.ignoreAllCaps && isAllCapsWord(word)) return false;
      if (looksTechnical(surroundingToken(text, i.start, i.end))) return false;
    }
    return true;
  });
}

/**
 * Where Claude's sentence rewrites show (underlines can't overlap). A rewrite of a sentence that
 * has no other issue is underlined like one; over a sentence that does, it isn't, and those
 * issues' cards offer it instead (`rewriteId`; the rewrite's `anchorId` is where its card opens).
 * Harper's "long sentence" note gives way to a rewrite of that sentence.
 * Returns { issues (to draw), rewrites (all of them) }.
 */
export function placeRewrites(issues, rewrites) {
  const overlaps = (x, y) => x.start < y.end && y.start < x.end;
  const kept = issues.filter((i) => !(i.rule === 'LongSentences' && rewrites.some((r) => overlaps(r, i))));
  const out = kept.map((i) => {
    const r = rewrites.find((x) => overlaps(x, i));
    return r ? { ...i, rewriteId: r.id } : i;
  });
  const placed = rewrites.map((r) => {
    const anchor = out.find((i) => i.rewriteId === r.id);
    return anchor ? { ...r, anchorId: anchor.id } : r;
  });
  return {
    issues: [...out, ...placed.filter((r) => !r.anchorId)].sort((x, y) => x.start - y.start || x.end - y.end),
    rewrites: placed,
  };
}

/** The issue under a text offset (a caret position), if any. */
export function issueAt(issues, offset) {
  return issues.find((i) => offset >= i.start && offset <= i.end) || null;
}
