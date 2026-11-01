// Starting values for a fresh install: nothing personal. The store build (npm run zip) and the test
// build always use this file. For your own copy, put your starting dictionary, style notes and
// punctuation switches in seed.local.js next to it (same three exports; git-ignored), and
// `npm run build` uses that instead.

/** Words the checkers should accept from day one. */
export const SEED_DICTIONARY = [];

/** How the author writes, so Claude leaves these habits alone and rewrites sound like them. */
export const SEED_STYLE = '';

/** Punctuation the author doesn't use: never suggested, and kept out of rewrites. */
export const SEED_PUNCTUATION = { noSemicolons: false, noDashes: false };
