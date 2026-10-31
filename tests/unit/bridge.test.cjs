const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
