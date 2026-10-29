const { test } = require('node:test');
const assert = require('node:assert/strict');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(doc, pos = doc.length) {
  const { EditorState, StreamLanguage, ruby } = await import('../../src/vendor/editor/codemirror.mjs');
  const { CompletionContext } = await import('@codemirror/autocomplete');
  const state = EditorState.create({ doc, selection: { anchor: pos }, extensions: [StreamLanguage.define(ruby)] });
  const view = { state, dispatch(spec) { this.state = this.state.update(spec).state; } };
  const context = new CompletionContext(state, pos, true, view);
  let abort;
  context.addEventListener = (_event, callback) => { abort = callback; };
  return { view, context, cancel: () => abort?.() };
}
const item = (label, from, to, extra = {}) => ({ label, kind: 2, textEdit: { range: { start: { line: 0, character: from }, end: { line: 0, character: to } }, newText: label }, ...extra });

test('LSP completion uses UTF-16 edits, plain text hints and a single undoable insertion', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  const doc = '"😀日本語"; Foo.new.uni';
  const f = await fixture(doc);
  const requests = [];
  const client = { complete: async (...args) => { requests.push(args.slice(0, 3)); return [item('unique_name', doc.length - 3, doc.length, { data: { owner_name: 'Foo' }, labelDetails: { detail: '()', description: 'solution.rb' }, documentation: { kind: 'markdown', value: '<script>not HTML</script>' } })]; } };
  const result = await lspCompletions(client)(f.context);
  assert.deepEqual(requests, [[doc, 0, doc.length]]);
  const option = result.options.find(o => o.label === 'unique_name');
  assert.match(option.detail, /LSP/);
  assert.match(option.info, /Foo#unique_name/);
  assert.match(option.info, /<script>not HTML/);
  assert.ok(!result.options.some(o => o.label === 'keys'));
  option.apply(f.view, option, result.from, f.context.pos);
  assert.equal(f.view.state.doc.toString(), '"😀日本語"; Foo.new.unique_name');
});

test('LSP edits replace the reported identifier and preserve comparison operators', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  const f = await fixture('obj.push!=1', 6);
  const result = await lspCompletions({ complete: async () => [item('puts', 4, 8)] })(f.context);
  const option = result.options.find(o => o.label === 'puts');
  option.apply(f.view, option, result.from, 6);
  assert.equal(f.view.state.doc.toString(), 'obj.puts!=1');
});

test('LSP user-defined methods do not inherit unrelated standard-library documentation', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  const f = await fixture('Foo.new.up');
  const result = await lspCompletions({ complete: async () => [item('upcase', 8, 10, { data: { owner_name: 'Foo' }, labelDetails: { detail: '(value)' } })] })(f.context);
  const option = result.options.find(o => o.label === 'upcase');
  assert.match(option.info, /^Foo#upcase\(value\)/);
  assert.doesNotMatch(option.info, /String#/);
});

test('LSP Enumerable methods retain Japanese Array and Hash summaries without matching String methods', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  for (const [doc, label, owner] of [
    ['[1, 2].each_with_in', 'each_with_index', 'Array'],
    ['[].sort_b', 'sort_by', 'Array'],
    ['[].red', 'reduce', 'Array'],
    ['[].fi', 'find', 'Array'],
    ['{a: 1}.ma', 'map', 'Hash'],
    ['{}.so', 'sort', 'Hash'],
    ['{}.mi', 'min', 'Hash'],
    ['{}.max', 'max', 'Hash'],
    ['{}.su', 'sum', 'Hash'],
    ['{}.co', 'count', 'Hash'],
  ]) {
    const f = await fixture(doc);
    const from = doc.lastIndexOf('.') + 1;
    const result = await lspCompletions({ complete: async () => [item(label, from, doc.length, { data: { owner_name: 'Enumerable' } })] })(f.context);
    const option = result.options.find(o => o.label === label);
    assert.match(option.info, new RegExp(`^${owner}#${label}`), doc);
    assert.match(option.info, /[\u3040-\u30ff\u4e00-\u9fff]/u, doc);
    assert.doesNotMatch(option.info, /String#/, doc);
  }
});

test('LSP qualified constants filter over the edit range including their namespace', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  const f = await fixture('Math::P');
  const result = await lspCompletions({ complete: async () => [item('Math::PI', 0, 7, { kind: 21, filterText: 'Math::PI' })] })(f.context);
  assert.equal(result.from, 0);
  const option = result.options.find(o => o.label === 'Math::PI');
  option.apply(f.view, option, result.from, 7);
  assert.equal(f.view.state.doc.toString(), 'Math::PI');
});

test('LSP merges general words and templates without duplicate labels and keeps local fallback', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  let f = await fixture('pu');
  let result = await lspCompletions({ complete: async () => [item('puts', 0, 2), item('puts', 0, 2)] })(f.context);
  assert.equal(result.options.filter(o => o.label === 'puts').length, 1);
  assert.ok(result.options.some(o => o.label === 'if … end'));
  for (const response of [[], null, 'failed']) {
    f = await fixture('text = "abc"\ntext.up');
    result = await lspCompletions({ complete: async () => { if (response === 'failed') throw Error('offline'); return response; } })(f.context);
    assert.ok(result.options.some(o => o.label === 'upcase'));
    assert.ok(!result.options.some(o => o.label === 'keys'));
  }
});

