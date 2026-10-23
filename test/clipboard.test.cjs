const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preparePaste, validateText, MAX_CLIPBOARD_TEXT } = require('../src/clipboard.cjs');

test('plain Unicode text preserves spaces and passes without review', () => {
  assert.deepEqual(preparePaste(' echo "你好 👋"  '), { text: ' echo "你好 👋"  ', removed: 0, review: false });
});
test('all newline forms require review, optional trim removes only final newlines', () => {
  assert.deepEqual(preparePaste('pwd\r\nls\r\n\n', true), { text: 'pwd\nls', removed: 0, review: true });
  assert.equal(preparePaste('echo test\r').review, true);
  assert.equal(preparePaste('pwd\n\nls\n  ', true).text, 'pwd\n\nls\n  ');
  assert.equal(preparePaste('pwd\n', false).text, 'pwd\n');
});
test('pasted terminal controls and bracketed-paste delimiters cannot pass through', () => {
  const result = preparePaste('hi\x03\x00\x1b[201~\x1b[31m\x9bbye');
  assert.equal(result.text, 'hi[201~[31mbye');
  assert.equal(result.removed, 5); assert.equal(result.review, true);
});
test('tabs and large pastes require review; invalid and oversized payloads are rejected', () => {
  assert.equal(preparePaste('echo\ttest').review, true);
  assert.equal(preparePaste('x'.repeat(4001)).review, true);
  assert.equal(validateText('x'.repeat(MAX_CLIPBOARD_TEXT)).length, MAX_CLIPBOARD_TEXT);
  assert.throws(() => validateText({}), /文本/);
  assert.throws(() => preparePaste('x'.repeat(MAX_CLIPBOARD_TEXT + 1)), /分段/);
});
