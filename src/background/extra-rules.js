// A few local checks Harper (3.0) doesn't have, in the same shape as Harper's lints so they merge
// like its own. Each one is narrow on purpose: it only fires where the mistake is near certain.
import { looksTechnical, surroundingToken } from '../shared/text.js';

export const EXTRA_DESCRIPTIONS = {
  PM_DoubleComma: 'Flags two commas in a row ("the camera,, and") and keeps one.',
  PM_ItsContraction: 'Suggests "it\'s" for "its" where only "it is" or "it has" makes sense ("its not working", "its still down").',
  PM_YoureWelcome: 'Suggests "You\'re welcome" for "Your welcome" at the start of a sentence.',
};

// After "its" only "it is / it has" fits: these words can't follow a possessive "its". (Not "own",
// "only", "very", "kind", "back", "working"...: "its own staff", "its back panel" are right.)
const NOT_POSSESSIVE = new Set(['not', 'just', 'still', 'going', 'gonna', 'probably', 'definitely', 'actually',
  'always', 'never', 'also', 'almost', 'already', 'really', 'so', 'too', 'supposed', 'getting', 'being', 'been',
  'the', 'my', 'your', 'our', 'their', 'his', 'her', 'there', 'here', 'because', 'about', 'done', 'up', 'down',
  'ok', 'okay', 'on', 'off', 'a', 'an']);
// "of its", "during its"...: the possessive reading wins after a preposition.
const PREPOSITIONS = new Set(['of', 'in', 'on', 'for', 'with', 'by', 'to', 'from', 'at', 'into', 'onto', 'about',
  'through', 'under', 'over', 'without', 'within', 'upon', 'across', 'behind', 'during', 'despite', 'after',
  'before', 'near', 'between', 'toward', 'towards', 'against', 'along', 'around', 'beside', 'beyond', 'past',
  'since', 'until', 'via', 'per', 'among', 'amid', 'inside', 'outside', 'throughout', 'unlike']);

const lint = (rule, start, end, kind, message, text) => ({
  rule, start, end, kind, message, suggestions: [{ kind: 'replace', text }],
});

function doubleCommas(text) {
  const out = [];
  for (const m of text.matchAll(/,(?:[ \t]*,)+(?=\s|$)/g)) {
    if (looksTechnical(surroundingToken(text, m.index, m.index + m[0].length))) continue;
    out.push(lint('PM_DoubleComma', m.index, m.index + m[0].length, 'Punctuation', 'Use one comma here.', ','));
  }
  return out;
}

function itsContractions(text) {
  const out = [];
  // Not before a compound ("its on-screen keyboard", "its on/off switch").
  for (const m of text.matchAll(/(?<![\p{L}'’])(its|Its)[ \t]+(\p{L}+)(?![\p{L}'’\/-])/gu)) {
    if (!NOT_POSSESSIVE.has(m[2].toLowerCase())) continue;
    const before = text.slice(0, m.index).match(/(\p{L}+)[ \t]*$/u);
    if (before && PREPOSITIONS.has(before[1].toLowerCase())) continue;
    out.push(lint('PM_ItsContraction', m.index, m.index + 3, 'WordChoice',
      'Use "it\'s" (it is / it has) here; "its" means "belonging to it".', m[1] === 'Its' ? "It's" : "it's"));
  }
  return out;
}

function youreWelcome(text) {
  const out = [];
  for (const m of text.matchAll(/(^|[.!?…][ \t]+|\n[ \t]*)(your|Your)(?=[ \t]+welcome(?:[ \t]*(?:[.!,?]|$)|[ \t]+to\b))/gmu)) {
    const start = m.index + m[1].length;
    out.push(lint('PM_YoureWelcome', start, start + 4, 'WordChoice',
      'Use "you\'re" (you are): "You\'re welcome."', m[2] === 'Your' ? "You're" : "you're"));
  }
  return out;
}

// Harper lints whose advice on the same words is worse than ours ("Its the" -> "The").
const OUTRANKED = new Set(['TheMy', 'MultipleSequentialPronouns']);

// Harper splits these closed compounds with a space ("doublecheck" -> "double check"); the
// dictionaries hyphenate them.
const HYPHENATED = new Map([['double check', 'double-check'], ['double click', 'double-click'],
  ['cross check', 'cross-check']]);

function hyphenateSplits(l) {
  if (l.rule !== 'SplitWords') return l;
  const suggestions = l.suggestions.map((s) => {
    const fixed = HYPHENATED.get(s.text.toLowerCase());
    if (!fixed) return s;
    return { ...s, text: s.text[0] === s.text[0].toUpperCase() ? fixed[0].toUpperCase() + fixed.slice(1) : fixed };
  });
  return { ...l, message: l.message.replace(/`([^`]+)`(?=\.?$)/, (m, w) => (HYPHENATED.has(w.toLowerCase()) ? `\`${suggestions[0].text}\`` : m)), suggestions };
}

/**
 * Harper's lints plus ours, sorted. Ours never pile onto a span Harper already flagged, except where
 * Harper's advice there is one of the poor ones above, which ours replaces.
 */
export function withExtraLints(lints, text) {
  const out = lints.map(hyphenateSplits);
  for (const x of [...doubleCommas(text), ...itsContractions(text), ...youreWelcome(text)]) {
    const clashing = out.filter((l) => l.start < x.end && x.start < l.end);
    if (clashing.some((l) => !OUTRANKED.has(l.rule))) continue;
    for (const l of clashing) out.splice(out.indexOf(l), 1);
    out.push(x);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}
