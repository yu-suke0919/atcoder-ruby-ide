const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../../src/layout.mjs')).href);

test('saved pane sizes are restored only when every value is a number in range', async () => {
  const { DEFAULT_LAYOUT, restoreLayout } = await load();
  assert.deepEqual(restoreLayout(null), DEFAULT_LAYOUT);
  assert.deepEqual(restoreLayout('not json'), DEFAULT_LAYOUT);
  const saved = { rail: 80, tasks: 250, browser: 0.6, editor: 0.4, input: 0.3 };
  assert.deepEqual(restoreLayout(JSON.stringify(saved)), saved);
  // Out-of-range or missing values fall back to the default for that pane only.
  assert.deepEqual(restoreLayout(JSON.stringify({ ...saved, rail: 500, browser: 'wide', input: undefined })), { ...saved, rail: DEFAULT_LAYOUT.rail, browser: DEFAULT_LAYOUT.browser, input: DEFAULT_LAYOUT.input });
});

test('pane sizes are laid out with pixel widths for the left columns and minimum sizes for shared space', async () => {
  const { DEFAULT_LAYOUT, layoutStyles } = await load();
  const styles = layoutStyles({ ...DEFAULT_LAYOUT, rail: 70, tasks: 200, browser: 0.4, editor: 0.6, input: 0.25 });
  // Factors stay at 10 or more, so a pane that can still grow gets all of the free space.
  assert.equal(styles.columns, '70px 5px 200px 5px minmax(480px, 60fr) 5px minmax(360px, 40fr)');
  assert.equal(styles.io, 'minmax(200px, 25fr) 5px minmax(200px, 75fr)');
  assert.deepEqual([styles.editor, styles.lower], ['60', '40']);
});

test('dragging clamps pixel widths and shares to their limits', async () => {
  const { resize } = await load();
  assert.equal(resize('rail', 300), 96);
  assert.equal(resize('rail', 10), 40);
  assert.equal(resize('tasks', 220), 220);
  assert.equal(resize('browser', 0.99), 0.9);
  assert.equal(resize('editor', 0.01), 0.1);
});
