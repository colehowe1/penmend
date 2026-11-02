import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateRewrites } from '../../src/shared/locate.js';
import { avoidedMarks, addsAvoidedMarksAt, withoutAvoidedMarks, keepRewrites } from '../../src/shared/text.js';
import { fromHarper, fromClaude, filterIssues, placeRewrites, ignoreKey } from '../../src/content/issues.js';
import { withExtraLints } from '../../src/background/extra-rules.js';
import { normalizeSettings } from '../../src/shared/settings.js';
import { authorContext } from '../../src/background/prompts.js';

const LONG = 'The store manager called this morning to say that the camera in the back room that we replaced last week is down again.';
const CLEAR = 'The store manager called this morning. The back-room camera we replaced last week is down again.';
const none = { noSemicolons: false, noDashes: false };
const both = { noSemicolons: true, noDashes: true };

test('a sentence rewrite covers the whole sentence and keeps Claude\'s version', () => {
  const p = `${LONG} Thanks.`;
  const [r] = locateRewrites(p, [{ find: LONG, replace: CLEAR, why: 'Split.' }]);
  assert.equal(r.start, 0);
  assert.equal(r.end, LONG.length);
  assert.equal(r.replacement, CLEAR);
  assert.equal(r.type, 'rewrite');
});

test('rewrites that are really small fixes, or of short sentences, are dropped', () => {
  const small = LONG.replace('again.', 'again!');
  assert.equal(locateRewrites(LONG, [{ find: LONG, replace: small }]).length, 0);
  assert.equal(locateRewrites('Thanks for the help today.', [{ find: 'Thanks for the help today.', replace: 'Thank you so much for helping today.' }]).length, 0);
});

test('rewrites may not change numbers or links, or bloat the sentence', () => {
  const s = 'We will replace 3 cameras at store 4521 next week if the parts from ADI come in on time.';
  assert.equal(locateRewrites(s, [{ find: s, replace: 'If ADI ships the parts on time, we will replace 3 cameras at store 4512 next week.' }]).length, 0);
  assert.equal(locateRewrites(s, [{ find: s, replace: 'If the ADI parts arrive on time, we will replace 3 cameras at store 4521 next week.' }]).length, 1);
  const link = 'The full report with every camera that failed is on https://example.com/r/1 if you want to look.';
  assert.equal(locateRewrites(link, [{ find: link, replace: 'Every camera that failed is in the full report if you want to look.' }]).length, 0);
  assert.equal(locateRewrites(LONG, [{ find: LONG, replace: `${CLEAR} ${CLEAR} ${CLEAR}` }]).length, 0);
});

test('avoided punctuation: dashes and semicolons, not hyphens, ranges, bullets or flags', () => {
  assert.equal(avoidedMarks('Call me — or not; fine -- ok - yes', both), 4);
  assert.equal(avoidedMarks('back-room, 9–5, mid-day, --force\n- a bullet', both), 0);
  assert.equal(avoidedMarks('a; b — c', none), 0);
  const at = (text, find, replacement, s = both) => {
    const i = text.indexOf(find);
    return addsAvoidedMarksAt(text, i, i + find.length, replacement, s);
  };
  assert.ok(at('a, b', ',', ';'));
  assert.ok(!at('a; b', 'b', 'c'));
  assert.ok(!at('a, b', ',', ';', none));
  // A fix cut down to a word or less still counts the dash it brings in.
  const t = 'The camera is down we will replace it.';
  assert.ok(at(t, 'we', '— we'));
  assert.ok(at(t, ' ', '—'));
  assert.ok(at('It is down, we will.', ',', ' —'));
  assert.ok(!at(t, 'replace', 're-place'));
});

