const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('tolerance travels through IPC and invalid values cannot turn into strict mode', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'run_ruby') queueMicrotask(() => args.onEvent.onmessage({ type: 'completed', result: { comparison: true } }));
    }, Channel: class {} }, window: { getCurrentWindow: () => ({}) },
  } };
  const { ide } = await import(`${pathToFileURL(path.join(__dirname, '../../src/bridge.mjs')).href}?tolerance-test`);
  assert.equal((await ide.run('puts 1', '', '1.0', 1e-6)).comparison, true);
  assert.equal(calls[0].args.tolerance, 1e-6);
  for (const value of [0, -1, NaN, Infinity, '', '1e-6']) {
    await assert.rejects(ide.run('', '', '', value), /許容誤差/);
    assert.throws(() => ide.saveCases([{ tolerance: value }]), /許容誤差/);
    assert.throws(() => ide.saveProblemCases('url', [{ tolerance: value }]), /許容誤差/);
  }
  assert.equal(calls.length, 1);
});

test('run preserves the native rejection message exactly', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  globalThis.window = { __TAURI__: {
    core: { invoke: () => Promise.reject('標準入力は 1 MiB 以下にしてください。'), Channel: class {} },
    window: { getCurrentWindow: () => ({}) }
  } };
  const { ide } = await import(pathToFileURL(path.join(__dirname, '../../src/bridge.mjs')).href);
  await assert.rejects(ide.run('', ''), { message: '標準入力は 1 MiB 以下にしてください。' });
});
