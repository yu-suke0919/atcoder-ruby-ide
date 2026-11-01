const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('problem limits travel to Rust and started carries the actual execution budget', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => {
      calls.push(args);
      queueMicrotask(() => {
        args.onEvent.onmessage({ type: 'started', executionLimitMs: 9000 });
        args.onEvent.onmessage({ type: 'completed', result: { status: 'completed', executionLimitMs: 9000 } });
      });
    }, Channel: class {} }, window: { getCurrentWindow: () => ({}) },
  } };
  const { ide } = await import(`${pathToFileURL(path.join(__dirname, '../../src/bridge.mjs')).href}?execution-limit-test`);
  const events = [];
  const result = await ide.run('', '', null, null, 8000, event => events.push(event));
  assert.equal(calls[0].problemTimeLimitMs, 8000);
  assert.deepEqual(events, [{ type: 'started', executionLimitMs: 9000 }]);
  assert.equal(result.executionLimitMs, 9000);
  for (const value of [0, -1, 1.5, NaN, Infinity, 4294967296, '8000']) {
    await assert.rejects(ide.run('', '', null, null, value), /問題の時間制限/);
  }
  assert.equal(calls.length, 1);
});

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
    assert.throws(() => ide.saveTaskCases('url', [{ tolerance: value }]), /許容誤差/);
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

test('M03: the bridge only saves into the opened workspace and has no external file APIs', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
  const calls = [];
  globalThis.window = { __TAURI__: {
    core: { invoke: async (command, args) => { calls.push({ command, args }); }, Channel: class {} },
    window: { getCurrentWindow: () => ({}) },
  } };
  const { ide } = await import(`${pathToFileURL(path.join(__dirname, '../../src/bridge.mjs')).href}?workspace-only`);
  await ide.saveCode('puts 1');
  await ide.resetSession();
  assert.deepEqual(calls, [{ command: 'document_save', args: { code: 'puts 1' } }, { command: 'session_reset', args: undefined }]);
  for (const name of ['openFile', 'saveFile', 'newFile', 'openCases', 'saveCases', 'confirmDiscard']) assert.equal(ide[name], undefined, name);
});
