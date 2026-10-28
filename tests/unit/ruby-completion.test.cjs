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

test('Ruby range endpoints offer document words, keywords and global methods', async () => {
  for (const expression of ['1..', '0...', '"a"..', '"a"...']) {
    for (const prefix of ['', 'tot']) {
      const doc = `total_count = 12\n${expression}${prefix}`;
      const result = await complete(doc);
      assert.equal(result.from, doc.length - prefix.length);
      for (const label of ['total_count', 'if', 'puts', 'gets.split.map(&:to_i)']) {
        assert.ok(result.options.some(option => option.label === label), `${expression}${prefix}: ${label}`);
      }
      assert.ok(!result.options.some(option => option.label === 'keys'), expression);
    }
  }
});

test('Ruby completion caches distinguish member access from range operators', async () => {
  const { EditorState, StreamLanguage, ruby } = await import('../../src/vendor/editor/codemirror.mjs');
  const member = operator => operator === '.' || operator === '&.';
  for (const original of ['.', '&.', '..', '...']) {
    const result = await complete(`value${original}ea`);
    for (const operator of ['.', '&.', '..', '...']) {
      const doc = `value${operator}each`;
      const state = EditorState.create({ doc, extensions: [StreamLanguage.define(ruby)] });
      assert.equal(result.validFor('each', doc.length - 4, doc.length, state), member(original) === member(operator), `${original} → ${operator}`);
    }
  }
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

test('Ruby literal receivers select String, Array and Hash methods with argument hints', async () => {
  for (const [doc, owner, present, absent] of [
    ['"abc".up', 'String', ['upcase', 'split', 'chars'], ['each', 'keys', 'push', 'each do … end']],
    ["'abc'.", 'String', ['upcase', 'chomp'], ['each', 'keys']],
    ['[1, 2].ea', 'Array', ['each', 'map', 'push', 'each do … end'], ['split', 'keys', 'upcase']],
    ['{a: 1}.ke', 'Hash', ['keys', 'values', 'fetch', 'each do … end'], ['push', 'split', 'upcase']],
  ]) {
    const result = await complete(doc);
    const labels = result.options.map(option => option.label);
    for (const label of present) assert.ok(labels.includes(label), `${doc}: ${label}`);
    for (const label of absent) assert.ok(!labels.includes(label), `${doc}: ${label}`);
    for (const option of result.options.filter(o => o.type === 'method')) {
      assert.ok(option.info.startsWith(`${owner}#`), `${doc}: ${option.label}`);
      assert.ok(option.info.includes('\n'), `${doc}: description for ${option.label}`);
    }
    assert.equal(new Set(labels).size, labels.length);
  }
  const array = (await complete('[].fe')).options.find(o => o.label === 'fetch');
  const hash = (await complete('{}.fe')).options.find(o => o.label === 'fetch');
  assert.match(array.info, /fetch\(index/);
  assert.match(hash.info, /fetch\(key/);
});

test('Ruby receiver detection handles nesting, comments, quoted brackets, grouping and safe navigation', async () => {
  for (const doc of ['a = ["a]", {x: [1, 2]}].ea', '[1, # ] ignored\n2].ea', '([[1]])&.ea', 'f([1].ea', '([1]) .ea']) {
    const labels = (await complete(doc)).options.map(o => o.label);
    assert.ok(labels.includes('push'), doc);
    assert.ok(!labels.includes('keys'), doc);
  }
  assert.ok(!(await complete('("abc")&.up')).options.some(o => o.label === 'keys'));
  assert.ok(!(await complete('f(a: {x: 1}.ke')).options.some(o => o.label === 'push'));
});

test('Ruby uncertain or overly large receivers keep general method completion', async () => {
  for (const doc of ['values.ea', 'values[0].ea', 'values' + ' '.repeat(80) + '[0].ea', '[1][0].ea', 'f("abc").ea', 'items.each { 1 }.ea', '-> {}.ea', '"#{name}".ea', '"#{}".ea', '"#{"a"}".ea', '"#@value".ea', '"#$global".ea', '%w[a b].ea', ':"abc".ea', '/abc/.ea', '[1}.ea', '["' + 'x'.repeat(4200) + '"].ea', '('.repeat(10) + '[]' + ')'.repeat(10) + '.ea']) {
    const labels = (await complete(doc)).options.map(o => o.label);
    assert.ok(labels.includes('keys'), doc.slice(0, 80));
    assert.ok(labels.includes('push'), doc.slice(0, 80));
    assert.ok(labels.includes('each do … end'), doc.slice(0, 80));
    assert.ok(!labels.includes('if'));
  }
});

test('Ruby completion invalidates cached literal methods when the receiver changes', async () => {
  const { EditorState, StreamLanguage, ruby } = await import('../../src/vendor/editor/codemirror.mjs');
  const result = await complete('"abc".');
  const state = doc => EditorState.create({ doc, extensions: [StreamLanguage.define(ruby)] });
  assert.equal(result.validFor('up', 6, 8, state('"abc".up')), true);
  assert.equal(result.validFor('ea', 3, 5, state('[].ea')), false);
  assert.equal(result.validFor('', 6, 6, state('value.')), false);
});

test('Ruby symbol operators and indexing across explicit line continuations keep general methods', async () => {
  for (const doc of [':[].ea', ':[]&.ea', 'value\\\n[0].ea', 'value\\\n  [0]&.ea']) {
    const labels = (await complete(doc)).options.map(o => o.label);
    assert.ok(labels.includes('keys'), doc);
    assert.ok(labels.includes('upcase'), doc);
  }
  const hashLabel = (await complete('f(a: [].ea')).options.map(o => o.label);
  assert.ok(hashLabel.includes('push'));
  assert.ok(!hashLabel.includes('keys'));
  const nextLine = (await complete('value\n[0].ea')).options.map(o => o.label);
  assert.ok(!nextLine.includes('keys'));
});
