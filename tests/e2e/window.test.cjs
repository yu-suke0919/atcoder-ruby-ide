const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { runner, launch, close, requestClose, moveWindow } = require('./support.cjs');

test('U2c: the window size and position come back on the next start', { skip: runner !== 'native' && 'needs the desktop window' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE window '));
  const state = path.join(process.env.APPDATA ?? '', require('../../src-tauri/tauri.conf.json').identifier, '.window-state.json');
  const bounds = app => app.page.evaluate(async () => {
    const window = globalThis.window.__TAURI__.window.getCurrentWindow();
    const [position, size] = [await window.outerPosition(), await window.outerSize()];
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  });
  let app;
  try {
    await rm(state, { force: true });
    app = await launch(root);
    await moveWindow(app, { x: 40, y: 30, width: 1400, height: 820 });
    const moved = await bounds(app);
    assert.deepEqual(moved, { x: 40, y: 30, width: 1400, height: 820 });
    await Promise.all([once(app.child, 'exit', { signal: AbortSignal.timeout(30000) }), requestClose(app)]);
    await close(app);
    app = await launch(root);
    assert.deepEqual(await bounds(app), moved);
  } finally {
    if (app) await close(app);
    await rm(state, { force: true });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// Preparing the agent the first time can take minutes; closing must not wait for it to stop a
// run that is not there.
test('closing with nothing running does not ask to stop a run', { skip: runner !== 'browser' && 'reads the commands the screen sends to the test host' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE close '));
  const app = await launch(root);
  try {
    await app.page.waitForFunction(() => !document.getElementById('ruby-recheck').disabled);
    await Promise.all([once(app.child, 'exit', { signal: AbortSignal.timeout(30000) }), requestClose(app)]);
    assert.equal(app.commands.includes('stop_ruby'), false, app.commands.join(', '));
  } finally {
    await close(app);
    await rm(root, { recursive: true, force: true });
  }
});
