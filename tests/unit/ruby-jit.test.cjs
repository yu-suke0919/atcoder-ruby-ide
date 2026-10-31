const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, rm, access } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts/probe-ruby-jit.cjs');
const pinned = require('../../config/ruby-windows.json');

test('pinned Ruby JIT probes distinguish ignored flags from enabled engines', { timeout: 30000 }, async () => {
  const { stdout } = await execute(process.execPath, [script], {
    env: { ...process.env, RUBYOPT: '-ride_jit_probe_must_remove_this', RUBY_YJIT_ENABLE: '1', RUBY_THREAD_VM_STACK_SIZE: '65536' },
    windowsHide: true,
  });
  console.log(stdout.trim());
  const report = JSON.parse(await readFile(path.join(root, 'test-results/ruby-jit.json'), 'utf8'));
  assert.equal(report.platform, process.platform);
  assert.deepEqual(report.measurements.map(row => row.option), ['default', '--jit', '--yjit', '--rjit']);
  for (const row of report.measurements) {
    assert.equal(row.exitCode, 0, row.stderr);
    assert.equal(row.signal, null);
    const state = row.runtime;
    assert.equal(state.rubyVersion, pinned.rubyVersion);
    assert.ok(path.isAbsolute(state.executable));
    assert.equal(state.vmStackBytes, 32 * 1024 * 1024);
    assert.equal(state.checksum, 5050);
    assert.ok(['yes', 'no', 'dev', 'stats', 'dev_nodebug'].includes(state.yjitSupport));
    assert.ok(['yes', 'no', 'dev'].includes(state.rjitSupport));
    const yjit = state.yjitSupport !== 'no';
    const rjit = state.rjitSupport !== 'no';
    assert.equal(state.yjitEnabled, (row.option === '--jit' || row.option === '--yjit') && yjit);
    assert.equal(state.rjitEnabled, (row.option === '--jit' && !yjit || row.option === '--rjit') && rjit);
    if (state.yjitEnabled) assert.equal(state.yjitAvailable, true);
    if (state.rjitEnabled) assert.equal(state.rjitAvailable, true);
    if (row.option === '--jit' && !yjit && !rjit) assert.match(row.stderr, /built without JIT support/);
    if (row.option === '--yjit' && !yjit) assert.match(row.stderr, /built without YJIT support/);
    if (row.option === '--rjit' && !rjit) assert.match(row.stderr, /RJIT support is disabled/);
    if (row.option === 'default') assert.equal(row.stderr, '');
    if (process.platform === 'win32') {
      // A Ruby update that adds Windows JIT support must revisit the documented decision.
      assert.equal(state.yjitSupport, 'no');
      assert.equal(state.rjitSupport, 'no');
    }
  }
});

test('a missing Ruby executable fails the probe instead of reporting no JIT support', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'IDE JIT 日本語 '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'ruby-jit.json');
  await assert.rejects(execute(process.execPath, [script, report], {
    env: { ...process.env, RUBY_PATH: path.join(directory, 'missing-ruby') }, windowsHide: true,
  }), error => error.code === 1 && /ENOENT/.test(error.stderr));
  await assert.rejects(access(report), { code: 'ENOENT' });
});
