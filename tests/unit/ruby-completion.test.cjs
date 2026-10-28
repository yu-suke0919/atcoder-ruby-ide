const { test } = require('node:test');
const assert = require('node:assert/strict');

async function complete(doc, pos = doc.length, readOnly = false) {
  const { EditorState, StreamLanguage, ruby } = await import('../../src/vendor/editor/codemirror.mjs');
  const { CompletionContext } = await import('@codemirror/autocomplete');
  const { rubyCompletions } = await import('../../src/ruby-completion.mjs');
  const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: [StreamLanguage.define(ruby), EditorState.readOnly.of(readOnly)] });
  return rubyCompletions(new CompletionContext(state, pos, true));
}

test('Ruby completion offers keywords, common methods and the three templates without duplicate labels', async () => {
  const result = await complete('');
  const labels = result.options.map(option => option.label);
  for (const label of ['if', 'while', 'puts', 'gets', 'if … end', 'each do … end', 'gets.split.map(&:to_i)']) assert.ok(labels.includes(label), label);
  assert.equal(new Set(labels).size, labels.length);
});

test('Ruby completion finds document identifiers and matches the prefix at the cursor', async () => {
  const result = await complete('total_count = 12\n合計 = total_count\ntot');
  const labels = result.options.map(option => option.label);
  assert.ok(labels.includes('total_count'));
  assert.ok(labels.includes('合計'));
  assert.ok(!labels.includes('12'));
  const middle = await complete('push', 2);
  assert.equal(middle.from, 0);
  assert.ok(middle.options.some(option => option.label === 'puts'));
});

test('Ruby completion stays out of comments, strings, numbers and read-only documents', async () => {
  for (const doc of ['# put', 'puts "put', "puts 'put", '%q{put', '=begin\nput', '123']) {
    assert.equal(await complete(doc), null, doc);
  }
  assert.equal(await complete('/put/', 4), null);
  assert.equal(await complete('put', 3, true), null);
});

test('Ruby method completion after a receiver excludes keywords and preserves the receiver', async () => {
  const result = await complete('values.ea');
  assert.equal(result.from, 7);
  const labels = result.options.map(option => option.label);
  assert.ok(labels.includes('each'));
  assert.ok(labels.includes('map'));
  assert.ok(labels.includes('each do … end'));
  assert.ok(!labels.includes('if'));
  assert.ok(!labels.includes('puts'));
  assert.ok(!labels.includes('gets.split.map(&:to_i)'));
});

test('Ruby completion does not retain words from another document', async () => {
  assert.ok((await complete('previous_secret = 1\npre')).options.some(option => option.label === 'previous_secret'));
  assert.ok(!(await complete('pre')).options.some(option => option.label === 'previous_secret'));
});

test('Ruby completion replaces identifier suffixes while preserving comparison operators', async () => {
  const { EditorState, StreamLanguage, ruby } = await import('../../src/vendor/editor/codemirror.mjs');
  const { CompletionContext } = await import('@codemirror/autocomplete');
  const { rubyCompletions } = await import('../../src/ruby-completion.mjs');
  for (const [doc, expected] of [['push', 'puts'], ['push!', 'puts'], ['push?', 'puts'], ['pu!=1', 'puts!=1'], ['pu!~/x/', 'puts!~/x/']]) {
    const view = {
      state: EditorState.create({ doc, selection: { anchor: 2 }, extensions: [StreamLanguage.define(ruby)] }),
      dispatch(spec) { this.state = this.state.update(spec).state; },
    };
    const result = rubyCompletions(new CompletionContext(view.state, 2, true));
    const option = result.options.find(option => option.label === 'puts');
    option.apply(view, option, result.from, 2);
    assert.equal(view.state.doc.toString(), expected, doc);
  }
});
