import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateEdits, minimalChange, expandToWords, findAll } from '../../src/shared/locate.js';

const one = (para, edit) => locateEdits(para, [{ type: 'grammar', why: 'x', ...edit }]);

test('a misspelling is marked as the whole word', () => {
  const para = 'We will recieve the report tomorrow.';
  const [e] = one(para, { find: 'will recieve the', replace: 'will receive the' });
  assert.equal(para.slice(e.start, e.end), 'recieve');
  assert.equal(e.original, 'recieve');
  assert.equal(e.replacement, 'receive');
});

test('an inserted comma takes the word before it', () => {
  const para = 'However we can send a tech on Monday.';
  const [e] = one(para, { find: 'However we', replace: 'However, we' });
  assert.deepEqual([e.original, e.replacement], ['However', 'However,']);
});

test('an insertion at the very start takes the word after it', () => {
  const para = 'cameras are online.';
  const [e] = one(para, { find: 'cameras are', replace: 'All cameras are' });
  assert.deepEqual([e.original, e.replacement], ['cameras', 'All cameras']);
});

test('a repeated word: only the extra one is removed', () => {
  const para = 'Please find attached the the report.';
  const [e] = one(para, { find: 'attached the the report', replace: 'attached the report' });
  const fixed = para.slice(0, e.start) + e.replacement + para.slice(e.end);
  assert.equal(fixed, 'Please find attached the report.');
});

test('a multi-word fix spans exactly the changed words', () => {
  const para = 'Me and him went to the store yesterday.';
  const [e] = one(para, { find: 'Me and him went', replace: 'He and I went' });
  assert.equal(e.original, 'Me and him');
  assert.equal(e.replacement, 'He and I');
});

test("curly apostrophes in the text still match Claude's straight ones, and stay curly", () => {
  const para = 'It’s going to rain tomorow, they’re saying.';
  const [e] = one(para, { find: "rain tomorow, they're", replace: "rain tomorrow, they're" });
  assert.deepEqual([e.original, e.replacement], ['tomorow', 'tomorrow']);
});

test("a capital in the text survives Claude's lower-case quote", () => {
  const para = 'Their going to call back.';
  const [e] = one(para, { find: 'their going', replace: "they're going" });
  assert.deepEqual([e.original, e.replacement], ['Their', "They're"]);
});

test('text that is not in the paragraph is dropped', () => {
  assert.deepEqual(one('All good here.', { find: 'not there', replace: 'not here' }), []);
});

test('no-op and overlapping edits are dropped; the first of a repeat is used once', () => {
  const para = 'teh cat and teh dog';
  const edits = locateEdits(para, [
    { find: 'teh', replace: 'the', type: 'spelling', why: '' },
    { find: 'teh', replace: 'the', type: 'spelling', why: '' },
    { find: 'cat', replace: 'cat', type: 'spelling', why: '' },
  ]);
  assert.deepEqual(edits.map((e) => [e.start, e.original, e.replacement]), [[0, 'teh', 'the'], [12, 'teh', 'the']]);
});

test('minimalChange works on whole tokens', () => {
  assert.deepEqual(
    (({ aStart, aEnd, insert }) => ({ aStart, aEnd, insert }))(minimalChange('the camera is down', 'the cameras are down')),
    { aStart: 4, aEnd: 13, insert: 'cameras are' },
  );
});

test('expandToWords never splits a word', () => {
  assert.deepEqual(expandToWords('recieve', 3, 5, 'ei'), { start: 0, end: 7, replacement: 'receive' });
});

test('findAll falls back to quote, space and case-insensitive matching', () => {
  assert.deepEqual(findAll('Say “hi”  there', '"hi" there'), [[4, 15]]);
  assert.deepEqual(findAll('HELLO world', 'hello'), [[0, 5]]);
});
