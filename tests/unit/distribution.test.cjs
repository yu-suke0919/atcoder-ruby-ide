const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createManifest } = require('../../scripts/runtime-files.cjs');

test('M10: the app carries only the runtime.json it was built with', async () => {
  const { verifyRuntimeJson } = require('../../scripts/package-windows.cjs');
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-wsl-'));
  try {
    const source = path.join(root, 'source.json');
    const wsl = path.join(root, 'wsl');
    await mkdir(wsl);
    await writeFile(source, '{"version":"a"}\n');
    await writeFile(path.join(wsl, 'runtime.json'), '{"version":"a"}\n');
    await verifyRuntimeJson(wsl, source);
    await writeFile(path.join(wsl, 'runtime.json'), '{"version":"b"}\n');
    await assert.rejects(verifyRuntimeJson(wsl, source), /runtime.json differs/);
    await writeFile(path.join(wsl, 'runtime.json'), '{"version":"a"}\n');
    await writeFile(path.join(wsl, 'atcoder-linux.tar.gz'), 'image');
    await assert.rejects(verifyRuntimeJson(wsl, source), /holds other files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('payload manifests reject links to files and directories outside the payload', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-payload-link-'));
  try {
    const runtime = path.join(root, 'runtime');
    const outside = path.join(root, 'outside');
    await mkdir(runtime);
    await mkdir(outside);
    await writeFile(path.join(outside, 'server.rb'), 'outside payload');
    const link = path.join(runtime, 'linked');
    await symlink(outside, link, 'dir');
    await assert.rejects(createManifest(runtime), /Unexpected non-regular file.*linked/);
    await rm(link);
    await symlink(path.join(outside, 'server.rb'), link);
    await assert.rejects(createManifest(runtime), /Unexpected non-regular file.*linked/);
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
