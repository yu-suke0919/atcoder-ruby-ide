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
  const result = await ide.run('', '', null, null, 8000, 256, event => events.push(event));
  assert.equal(calls[0].problemTimeLimitMs, 8000);
  assert.equal(calls[0].problemMemoryLimitMib, 256);
  assert.deepEqual(events, [{ type: 'started', executionLimitMs: 9000 }]);
  assert.equal(result.executionLimitMs, 9000);
  for (const value of [0, -1, 1.5, NaN, Infinity, 4294967296, '8000']) {
    await assert.rejects(ide.run('', '', null, null, value), /問題の時間制限/);
    await assert.rejects(ide.run('', '', null, null, null, value), /問題のメモリ制限/);
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
    assert.throws(() => ide.saveSamples('home', { tolerance: value, cases: [] }), /許容誤差/);
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
  await ide.saveCode('puts 1', 3);
  await ide.resetSession();
  assert.deepEqual(calls, [{ command: 'document_save', args: { code: 'puts 1', revision: 3 } }, { command: 'session_reset', args: undefined }]);
  for (const name of ['saveFile', 'newFile', 'openCases', 'saveCases', 'confirmDiscard']) assert.equal(ide[name], undefined, name);
  // Files are tabs of a workspace: the commands name the workspace and the tab, never a path.
  calls.length = 0;
  await ide.openFile('home', 'home_1');
  await ide.createFile('https://atcoder.jp/contests/abc430/tasks/abc430_a', 'A');
  await ide.renameFile('home', 'home_1', 'main');
  await ide.deleteFile('home', 'home_2');
  assert.deepEqual(calls, [
    { command: 'file_open', args: { workspace: 'home', name: 'home_1' } },
    { command: 'file_create', args: { workspace: 'https://atcoder.jp/contests/abc430/tasks/abc430_a', label: 'A' } },
    { command: 'file_rename', args: { workspace: 'home', from: 'home_1', to: 'main' } },
    { command: 'file_delete', args: { workspace: 'home', name: 'home_2' } }
  ]);
});

// The UI test host hands the bridge's arguments to the agent as they are, so only this test sees
// that Tauri names each argument after its Rust parameter in camelCase (docs/architecture.md).
test('the bridge sends each command the argument names Tauri reads from the Rust parameters', () => {
  const fs = require('node:fs');
  const camel = name => name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  const injected = /^(tauri::)?(AppHandle|State|Window|Webview|WebviewWindow)\b/;
  const commands = new Map();
  // Every file of the app, so commands moved to another module are still read.
  for (const file of fs.readdirSync(path.join(__dirname, '../../src-tauri')).filter(name => name.endsWith('.rs'))) {
    const source = fs.readFileSync(path.join(__dirname, '../../src-tauri', file), 'utf8');
    for (const [, name, params] of source.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(([^)]*)\)/g)) {
      // Commas inside generics such as State<'_, AppState> do not separate parameters.
      const names = params.split(/,(?![^<]*>)/).map(param => param.trim()).filter(Boolean)
        .map(param => param.match(/^(\w+)\s*:\s*(.*)$/s)).filter(([, , type]) => !injected.test(type))
        .map(([, name]) => camel(name));
      commands.set(name, names.sort());
    }
  }
  const bridge = fs.readFileSync(path.join(__dirname, '../../src/bridge.mjs'), 'utf8');
  const calls = [...bridge.matchAll(/invoke\('(\w+)'(?:,\s*\{([^}]*)\})?\)/g)];
  assert.ok(calls.length >= 20);
  for (const [, command, args = ''] of calls) {
    const sent = args.split(',').map(arg => arg.split(':')[0].trim()).filter(Boolean).sort();
    assert.deepEqual(sent, commands.get(command), command);
  }
});

// Windows refuses a command its capability does not allow; the UI test host has no capabilities,
// so only this test sees a command left out (U5a).
test('every command the app declares is allowed for its own page', () => {
  const fs = require('node:fs');
  const build = fs.readFileSync(path.join(__dirname, '../../src-tauri/build.rs'), 'utf8');
  const declared = [...build.slice(build.indexOf('.commands(&[')).matchAll(/"(\w+)"/g)].map(([, name]) => name);
  assert.ok(declared.includes('run_ruby'));
  const capability = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src-tauri/capabilities/main.json'), 'utf8'));
  for (const name of declared) assert.ok(capability.permissions.includes(`allow-${name.replaceAll('_', '-')}`), name);
});
