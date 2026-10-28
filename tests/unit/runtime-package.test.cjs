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

test('M10: trim documentation and headers while preserving runtime bytes and license notices', async () => {
  const { trimRuntime } = require('../../scripts/prepare-ruby.cjs');
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-ruby-trim-'));
  try {
    const fixture = {
      'bin/ruby.exe': 'ruby executable', 'lib/ruby/json.so': 'native extension',
      'LICENSE.txt': 'installer license', 'share/doc/ruby/html/COPYING.html': 'ruby copying',
      'share/doc/ruby/html/COPYING_ja.html': 'ruby copying ja', 'share/doc/ruby/html/LEGAL.html': 'third party notices',
      'share/ri/large.ri': 'offline manual', 'include/ruby.h': 'C header'
    };
    for (const [name, text] of Object.entries(fixture)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), text);
    }
    await trimRuntime(root);
    for (const name of ['bin/ruby.exe', 'lib/ruby/json.so', 'LICENSE.txt']) assert.equal(await readFile(path.join(root, name), 'utf8'), fixture[name]);
    for (const name of ['COPYING.html', 'COPYING_ja.html', 'LEGAL.html']) assert.equal(await readFile(path.join(root, 'licenses/ruby', name), 'utf8'), fixture[`share/doc/ruby/html/${name}`]);
    for (const directory of ['share', 'include']) await assert.rejects(readFile(path.join(root, directory)), { code: 'ENOENT' });
    await trimRuntime(root); // Already-trimmed managed runtimes remain usable.
    assert.equal(await readFile(path.join(root, 'licenses/ruby/LEGAL.html'), 'utf8'), 'third party notices');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('M10: an existing managed runtime is trimmed before cache reuse', async () => {
  const { createHash } = require('node:crypto');
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-ruby-cache-'));
  const data = Buffer.from('verified cached archive fixture');
  const source = { ...manifest, sha256: createHash('sha256').update(data).digest('hex') };
  try {
    await mkdir(path.join(root, '.cache'), { recursive: true });
    await writeFile(path.join(root, '.cache', source.archive), data);
    const runtime = path.join(root, 'vendor/ruby');
    for (const [name, text] of Object.entries({
      'bin/ruby.exe': 'keep', 'include/ruby.h': 'remove', 'LICENSE.txt': 'keep license',
      'share/doc/ruby/html/COPYING.html': 'copying', 'share/doc/ruby/html/COPYING_ja.html': 'copying ja',
      'share/doc/ruby/html/LEGAL.html': 'legal', '.runtime-source.json': JSON.stringify({ ...source, gems: require('../../config/atcoder-runtime.json').gems })
    })) {
      await mkdir(path.dirname(path.join(runtime, name)), { recursive: true });
      await writeFile(path.join(runtime, name), text);
    }
    assert.equal(await prepareRuby({ root, source }), runtime);
    await assert.rejects(readFile(path.join(runtime, 'include/ruby.h')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(runtime, 'licenses/ruby/LEGAL.html'), 'utf8'), 'legal');
    assert.equal(await prepareRuby({ root, source }), runtime);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('M19: changing the gem snapshot rebuilds Ruby; a failed rebuild preserves the old installation', async () => {
  const { createHash } = require('node:crypto');
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-ruby-gems-change-'));
  const data = Buffer.from('corrupt archive with a matching hash');
  const source = { ...manifest, sha256: createHash('sha256').update(data).digest('hex') };
  try {
    await mkdir(path.join(root, '.cache'), { recursive: true });
    await writeFile(path.join(root, '.cache', source.archive), data);
    const runtime = path.join(root, 'vendor/ruby');
    await mkdir(path.join(runtime, 'bin'), { recursive: true });
    await writeFile(path.join(runtime, 'bin/ruby.exe'), 'preserve');
    await writeFile(path.join(runtime, '.runtime-source.json'), JSON.stringify({ ...source, gems: [] }));
    await assert.rejects(prepareRuby({ root, source }), /Command failed/);
    assert.equal(await readFile(path.join(runtime, 'bin/ruby.exe'), 'utf8'), 'preserve');
  } finally { await rm(root, { recursive: true, force: true }); }
});
