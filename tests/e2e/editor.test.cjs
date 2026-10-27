const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, readFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { launch, close, dialogs, open, save, discard } = require('./support.cjs');
const { editorText } = require('./editor.cjs');
describe('Ruby editor', () => {
let app, page, root;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'Ruby editor 日本語 '));
  app = await launch(root); page = app.page;
});
beforeEach(async () => {
  const accept = dialog => dialog.accept();
  page.on('dialog', accept);
  try { await page.reload(); } finally { page.off('dialog', accept); }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.waitForFunction(() => !document.getElementById('run').disabled);
});
after(async () => { if (app) await close(app); if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
const code = () => page.getByRole('textbox', { name: 'Ruby コード', exact: true });

test('E01: Ruby highlighting, line numbers and search fit the minimum viewport', async () => {
  assert.equal(await page.locator('.cm-editor').count(), 1);
  await code().fill('if true\n  puts "日本語" # comment\n  value = 123\nend');
  assert.ok(await page.locator('.cm-content span').count() >= 5);
  const colors = await page.locator('.cm-content span').evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).color))]);
  assert.ok(colors.length >= 3, JSON.stringify(colors));
  assert.ok(await page.locator('.cm-lineNumbers').textContent().then(text => text.includes('4')));
  await code().fill('puts "long line" # ' + 'x'.repeat(300) + '\n' + 'puts 1\n'.repeat(120));
  for (const [width, height] of [[1440, 900], [900, 650]]) {
    await page.setViewportSize({ width, height });
    await code().press('Control+Home');
    await page.getByRole('button', { name: '検索・置換', exact: true }).click();
    const layout = await page.locator('.cm-scroller').evaluate(el => ({ scroll: el.scrollHeight > el.clientHeight, horizontal: el.scrollWidth > el.clientWidth, height: el.clientHeight, bottom: el.closest('.editor-panel').getBoundingClientRect().bottom, toolbar: document.querySelector('.run-toolbar').getBoundingClientRect().top, width: document.documentElement.scrollWidth }));
    assert.ok(layout.scroll && layout.horizontal && layout.height >= 24 && layout.bottom <= layout.toolbar && layout.width <= width, JSON.stringify(layout));
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: `test-results/ruby-editor-${width}.png` });
    await page.keyboard.press('Escape');
  }
});

test('E02: Ruby newline indentation, selected line indent and undo redo', async () => {
  await code().fill('if true');
  await code().press('End'); await code().press('Enter');
  assert.equal(await editorText(page), 'if true\n  ');
  assert.equal(await page.locator('#cursor-position').textContent(), 'Ln 2, Col 3');
  await code().press('Tab'); assert.equal(await editorText(page), 'if true\n    ');
  await code().press('Shift+Tab'); assert.equal(await editorText(page), 'if true\n  ');
  await code().fill('puts 1\nputs 2');
  await code().press('Control+a'); await code().press('Tab');
  assert.equal(await editorText(page), '  puts 1\n  puts 2');
  await code().press('Control+z'); assert.equal(await editorText(page), 'puts 1\nputs 2');
  await code().press('Control+y'); assert.equal(await editorText(page), '  puts 1\n  puts 2');
  await code().press('Shift+Tab'); assert.equal(await editorText(page), 'puts 1\nputs 2');
  await code().press('Escape'); await page.keyboard.press('Tab');
  assert.equal(await code().evaluate(el => el.contains(document.activeElement)), false);
});

test('E03: bracket and quote pairing, matching and composition preserve Japanese', async () => {
  await code().fill(''); await code().press('(');
  assert.equal(await editorText(page), '()');
  await page.locator('.cm-matchingBracket').first().waitFor();
  await code().press(')'); assert.equal(await editorText(page), '()');
  await code().fill(''); await code().press('['); assert.equal(await editorText(page), '[]');
  await code().fill(''); await code().press('{'); assert.equal(await editorText(page), '{}');
  await code().fill(''); await code().press('"'); assert.equal(await editorText(page), '""');
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
    await cdp.send('Input.imeSetComposition', { text: '日本語', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.insertText', { text: '日本語' });
    await page.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('日本語'));
    assert.equal(await editorText(page), '"日本語"');
    assert.match(await page.locator('#save-state').textContent(), /未保存の変更/);
  } finally { await cdp.detach(); }
});

