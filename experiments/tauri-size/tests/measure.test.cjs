const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm, cp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { measure } = require('../measure.cjs');

test('measure real file sizes and compare the same Ruby payload in both formats', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tauri-size-'));
  try {
    const electronDir = path.join(root, 'electron');
    const tauriDir = path.join(root, 'tauri');
    await mkdir(path.join(electronDir, 'resources/ruby/bin'), { recursive: true });
    await mkdir(tauriDir);
    await writeFile(path.join(electronDir, 'AtCoder Ruby IDE.exe'), Buffer.alloc(200));
    await writeFile(path.join(electronDir, 'resources/ruby/bin/ruby.exe'), Buffer.alloc(100));
    await cp(path.join(electronDir, 'resources/ruby'), path.join(tauriDir, 'ruby'), { recursive: true });
    await writeFile(path.join(tauriDir, 'tauri-size-probe.exe'), Buffer.alloc(50));
    const files = {};
    for (const [name, size] of Object.entries({ electronPackage: 120, tauriPackage: 60, electronZip: 150, tauriZip: 75 })) {
      files[name] = path.join(root, name);
      await writeFile(files[name], Buffer.alloc(size));
    }
    const result = await measure({ electronDir, tauriDir, ...files });
    assert.equal(result.electron.expandedBytes, 300);
    assert.equal(result.tauri.expandedBytes, 150);
    assert.equal(result.electron.executableBytes, 200);
    assert.equal(result.tauri.executableBytes, 50);
    assert.equal(result.ruby.bytes, 100);
    assert.equal(result.ruby.identical, true);
    assert.equal(result.packages.reductionPercent, 50);
    assert.equal(result.zip.reductionPercent, 50);
    await writeFile(path.join(tauriDir, 'ruby/bin/ruby.exe'), Buffer.alloc(100, 1));
    await assert.rejects(measure({ electronDir, tauriDir, ...files }), /Ruby.*一致/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
