const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compareOutput } = require('../../src/compare-output.cjs');

test('M11: compare exact output including Japanese and literal markup', () => {
  assert.equal(compareOutput('6 test\n', '6 test\n'), true);
  assert.equal(compareOutput('日本語\n<img src=x>\n', '日本語\n<img src=x>\n'), true);
  assert.equal(compareOutput('actual', 'expected'), false);
});

test('M11: normalize CRLF and CR and ignore one final newline', () => {
  assert.equal(compareOutput('first\r\nsecond\r\n', 'first\nsecond'), true);
  assert.equal(compareOutput('first\nsecond', 'first\rsecond\r'), true);
  assert.equal(compareOutput('first\nsecond\n', 'first\r\nsecond'), true);
});

test('M11: preserve extra blank lines and all other whitespace', () => {
  for (const [actual, expected] of [
    ['value\n\n', 'value\n'], ['value\n', 'value\n\n'],
    ['value ', 'value'], [' value', 'value'], ['a\tb', 'a b'], ['a\n\nb', 'a\nb']
  ]) assert.equal(compareOutput(actual, expected), false, JSON.stringify({ actual, expected }));
});

test('M11: an empty expectation compares empty output', () => {
  assert.equal(compareOutput('', ''), true);
  assert.equal(compareOutput('\n', ''), true);
  assert.equal(compareOutput('', '\r\n'), true);
  assert.equal(compareOutput('\n\n', ''), false);
  assert.equal(compareOutput(' ', ''), false);
  assert.equal(compareOutput('unexpected', ''), false);
});

test('M11: distinguish case, token order and numeric formatting', () => {
  assert.equal(compareOutput('YES', 'Yes'), false);
  assert.equal(compareOutput('1 2', '2 1'), false);
  assert.equal(compareOutput('1.0', '1'), false);
  assert.equal(compareOutput('0.3000001', '0.3'), false);
});
