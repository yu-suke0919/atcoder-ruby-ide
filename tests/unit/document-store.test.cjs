const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { DocumentStore } = require('../../src/document-store.cjs');

test('M02/M03: open and overwrite a UTF-8 Ruby file at a Japanese path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE 日本語 '));
  try {
    const file = path.join(root, '解答.rb');
    await writeFile(file, '\uFEFFputs "こんにちは"\n', 'utf8');
    const store = new DocumentStore({ chooseOpen: async () => file });
    assert.deepEqual(await store.open(), { canceled: false, filePath: file, code: 'puts "こんにちは"\n' });
    assert.deepEqual(await store.save('puts 2\n'), { canceled: false, filePath: file });
    assert.equal(await readFile(file, 'utf8'), 'puts 2\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('M03: save a new file, then save as another file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-save-'));
  try {
    const first = path.join(root, 'first.rb');
    const second = path.join(root, 'second.rb');
    const choices = [first, second];
    const store = new DocumentStore({ chooseSave: async () => choices.shift() });
    assert.equal((await store.save('puts 1')).filePath, first);
    assert.equal((await store.save('puts 2', { saveAs: true })).filePath, second);
    assert.equal(await readFile(first, 'utf8'), 'puts 1');
    assert.equal(await readFile(second, 'utf8'), 'puts 2');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('M02/M03: canceled operations retain the current path', async () => {
  const store = new DocumentStore({ chooseOpen: async () => null, chooseSave: async () => null });
  assert.deepEqual(await store.open(), { canceled: true });
  assert.deepEqual(await store.save('puts 1'), { canceled: true });
  assert.equal(store.filePath, null);
});

test('M03: a write failure does not change the current path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-failed-save-'));
  try {
    const valid = path.join(root, 'valid.rb');
    const choices = [valid, path.join(root, 'missing', 'bad.rb')];
    const store = new DocumentStore({ chooseSave: async () => choices.shift() });
    await store.save('original');
    await assert.rejects(store.save('changed', { saveAs: true }));
    assert.equal(store.filePath, valid);
    assert.equal(await readFile(valid, 'utf8'), 'original');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('M02: a read failure preserves the selected document', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-read-'));
  try {
    const file = path.join(root, 'valid.rb');
    await writeFile(file, 'puts 1');
    const choices = [file, path.join(root, 'missing.rb')];
    const store = new DocumentStore({ chooseOpen: async () => choices.shift() });
    await store.open();
    await assert.rejects(store.open());
    assert.equal(store.filePath, file);
    store.reset();
    assert.equal(store.filePath, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
