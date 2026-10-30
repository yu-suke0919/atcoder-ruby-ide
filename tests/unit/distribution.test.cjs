const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createManifest, verifyRuntime } = require('../../scripts/runtime-files.cjs');

test('M10: final payload verification rejects modified, missing and unexpected files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-payload-'));
  try {
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin/ruby.exe'), 'original runtime');
    await writeFile(path.join(root, 'LICENSE.txt'), 'license');
    const expected = await createManifest(root);
    await verifyRuntime(root, expected);
    await writeFile(path.join(root, 'bin/ruby.exe'), 'modified runtime');
    await assert.rejects(verifyRuntime(root, expected));
    await writeFile(path.join(root, 'bin/ruby.exe'), 'original runtime');
    await rm(path.join(root, 'LICENSE.txt'));
    await assert.rejects(verifyRuntime(root, expected));
    await writeFile(path.join(root, 'LICENSE.txt'), 'license');
    await writeFile(path.join(root, 'extra.txt'), 'unexpected');
    await assert.rejects(verifyRuntime(root, expected));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('M10: runtime manifests reject links to files and directories outside the payload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-payload-link-'));
  try {
    const runtime = path.join(root, 'runtime');
    const outside = path.join(root, 'outside');
    await mkdir(runtime);
    await mkdir(outside);
    await writeFile(path.join(outside, 'ruby.exe'), 'outside payload');
    const link = path.join(runtime, 'linked');
    // Windows junctions need no symlink privilege and cover the directory-link case.
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createManifest(runtime), /Unexpected non-regular file.*linked/);
    await rm(link);
    if (process.platform !== 'win32') {
      await symlink(path.join(outside, 'ruby.exe'), link);
      await assert.rejects(createManifest(runtime), /Unexpected non-regular file.*linked/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('release versions agree and Tauri reads package.json', async () => {
  const { readFile } = require('node:fs/promises');
  const version = require('../../package.json').version;
  const config = require('../../src-tauri/tauri.conf.json');
  assert.equal(config.version, '../package.json');
  const cargo = await readFile(path.join(__dirname, '../../src-tauri/Cargo.toml'), 'utf8');
  assert.equal(cargo.match(/^version = "([^"]+)"/m)[1], version);
});
