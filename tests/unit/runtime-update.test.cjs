const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const updateModule = () => require('../../scripts/update-ruby.cjs');
const hash = 'a'.repeat(64);
const releaseList = versions => versions.map(version => `- version: ${version}`).join('\n');
function downloads(versions) {
  return versions.map(entry => {
    const { version, arch = 'x64', prefix = 'rubyinstaller', filetype = 'rubyinstaller7z', sha256 = hash } = typeof entry === 'string' ? { version: entry } : entry;
    return `- filetype: ${filetype}\n  href: https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-${version}/${prefix}-${version}-${arch}.7z\n  sha256: '${sha256}'`;
  }).join('\n');
}
const metadata = () => [releaseList(['3.4.9', '4.0.9', '3.4.12', '3.5.0', '3.4.99-preview1']), downloads(['3.4.9-1', '3.4.12-2', '3.4.12-10', '4.0.9-1', { version: '3.4.12-99', arch: 'arm' }, { version: '3.4.12-99', arch: 'x86' }, { version: '3.4.12-99', prefix: 'rubyinstaller-devkit' }])];
async function fixture(t, previous = '3.4.5-1') {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-ruby-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'config'));
  const file = path.join(root, 'config/ruby-windows.json');
  const original = `${JSON.stringify({ version: previous })}\n`;
  await writeFile(file, original);
  return { root, file, original };
}
function fetchFixture(ruby, windows) {
  const { RUBY_RELEASES, WINDOWS_DOWNLOADS } = updateModule();
  return async url => {
    if (url === RUBY_RELEASES) return ruby;
    assert.equal(url, WINDOWS_DOWNLOADS);
    return windows;
  };
}

test('Ruby update selects the newest stable 3.4 patch and numeric x64 Installer revision', () => {
  const source = updateModule().selectRuby(...metadata());
  assert.equal(source.rubyVersion, '3.4.12');
  assert.equal(source.version, '3.4.12-10');
  assert.equal(source.archive, 'rubyinstaller-3.4.12-10-x64.7z');
  assert.equal(source.sha256, hash);
  assert.equal(source.arch, 'x64');
  assert.equal(source.platform, 'win32');
});

test('Ruby update refuses missing Windows patches, invalid hashes and non-official assets', () => {
  const { selectRuby } = updateModule();
  assert.throws(() => selectRuby(releaseList(['3.4.13']), downloads(['3.4.12-1'])), /Windows/);
  assert.throws(() => selectRuby(releaseList(['4.0.9', '3.4.13-preview1']), downloads(['3.4.12-1'])), /3\.4/);
  assert.throws(() => selectRuby(releaseList(['3.4.12']), downloads([{ version: '3.4.12-2', sha256: 'invalid' }, '3.4.12-1'])), /SHA-256/);
  assert.throws(() => selectRuby(releaseList(['3.4.12']), downloads(['3.4.12-1']).replace('github.com/oneclick', 'example.com/oneclick')), /Windows/);
  assert.throws(() => selectRuby('invalid: schema', downloads(['3.4.12-1'])), /一覧/);
});

test('Ruby update writes the selected lock only after runtime preparation succeeds', async t => {
  const { updateRuby } = updateModule();
  const { root, file, original } = await fixture(t);
  let prepared = false;
  const source = await updateRuby({ root, fetchMetadata: fetchFixture(...metadata()), prepare: async options => {
    assert.equal(options.root, root);
    assert.equal(options.source.rubyVersion, '3.4.12');
    assert.equal(await readFile(file, 'utf8'), original);
    prepared = true;
  } });
  assert.ok(prepared);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), source);
});

test('Ruby update preserves the lock on metadata or preparation failures and rejects downgrades', async t => {
  const { updateRuby } = updateModule();
  const { root, file, original } = await fixture(t, '3.4.20-1');
  const prepare = async () => { assert.fail('Must not prepare a downgraded runtime'); };
  await assert.rejects(updateRuby({ root, fetchMetadata: async () => { throw Error('offline'); }, prepare }), /offline/);
  await assert.rejects(updateRuby({ root, fetchMetadata: fetchFixture(...metadata()), prepare }), /古い/);
  assert.equal(await readFile(file, 'utf8'), original);
  const other = await fixture(t);
  await assert.rejects(updateRuby({ root: other.root, fetchMetadata: fetchFixture(...metadata()), prepare: async () => { throw Error('preparation failed'); } }), /preparation failed/);
  assert.equal(await readFile(other.file, 'utf8'), other.original);
});

test('Ruby update rejects a corrupt archive before changing the lock or managed runtime', async t => {
  const { updateRuby, selectRuby } = updateModule();
  const { root, file, original } = await fixture(t);
  const source = selectRuby(...metadata());
  await mkdir(path.join(root, '.cache'));
  await writeFile(path.join(root, '.cache', source.archive), 'corrupt bytes');
  const runtime = path.join(root, 'vendor/ruby');
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, '.runtime-source.json'), '{}');
  await writeFile(path.join(runtime, 'preserve.txt'), 'keep');
  await assert.rejects(updateRuby({ root, fetchMetadata: fetchFixture(...metadata()) }), /SHA-256/);
  assert.equal(await readFile(file, 'utf8'), original);
  assert.equal(await readFile(path.join(runtime, 'preserve.txt'), 'utf8'), 'keep');
});
