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

async function expectOwner(doc, owner) {
  const context = doc.length > 200 ? `${doc.slice(0, 80)}…${doc.slice(-80)}` : doc;
  const result = await complete(doc);
  assert.ok(result, context);
  const methods = result.options.filter(option => option.type === 'method');
  assert.ok(methods.length, context);
  assert.ok(methods.every(option => option.detail === owner), `${context}: expected ${owner}`);
  assert.ok(methods.every(option => option.info.startsWith(`${owner}#`)), context);
  return result;
}

async function expectGeneral(doc) {
  const labels = (await complete(doc)).options.map(option => option.label);
  for (const label of ['upcase', 'push', 'keys']) assert.ok(labels.includes(label), `${doc}: ${label}`);
}

test('Ruby local variables inherit literal methods and hints across simple assignments', async () => {
  const prefix = 'text = "abc"\nvalues = [1, 2]\ncounts = {a: 1}\n';
  for (const [name, owner] of [['text', 'String'], ['values', 'Array'], ['counts', 'Hash']]) {
    await expectOwner(`${prefix}${name}.`, owner);
    await expectOwner(`${prefix}${name}&.`, owner);
  }
  await expectOwner('文字列 = "日本語"\n文字列.up', 'String');
  await expectOwner('_items = ([])\n_items.ea', 'Array');
  await expectOwner('text = "a"\nputs(text.up', 'String');
  await expectOwner('text = "a"\nputs text.up', 'String');
});

test('Ruby local inference skips comments and string contents and groups multiline literals', async () => {
  await expectOwner('text = "abc"\n# text = []\n\nmessage = "text = {}; end; if true"\ntext.up', 'String');
  await expectOwner('values = [\n  "]", # } ignored\n  {a: [1, 2]}\n] # comment\nvalues.ea', 'Array');
  await expectOwner('counts = {\n  "a;]" => [1],\n  other: nil\n}\ncounts.ke', 'Hash');
  await expectOwner('text = "a;b"; values = []; text.up', 'String');
  await expectOwner('text = "a"\n=begin\ntext = []\n=end\ntext.up', 'String');
  await expectOwner('text = "a"\nmessage = "` %x{...}"\ntext.up', 'String');
  await expectOwner('text = "a"\nmessage = \'#{text = []}\'\ntext.up', 'String');
});

test('Ruby direct reassignments replace types and unknown assignments discard stale types', async () => {
  await expectOwner('value = "abc"\nvalue = []\nvalue.ea', 'Array');
  await expectOwner('value = []\nvalue = {}\nvalue.ke', 'Hash');
  for (const statement of ['value = gets', 'value = other', 'value ||= []', 'value += []', 'value, other = [], {}', 'other = value', 'value = [] if flag', 'value = "#{name}"', 'value = %w[a b]', 'eval("value = {}")']) {
    await expectGeneral(`value = "abc"\n${statement}\nvalue.ea`);
  }
  await expectOwner('value = gets\nvalue = []\nvalue.ea', 'Array');
  for (const expression of ['flag and', 'flag or', 'read_value rescue', 'defined?']) {
    await expectGeneral(`value = "abc"\n${expression}\nvalue = []\nvalue.ea`);
  }
  await expectOwner('values = [get_value()]\nvalues.ea', 'Array');
  await expectGeneral('text = "abc"\nvalues = [text = {}]\ntext.ea');
  await expectGeneral('text = "abc"\nvalues = ["#{text = {}}"]\ntext.ea');
});

test('Ruby scope and control boundaries do not leak inferred locals', async () => {
  for (const code of [
    'value = []\nif flag\nvalue.ea',
    'if flag\nvalue = []\nend\nvalue.ea',
    'value = []\nitems.each do |value|\nvalue.ea',
    'value = []\nitems.each { |value|\nvalue.ea',
    'value = []\ndef solve(value)\nvalue.ea',
    'def solve\nvalue = []\nend\nvalue.ea',
    'value = []\nclass Example\nvalue.ea',
    'value = []\ncase flag\nwhen 1\nvalue.ea',
    'value = []\nfor value in items\nvalue.ea',
    'def solve(arg =\nvalue = []\nvalue.ea',
    'def solve arg = \\\nvalue = []\nvalue.ea',
  ]) await expectGeneral(code);
  await expectOwner('def solve\nvalue = []\nvalue.ea', 'Array');
  await expectOwner('if flag\nvalue = []\nvalue.ea', 'Array');
  await expectOwner('if flag\nvalue = "a"\nend\nvalue = {}\nvalue.ke', 'Hash');
});

test('Ruby local inference rejects indirect receivers, unfinished expressions and future assignments', async () => {
  for (const receiver of ['@value', '$value', 'Object::value', 'object.value', 'value[0]', 'value()', ':value']) {
    await expectGeneral(`value = []\n${receiver}.ea`);
  }
  for (const code of ['value = []\ncall(value = {}; value.ea', 'value = []\n[change(), value.ea', 'VALUE = []\nVALUE.ea']) await expectGeneral(code);
  for (const marker of ['<<TEXT', "<<'TEXT'", '<<"TEXT"', '<<`TEXT`']) await expectGeneral(`message = ${marker}\nvalue = []\nvalue.ea`);
  await expectGeneral('message = <<\'TEXT\'\n[]\nvalue = []\nvalue.ea');
  assert.equal(await complete('message = <<~TEXT\nvalue = []\nvalue.ea'), null);
  await expectGeneral('__END__\nvalue = []\nvalue.ea');
  const doc = 'value.ea\nvalue = []';
  const labels = (await complete(doc, 'value.ea'.length)).options.map(option => option.label);
  assert.ok(labels.includes('upcase') && labels.includes('keys'));
});

test('Ruby local inference is bounded from the real document start and preserves literal completion', async () => {
  await expectOwner('#' + 'x'.repeat(15000) + '\nvalue = []\nvalue.ea', 'Array');
  await expectGeneral('#' + 'x'.repeat(17000) + '\nvalue = []\nvalue.ea');
  await expectGeneral('value = []\n' + ' '.repeat(15000) + '+ value.ea');
  await expectGeneral('if flag\n' + '# padding\n'.repeat(2000) + 'value = []\nvalue.ea');
  await expectOwner('#' + 'x'.repeat(17000) + '\n[].ea', 'Array');
});

test('Ruby completion caches recheck changed assignments and control boundaries', async () => {
  const { EditorState, StreamLanguage, ruby } = await import('../../src/vendor/editor/codemirror.mjs');
  const typed = await complete('value = "abc"\nvalue.up');
  const unknown = await complete('value.up');
  for (const [doc, valid] of [['value = "def"\nvalue.up', true], ['value = []\nvalue.up', false], ['value = "abc"\nif flag\nvalue.up', false], ['value = gets\nvalue.up', false]]) {
    const state = EditorState.create({ doc, extensions: [StreamLanguage.define(ruby)] });
    assert.equal(typed.validFor('up', doc.length - 2, doc.length, state), valid, doc);
    if (valid) assert.equal(unknown.validFor('up', doc.length - 2, doc.length, state), false, doc);
  }
});
