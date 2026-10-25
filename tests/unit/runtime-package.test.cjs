const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const manifest = require('../../config/ruby-windows.json');
const { prepareRuby } = require('../../scripts/prepare-ruby.cjs');

test('M10: reject a corrupt cached archive and preserve the existing Ruby directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-ruby-integrity-'));
  try {
    await mkdir(path.join(root, '.cache'), { recursive: true });
    await writeFile(path.join(root, '.cache', manifest.archive), 'corrupt archive');
    await mkdir(path.join(root, 'vendor', 'ruby'), { recursive: true });
    await writeFile(path.join(root, 'vendor', 'ruby', '.runtime-source.json'), JSON.stringify(manifest));
    await writeFile(path.join(root, 'vendor', 'ruby', 'preserve.txt'), 'keep me');
    await assert.rejects(prepareRuby({ root }), /SHA-256/);
    assert.equal(await readFile(path.join(root, 'vendor', 'ruby', 'preserve.txt'), 'utf8'), 'keep me');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('M10: do not replace an unmanaged runtime directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-ruby-existing-'));
  try {
    await mkdir(path.join(root, 'vendor', 'ruby'), { recursive: true });
    await writeFile(path.join(root, 'vendor', 'ruby', 'user.txt'), 'preserved');
    await assert.rejects(prepareRuby({ root }), /既存/);
    assert.equal(await readFile(path.join(root, 'vendor', 'ruby', 'user.txt'), 'utf8'), 'preserved');
  } finally { await rm(root, { recursive: true, force: true }); }
});