test('rewrites lose dashes and semicolons the author never uses', () => {
  assert.equal(withoutAvoidedMarks('Good news — the cameras are back up; thanks for waiting.', 'plain', both),
    'Good news, the cameras are back up. Thanks for waiting.');
  assert.equal(withoutAvoidedMarks('Call me—now.', 'plain', both), 'Call me, now.');
  assert.equal(withoutAvoidedMarks('It works—.', 'plain', both), 'It works.');
  assert.equal(withoutAvoidedMarks('A, — B', 'plain', both), 'A, B');
  // Only the places a dash was are touched.
  assert.equal(withoutAvoidedMarks('Supported formats: .pdf, .docx, .txt. Hi, .NET team.', 'plain', both),
    'Supported formats: .pdf, .docx, .txt. Hi, .NET team.');
  // The author's own dashes stay (they typed one), and nothing changes with the switches off.
  assert.equal(withoutAvoidedMarks('A — B; c', 'x — y', { noDashes: true }), 'A — B; c');
  assert.equal(withoutAvoidedMarks('A — B; c', 'plain', none), 'A — B; c');
});

test('suggestions that bring in avoided punctuation are dropped, with the issue if none is left', () => {
  const s = normalizeSettings({ ...both, dictionary: [] });
  const issues = fromClaude([
    { start: 9, end: 10, original: ',', replacement: ';', type: 'punctuation', why: '' },
    { start: 0, end: 3, original: 'teh', replacement: 'the', type: 'spelling', why: '' },
  ], 0, 'h');
  const kept = filterIssues(issues, 'teh store, ok', s, new Set());
  assert.deepEqual(kept.map((i) => i.original), ['teh']);
  assert.equal(filterIssues(issues, 'teh store, ok', normalizeSettings({ ...none, dictionary: [] }), new Set()).length, 2);
});

test('a rewrite over a sentence with a fix in it hides behind that fix', () => {
  const text = `${LONG} Fine.`;
  const fixes = fromClaude([{ start: 4, end: 9, original: 'store', replacement: 'shop', type: 'word_choice', why: '' }], 0, 'h');
  const rewrites = fromClaude([{ start: 0, end: LONG.length, original: LONG, replacement: CLEAR, type: 'rewrite', why: '' }], 0, 'h');
  const placed = placeRewrites(fixes, rewrites);
  assert.equal(placed.issues.length, 1);
  assert.equal(placed.issues[0].rewriteId, rewrites[0].id);
  assert.equal(placed.rewrites[0].anchorId, fixes[0].id);
  // On its own, the rewrite is drawn like any issue.
  const alone = placeRewrites([], rewrites);
  assert.equal(alone.issues.length, 1);
  assert.ok(alone.issues[0].rewrite && !alone.issues[0].anchorId);
  assert.ok(text.startsWith(placed.rewrites[0].original));
});

test('an ignored rewrite stays ignored after a fix inside its sentence', () => {
  const [before] = fromClaude([{ start: 0, end: LONG.length, original: LONG, replacement: CLEAR, type: 'rewrite', why: '' }], 0, 'h');
  const after = { ...before, original: LONG.replace('store', 'shop') };
  assert.equal(ignoreKey(before), ignoreKey(after));
});

test('Harper\'s long-sentence note gives way to a rewrite of that sentence', () => {
  const local = fromHarper([{ rule: 'LongSentences', start: 0, end: LONG.length, kind: 'Readability', message: 'Long.', suggestions: [] }], LONG);
  const rewrites = fromClaude([{ start: 0, end: LONG.length, original: LONG, replacement: CLEAR, type: 'rewrite', why: '' }], 0, 'h');
  const placed = placeRewrites(local, rewrites);
  assert.deepEqual(placed.issues.map((i) => i.id), [rewrites[0].id]);
});

