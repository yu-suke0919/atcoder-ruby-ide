const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const vm = require('node:vm');

test('run preserves the native rejection message exactly', async () => {
  const source = (await readFile('src/bridge.js', 'utf8')).replace('export const ide', 'globalThis.ide');
  const context = vm.createContext({ TextDecoder, window: { __TAURI__: {
    core: { invoke: () => Promise.reject('標準入力は 1 MiB 以下にしてください。'), Channel: class {} },
    window: { getCurrentWindow: () => ({}) }
  } } });
  vm.runInContext(source, context);
  await assert.rejects(context.ide.run('', ''), { message: '標準入力は 1 MiB 以下にしてください。' });
});
