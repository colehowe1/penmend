import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHarper, fromClaude, mergeIssues, filterIssues, ignoreKey } from '../../src/content/issues.js';
import { splitParagraphs, carryEdits, hashString, looksTechnical, isAllCapsWord, wordCount } from '../../src/shared/text.js';
import { normalizeSettings } from '../../src/shared/settings.js';

const settings = normalizeSettings({ dictionary: ['Zentex'] });

const lint = (start, end, kind, suggestions, rule = 'R') => ({ rule, start, end, kind, message: 'm', suggestions });

test('Harper suggestions become replacements for the flagged span', () => {
  const text = 'the the cat';
  const [rep, ins] = fromHarper([
    lint(0, 7, 'Repetition', [{ kind: 'replace', text: 'the' }]),
    lint(8, 11, 'Punctuation', [{ kind: 'insert-after', text: '.' }, { kind: 'remove', text: '' }]),
  ], text);
  assert.deepEqual(rep.suggestions, ['the']);
  assert.deepEqual(ins.suggestions, ['cat.', '']);
  assert.equal(rep.cat, 'grammar');
  assert.equal(ins.cat, 'punctuation');
});

test('the same fix from both engines merges, Claude first', () => {
  const local = fromHarper([lint(0, 3, 'Spelling', [{ kind: 'replace', text: 'tea' }, { kind: 'replace', text: 'the' }])], 'teh cat');
  const claude = fromClaude([{ start: 0, end: 3, original: 'teh', replacement: 'the', type: 'spelling', why: 'Typo.' }], 0, 'h');
  const merged = mergeIssues(local, claude);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].suggestions, ['the', 'tea']);
  assert.equal(merged[0].source, 'both');
  assert.equal(merged[0].message, 'Typo.');
});

test('a Claude issue that wraps a local one replaces it; a partial overlap keeps the local one', () => {
  const local = fromHarper([lint(4, 7, 'Grammar', [{ kind: 'replace', text: 'x' }])], 'aaa bbb ccc ddd');
  const wraps = fromClaude([{ start: 0, end: 11, original: 'aaa bbb ccc', replacement: 'z', type: 'clarity', why: '' }], 0, 'h');
  assert.deepEqual(mergeIssues(local, wraps).map((i) => i.source), ['claude']);
  const partial = fromClaude([{ start: 6, end: 15, original: 'b ccc ddd', replacement: 'z', type: 'clarity', why: '' }], 0, 'h');
  assert.deepEqual(mergeIssues(local, partial).map((i) => i.source), ['local']);
});

test("where Claude checked the paragraph, its verdict wins over Harper's", () => {
  const text = 'Me and him went there in order to check. Ask Zorblatt about teh plan.';
  const local = fromHarper([
    lint(16, 24, 'Miscellaneous', [{ kind: 'replace', text: 'therein' }], 'Therein'), // a false alarm
    lint(45, 53, 'Spelling', [{ kind: 'replace', text: 'Zorba' }]), // a name
    lint(60, 63, 'Spelling', [{ kind: 'replace', text: 'the' }]), // a real typo Claude missed
  ], text);
  const claude = fromClaude([{ start: 22, end: 31, original: 'in order ', replacement: '', type: 'clarity', why: 'Shorter.' }], 0, 'h');
  const checked = mergeIssues(local, claude, [[0, text.length]]);
  assert.deepEqual(checked.map((i) => [i.original, i.source]), [['in order ', 'claude'], ['teh', 'local']]);
  // Not checked by Claude yet (or carried over from an older version): Harper's findings stand.
  assert.deepEqual(mergeIssues(local, claude).map((i) => i.original), ['there in', 'Zorblatt', 'teh']);
});

test('filters: dictionary, ALL CAPS, URLs, categories, ignored, turned-off rules, never-flag', () => {
  const text = 'Zentex NVR github.com/foo teh x';
  const issues = fromHarper([
    lint(0, 6, 'Spelling', [{ kind: 'replace', text: 'Notch' }]),
    lint(7, 10, 'Spelling', [{ kind: 'replace', text: 'Nor' }]),
    lint(11, 17, 'Spelling', [{ kind: 'replace', text: 'gitHub' }]),
    lint(26, 29, 'Spelling', [{ kind: 'replace', text: 'the' }]),
    lint(30, 31, 'Style', [{ kind: 'replace', text: 'y' }], 'Sty'),
  ], text);
  const kept = filterIssues(issues, text, settings, new Set());
  assert.deepEqual(kept.map((i) => i.original), ['teh', 'x']);
  assert.deepEqual(filterIssues(issues, text, { ...settings, categories: { ...settings.categories, style: false } }, new Set()).map((i) => i.original), ['teh']);
  assert.deepEqual(filterIssues(issues, text, settings, new Set([ignoreKey(kept[0])])).map((i) => i.original), ['x']);
  assert.deepEqual(filterIssues(issues, text, { ...settings, disabledRules: ['Sty'] }, new Set()).map((i) => i.original), ['teh']);
  assert.deepEqual(filterIssues(issues, text, { ...settings, neverFlag: [{ original: 'teh', replacement: 'the' }] }, new Set()).map((i) => i.original), ['x']);
});