test('a rewrite stays after a fix inside its sentence, and moves after one before it', () => {
  const text = `Hi teh team. ${LONG}`;
  const at = text.indexOf(LONG);
  const r = { start: at, end: at + LONG.length, original: LONG, replacement: CLEAR, type: 'rewrite' };
  // Fix "teh" -> "the" before the sentence: it moves (same length here, so it stays put).
  assert.deepEqual(keepRewrites([r], text, 3, 6, 'the')[0].start, at);
  // A fix inside it ("store" -> "shop"): still offered, over the fixed text.
  const s = text.indexOf('store');
  const [kept] = keepRewrites([r], text, s, s + 5, 'shop');
  assert.equal(kept.original, LONG.replace('store', 'shop'));
  assert.equal(kept.end, r.end - 1);
  // The rewrite itself applied: gone.
  assert.equal(keepRewrites([r], text, r.start, r.end, CLEAR).length, 0);
});

test('extra local checks: double commas, its/it\'s, your/you\'re welcome', () => {
  const hits = (t) => withExtraLints([], t).map((l) => [l.rule, t.slice(l.start, l.end), l.suggestions[0].text]);
  assert.deepEqual(hits('We checked the camera,, and it was fine.'), [['PM_DoubleComma', ',,', ',']]);
  assert.deepEqual(hits('Its not working again.'), [['PM_ItsContraction', 'Its', "It's"]]);
  assert.deepEqual(hits('I hope its still under warranty.'), [['PM_ItsContraction', 'its', "it's"]]);
  assert.deepEqual(hits('Your welcome!'), [['PM_YoureWelcome', 'Your', "You're"]]);
  for (const ok of ['The dog wagged its tail.', 'The company and its own staff.', 'It runs on its down time.',
    'Thanks for your welcome.', 'Use its on-screen keyboard.', 'The cells read a,,b in the sheet.',
    'Press its on/off switch.', 'During its down time the unit reboots.', 'Despite its being old, it works.']) {
    assert.deepEqual(hits(ok), [], ok);
  }
});

test('extra checks don\'t pile onto Harper\'s, but replace its poor "Its the" advice', () => {
  const t = 'Its the third time.';
  const theMy = { rule: 'TheMy', start: 0, end: 7, kind: 'Grammar', message: '', suggestions: [{ kind: 'replace', text: 'The' }] };
  assert.deepEqual(withExtraLints([theMy], t).map((l) => l.rule), ['PM_ItsContraction']);
  const other = { ...theMy, rule: 'ItsContraction' };
  assert.deepEqual(withExtraLints([other], t).map((l) => l.rule), ['ItsContraction']);
});

test('"doublecheck" gets the hyphenated "double-check", not Harper\'s "double check"', () => {
  const t = 'Just wanted to doublecheck that. Doubleclick it.';
  const split = (start, end, text) => ({ rule: 'SplitWords', start, end, kind: 'Spelling',
    message: `\`${t.slice(start, end)}\` should probably be written as \`${text}\`.`, suggestions: [{ kind: 'replace', text }] });
  const [a, b] = withExtraLints([split(15, 26, 'double check'), split(33, 44, 'Double click')], t);
  assert.equal(a.suggestions[0].text, 'double-check');
  assert.equal(a.message, '`doublecheck` should probably be written as `double-check`.');
  assert.equal(b.suggestions[0].text, 'Double-click');
  const other = split(15, 26, 'some thing');
  assert.equal(withExtraLints([other], t)[0].suggestions[0].text, 'some thing');
});

test('the prompts carry the punctuation the author avoids, and "no rewrites" when off', () => {
  const s = normalizeSettings({ ...both, rewriteSuggestions: false });
  assert.match(authorContext(s), /never uses semicolons or dashes/);
  assert.match(authorContext(s), /no edits of type "rewrite"/);
  assert.match(authorContext(s, { forRewrite: true }), /Don't use them anywhere/);
  assert.doesNotMatch(authorContext(normalizeSettings({ ...none })), /semicolons/);
});

test('the dictionary goes into the prompt whole, first word included', () => {
  const ctx = authorContext(normalizeSettings({ dictionary: ['Zorblatt', 'Quixly', 'Acme'] }));
  assert.match(ctx, /<dictionary>Zorblatt, Quixly, Acme<\/dictionary>/);
});
