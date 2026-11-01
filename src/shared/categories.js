// One vocabulary for both engines. `cat` matches the Settings switches; `tone` picks the underline:
// red = correctness (spelling, grammar, punctuation), blue = clarity and style.

const C = (cat, tone, label) => ({ cat, tone, label });

const HARPER = {
  Spelling: C('spelling', 'red', 'Spelling'),
  Typo: C('spelling', 'red', 'Typo'),
  Agreement: C('grammar', 'red', 'Agreement'),
  Grammar: C('grammar', 'red', 'Grammar'),
  WordOrder: C('grammar', 'red', 'Word order'),
  Malapropism: C('grammar', 'red', 'Wrong word'),
  Eggcorn: C('grammar', 'red', 'Wrong word'),
  Usage: C('grammar', 'red', 'Usage'),
  Nonstandard: C('grammar', 'red', 'Nonstandard'),
  BoundaryError: C('grammar', 'red', 'Word boundary'),
  Repetition: C('grammar', 'red', 'Repeated word'),
  WordChoice: C('grammar', 'red', 'Word choice'),
  Capitalization: C('grammar', 'red', 'Capitalization'),
  Miscellaneous: C('grammar', 'red', 'Correctness'),
  Punctuation: C('punctuation', 'red', 'Punctuation'),
  Formatting: C('punctuation', 'red', 'Formatting'),
  Style: C('style', 'blue', 'Style'),
  Readability: C('style', 'blue', 'Readability'),
  Redundancy: C('style', 'blue', 'Wordiness'),
  Enhancement: C('style', 'blue', 'Enhancement'),
  Regionalism: C('style', 'blue', 'Regional usage'),
};

const AI = {
  spelling: C('spelling', 'red', 'Spelling'),
  grammar: C('grammar', 'red', 'Grammar'),
  punctuation: C('punctuation', 'red', 'Punctuation'),
  word_choice: C('grammar', 'red', 'Word choice'),
  clarity: C('style', 'blue', 'Clarity'),
  rewrite: C('style', 'blue', 'Rewrite for clarity'),
};

export const AI_TYPES = Object.keys(AI);

export function harperCategory(kind) {
  return HARPER[kind] || C('grammar', 'red', kind || 'Correctness');
}

export function aiCategory(type) {
  return AI[type] || AI.grammar;
}

export const CATEGORY_LABELS = {
  spelling: 'Spelling',
  grammar: 'Grammar and word choice',
  punctuation: 'Punctuation',
  style: 'Clarity and style',
};
