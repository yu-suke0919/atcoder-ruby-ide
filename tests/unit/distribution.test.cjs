const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
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