test('E04: search preserves saved state and replacements invalidate comparisons with undo', async () => {
  const file = path.join(root, 'search.rb');
  await code().fill('puts "cat cat"');
  await dialogs(app, () => page.locator('#save').click(), [save(file)]);
  await page.locator('#compare-output').check(); await page.locator('#expected-output').fill('cat cat\n');
  await page.locator('#run').click(); await page.locator('#comparison-status').filter({ hasText: '一致' }).waitFor();
  await code().press('Control+f');
  await page.getByRole('textbox', { name: '検索', exact: true }).fill('cat');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('button', { name: '前へ', exact: true }).click();
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
  await page.getByRole('textbox', { name: '置換', exact: true }).fill('dog');
  await page.getByRole('button', { name: 'すべて置換', exact: true }).click();
  assert.equal(await editorText(page), 'puts "dog dog"');
  assert.match(await page.locator('#save-state').textContent(), /未保存の変更/);
  assert.equal(await page.locator('#comparison-status').textContent(), '未比較');
  await page.keyboard.press('Escape'); await code().press('Control+z');
  assert.equal(await editorText(page), 'puts "cat cat"');
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  await code().press('Control+Home');
  await code().press('Control+h'); await page.getByRole('textbox', { name: '検索', exact: true }).waitFor();
  await page.getByRole('textbox', { name: '置換', exact: true }).fill('fox');
  await page.getByRole('button', { name: '次へ', exact: true }).click();
  await page.getByRole('button', { name: '置換する', exact: true }).click();
  assert.equal(await editorText(page), 'puts "fox cat"');
  await page.keyboard.press('Escape'); await code().press('Control+s');
  await page.waitForFunction(() => document.getElementById('save-state').textContent === '保存済み');
  assert.equal(await readFile(file, 'utf8'), 'puts "fox cat"');
  await code().press('Control+z'); assert.equal(await editorText(page), 'puts "cat cat"');
  assert.match(await page.locator('#save-state').textContent(), /未保存の変更/);
  await code().press('Control+y'); assert.equal(await editorText(page), 'puts "fox cat"');
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  await code().press('Control+Enter');
  await page.locator('#stdout').filter({ hasText: 'fox cat' }).waitFor();
  assert.equal(await editorText(page), 'puts "fox cat"');
});

test('E05: opening a different document clears undo and a 1 MiB file roundtrips', async () => {
  await code().fill('puts "previous secret"');
  const file = path.join(root, 'large.rb');
  const contents = '# 日本語\n' + '#'.repeat(1024 * 1024 - Buffer.byteLength('# 日本語\n'));
  await writeFile(file, contents);
  await dialogs(app, () => code().press('Control+o'), [discard(true), open(file)]);
  assert.equal(await editorText(page), contents);
  await code().press('Control+z'); assert.equal(await editorText(page), contents);
  await code().press('Control+s');
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.equal(await readFile(file, 'utf8'), contents);
  await page.locator('#new').click();
  await page.waitForFunction(() => !document.getElementById('new').disabled);
  await code().press('Control+z'); assert.equal(await editorText(page), '');
});

test('E06: a pending file action blocks both typing and search replacements', async () => {
  await code().fill('puts "locked"');
  await code().press('Control+f');
  await page.getByRole('textbox', { name: '検索', exact: true }).fill('locked');
  await page.getByRole('textbox', { name: '置換', exact: true }).fill('changed');
  await page.evaluate(async () => {
    const { ide } = await import('./bridge.js');
    ide.saveFile = () => new Promise(resolve => { window.finishEditorSave = () => resolve({ canceled: true }); });
  });
  await page.locator('#save').click();
  try {
    assert.equal(await code().isEditable(), false);
    assert.equal(await page.locator('#editor-search').isDisabled(), true);
    const replace = page.getByRole('button', { name: 'すべて置換', exact: true });
    if (await replace.isEnabled()) await replace.click();
    assert.equal(await editorText(page), 'puts "locked"');
  } finally { await page.evaluate(() => window.finishEditorSave()); }
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.equal(await code().isEditable(), true);
});

});