test('LSP and every fallback response invalidate cached results after document, cursor or readonly changes', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  const { EditorState, StateEffect } = await import('../../src/vendor/editor/codemirror.mjs');
  for (const response of [[], null, { items: {} }, [item('invalid', 0, 1)], 'failed', [item('each', 16, 18)]]) {
    const f = await fixture('EditorProbe.new.ea');
    const result = await lspCompletions({ complete: async () => { if (response === 'failed') throw Error('offline'); return response; } })(f.context);
    const { state } = f.view;
    const from = result.from;
    assert.equal(result.validFor('ea', from, f.context.pos, state), true);
    const changed = state.update({ changes: { from, to: f.context.pos, insert: 'unique_' }, selection: { anchor: from + 7 } }).state;
    assert.equal(result.validFor('unique_', from, from + 7, changed), false, JSON.stringify(response));
    const moved = state.update({ selection: { anchor: f.context.pos - 1 } }).state;
    assert.equal(result.validFor('e', from, f.context.pos - 1, moved), false, JSON.stringify(response));
    const readonly = state.update({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) }).state;
    assert.equal(result.validFor('ea', from, f.context.pos, readonly), false, JSON.stringify(response));
  }
});

test('LSP requests stay out of blocked contexts and late answers cannot replace changed documents', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  for (const doc of ['# pu', '"pu', '123']) {
    const f = await fixture(doc);
    assert.equal(await lspCompletions({ complete: () => { throw Error('must not call'); } })(f.context), null);
  }
  for (const action of ['cancel', 'edit', 'cursor', 'document']) {
    const f = await fixture('obj.uni');
    const gate = deferred(); let active = true;
    const promise = lspCompletions({ complete: () => gate.promise }, () => active)(f.context);
    if (action === 'cancel') f.cancel();
    if (action === 'edit') f.view.dispatch({ changes: { from: 0, insert: '# ' } });
    if (action === 'cursor') f.view.dispatch({ selection: { anchor: 0 } });
    if (action === 'document') active = false;
    gate.resolve([item('unique_name', 4, 7)]);
    assert.equal(await promise, null, action);
  }
});

test('LSP rejects unsafe edit shapes and stale candidates before insertion', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  const f = await fixture('obj.uni');
  const candidates = [item('bad_range', 4, 100), item('bad_snippet', 4, 7, { insertTextFormat: 2 }), item('bad_command', 4, 7, { command: { command: 'run' } }), item('bad_extra', 4, 7, { additionalTextEdits: [{}] }), item('unique_name', 4, 7)];
  const result = await lspCompletions({ complete: async () => candidates })(f.context);
  assert.ok(!result.options.some(o => o.label.startsWith('bad_')));
  const option = result.options.find(o => o.label === 'unique_name');
  f.view.dispatch({ changes: { from: 0, insert: 'changed ' } });
  option.apply(f.view, option, result.from, 7);
  assert.equal(f.view.state.doc.toString(), 'changed obj.uni');
});

test('LSP rejects edits that cross the cursor line and preserves surrounding lines on valid insertion', async () => {
  const { lspCompletions } = await import('../../src/lsp-completion.mjs');
  const f = await fixture('before\nobj.uni\nafter', 'before\nobj.uni'.length);
  const edit = (label, start, end) => ({ label, kind: 2, textEdit: { newText: label, range: { start, end } } });
  const candidates = [
    edit('bad_start', { line: 0, character: 0 }, { line: 1, character: 7 }),
    edit('bad_end', { line: 1, character: 4 }, { line: 2, character: 5 }),
    edit('bad_both', { line: 0, character: 0 }, { line: 2, character: 5 }),
    edit('unique_name', { line: 1, character: 4 }, { line: 1, character: 7 }),
  ];
  const result = await lspCompletions({ complete: async () => candidates })(f.context);
  assert.ok(!result.options.some(o => o.label.startsWith('bad_')));
  const option = result.options.find(o => o.label === 'unique_name');
  option.apply(f.view, option, result.from, f.context.pos);
  assert.equal(f.view.state.doc.toString(), 'before\nobj.unique_name\nafter');
});

test('LSP client serializes work, skips obsolete queued requests and retries after failure', async () => {
  const { createLspClient } = await import('../../src/lsp-completion.mjs');
  const started = deferred(), gate = deferred();
  const calls = [], statuses = [];
  let fail = false, obsolete = false;
  const client = createLspClient({
    lspStart: async () => { calls.push('start'); },
    lspStop: async () => { calls.push('stop'); },
    lspComplete: async code => { calls.push(code); if (code === 'first') { started.resolve(); await gate.promise; } if (fail) throw Error('server crashed'); return []; },
  }, state => statuses.push(state.status));
  const first = client.complete('first', 0, 0, () => true);
  await started.promise;
  const second = client.complete('obsolete', 0, 0, () => !obsolete);
  const third = client.complete('latest', 0, 0, () => true);
  obsolete = true; gate.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(calls, ['start', 'first', 'latest']);
  fail = true;
  await assert.rejects(client.complete('crash', 0, 0, () => true), /server crashed/);
  assert.equal(statuses.at(-1), 'failed');
  fail = false;
  await client.retry();
  assert.deepEqual(calls.slice(-2), ['stop', 'start']);
  assert.equal(statuses.at(-1), 'ready');
});