test('paragraphs, hashing and word counts', () => {
  assert.deepEqual(splitParagraphs('Hello,\n\nLine two\n  \nthree'), [
    { start: 0, end: 6, text: 'Hello,' }, { start: 8, end: 16, text: 'Line two' }, { start: 20, end: 25, text: 'three' },
  ]);
  assert.equal(hashString('abc'), hashString('abc'));
  assert.notEqual(hashString('abc'), hashString('abd'));
  assert.equal(wordCount("They're here, aren't they?"), 4);
});

test('carryEdits keeps findings clear of a change and shifts the ones after it', () => {
  const edits = [{ start: 0, end: 3 }, { start: 8, end: 11 }, { start: 16, end: 19 }];
  // 'teh cat dgo xyz abc' -> typing inside the middle word drops only that finding
  assert.deepEqual(carryEdits('teh cat dgo xyz abc', 'teh cat doggo xyz abc', edits), [{ start: 0, end: 3 }, { start: 18, end: 21 }]);
  assert.equal(carryEdits('same', 'same', edits), edits);
});

test('technical tokens and ALL CAPS', () => {
  for (const t of ['https://x.com', 'www.example.org', 'pat@example.com', 'C:\\temp', 'src/app.js', '@pat', 'example.org']) {
    assert.ok(looksTechnical(t), t);
  }
  for (const t of ['tomorrow', 'e.g.', 'Mr.']) assert.ok(!looksTechnical(t), t);
  assert.ok(isAllCapsWord('NASA'));
  assert.ok(isAllCapsWord('NVRs') === false);
  assert.ok(!isAllCapsWord('I'));
});

test('secrets are recognized so they never go to Claude', async () => {
  const { looksSensitive } = await import('../../src/shared/text.js');
  for (const t of [
    'my key is sk-ant-api03-abcdefghijklmnop',
    'password: hunter2xyz',
    'token=abcd1234efgh',
    'postgres://admin:s3cret@db.example.com/app',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
    'AKIAIOSFODNN7EXAMPLE1234',
    'deadbeef0123456789abcdef0123456789abcdef',
  ]) assert.ok(looksSensitive(t), t);
  for (const t of ['The cameras at store 12 are down.', 'Call me at 555-0100 tomorrow.', 'Please reset the password for the front desk.']) {
    assert.ok(!looksSensitive(t), t);
  }
});

test("Claude can't change numbers or links", async () => {
  const { locateEdits } = await import('../../src/shared/locate.js');
  const para = 'Store 1234 has 12 cameras, see https://example.com/a now.';
  assert.deepEqual(locateEdits(para, [{ find: 'Store 1234 has', replace: 'Store 1243 has', type: 'grammar', why: '' }]), []);
  assert.deepEqual(locateEdits(para, [{ find: 'see https://example.com/a now', replace: 'see https://example.com/b now', type: 'grammar', why: '' }]), []);
  assert.equal(locateEdits(para, [{ find: 'has 12 cameras, see', replace: 'has 12 cameras; see', type: 'punctuation', why: '' }]).length, 1);
});

test('identical paragraphs get distinct Claude issue ids', () => {
  const edits = [{ start: 4, end: 12, original: "camera's", replacement: 'cameras', type: 'punctuation', why: '' }];
  const a = fromClaude(edits, 0, 'same');
  const b = fromClaude(edits, 40, 'same');
  assert.notEqual(a[0].id, b[0].id);
});

test('the caret lands where you were typing after a fix', async () => {
  const { Session } = await import('../../src/content/session.js');
  assert.equal(Session.caretAfter(50, 10, 13, 'receive'), 54); // after the fix: shifted by +4
  assert.equal(Session.caretAfter(5, 10, 13, 'receive'), 5); // before it: unchanged
  assert.equal(Session.caretAfter(11, 10, 13, 'receive'), 17); // inside it: end of the fix
  assert.equal(Session.caretAfter(-1, 10, 13, 'x'), -1);
});
