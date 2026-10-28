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
  await code().press('Control+z'); assert.equal(await editorText(page), 'puts 1\nputs 2');
  await code().press('Control+Shift+Z'); assert.equal(await editorText(page), '  puts 1\n  puts 2');
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
    await code().focus();
    assert.equal(await code().evaluate(el => el === document.activeElement), true);
  } finally { await page.evaluate(() => window.finishEditorSave()); }
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.equal(await code().isEditable(), true);
  assert.equal(await code().evaluate(el => el === document.activeElement), true);
});

async function completions() {
  await page.locator('.cm-tooltip-autocomplete').waitFor();
  // CodeMirror ignores acceptance keys during its initial interaction delay.
  await page.waitForTimeout(100);
}
const option = label => page.getByRole('option').filter({ has: page.locator('.cm-completionLabel', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

test('E07: explicit completion navigates, cancels, inserts and preserves Tab and history', async () => {
  await code().fill('pu');
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.cm-tooltip-autocomplete').count(), 0);
  const file = path.join(root, 'completion.rb');
  await dialogs(app, () => page.locator('#save').click(), [save(file)]);
  assert.equal(await page.locator('.cm-tooltip-autocomplete').count(), 0);
  await code().press('Control+Space'); await completions();
  await option('puts').waitFor();
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  const selectedOption = page.locator('.cm-tooltip-autocomplete').getByRole('option', { selected: true });
  const selected = await selectedOption.textContent();
  await code().press('ArrowDown');
  assert.notEqual(await selectedOption.textContent(), selected);
  await code().press('ArrowUp');
  assert.equal(await selectedOption.textContent(), selected);
  await code().press('Escape');
  assert.equal(await page.locator('.cm-tooltip-autocomplete').count(), 0);
  assert.equal(await editorText(page), 'pu');
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  await page.keyboard.press('Tab');
  assert.equal(await editorText(page), 'pu  ');
  assert.equal(await code().evaluate(el => el.contains(document.activeElement)), true);
  await code().press('Control+z'); assert.equal(await editorText(page), 'pu');
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  await code().press('Control+Space'); await completions();
  await option('puts').click();
  assert.equal(await editorText(page), 'puts');
  assert.match(await page.locator('#save-state').textContent(), /未保存の変更/);
  await code().press('Control+z'); assert.equal(await editorText(page), 'pu');
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  await code().press('Control+Shift+Z'); assert.equal(await editorText(page), 'puts');
  await code().fill('whil'); await code().press('Control+Space'); await completions();
  await code().press('Enter'); assert.equal(await editorText(page), 'while');
  await code().fill('pu'); await code().press('Control+Space'); await completions();
  await code().press('Tab'); assert.equal(await editorText(page), 'pu  ');
  await code().fill('push'); await code().press('Home'); await code().press('ArrowRight'); await code().press('ArrowRight');
  await code().press('Control+Space'); await completions(); await option('puts').click();
  assert.equal(await editorText(page), 'puts');
  await code().fill('  pu'); await code().press('Control+Space'); await completions();
  await code().press('Escape'); await page.keyboard.press('Shift+Tab');
  assert.equal(await editorText(page), 'pu');
  assert.equal(await code().evaluate(el => el.contains(document.activeElement)), true);
  await code().press('Escape'); await page.keyboard.press('Tab');
  assert.equal(await code().evaluate(el => el.contains(document.activeElement)), false);
});

test('E08: templates keep indentation, receivers, normal Tab and save-run shortcuts', async () => {
  await code().fill('  if'); await code().press('End');
  await page.locator('#editor-complete').click(); await completions(); await option('if … end').click();
  assert.equal(await editorText(page), '  if condition\n    \n  end');
  await code().press('Control+z'); assert.equal(await editorText(page), '  if');
  await code().press('Control+Shift+Z'); assert.equal(await editorText(page), '  if condition\n    \n  end');
  await code().press('Control+z');
  await code().press('Control+Space'); await completions(); await option('if … end').click();
  await code().press('Tab'); assert.equal(await editorText(page), '    if condition\n    \n  end');
  await code().press('Shift+Tab'); assert.equal(await editorText(page), '  if condition\n    \n  end');
  await page.keyboard.insertText('true');
  assert.equal(await editorText(page), '  if true\n    \n  end');
  await code().press('Tab'); assert.equal(await editorText(page), '  if true  \n    \n  end');
  await code().fill('items.ea'); await code().press('Control+Space'); await completions(); await option('each do … end').click();
  assert.equal(await editorText(page), 'items.each do |item|\n  \nend');
  await page.keyboard.insertText('value'); assert.equal(await editorText(page), 'items.each do |value|\n  \nend');
  await code().fill('ea'); await code().press('Control+Space'); await completions(); await option('each do … end').click();
  assert.equal(await editorText(page), 'items.each do |item|\n  \nend');
  await page.keyboard.insertText('values'); assert.equal(await editorText(page), 'values.each do |item|\n  \nend');
  await code().fill('values = get'); await code().press('Control+Space'); await completions(); await option('gets.split.map(&:to_i)').click();
  assert.equal(await editorText(page), 'values = gets.split.map(&:to_i)');
  await code().press('End'); await code().press('Enter'); await page.keyboard.insertText('puts values.sum');
  await code().press('Enter');
  await page.locator('#stdin').fill('1 2 3');
  await page.locator('#compare-output').check(); await page.locator('#expected-output').fill('6\n');
  const file = path.join(root, 'snippet.rb');
  await dialogs(app, () => code().press('Control+s'), [save(file)]);
  await code().press('Control+Enter'); await page.locator('#comparison-status').filter({ hasText: '一致' }).waitFor();
  await code().press('Control+Space'); await completions();
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
  await code().press('Control+s'); await page.waitForFunction(() => !document.getElementById('save').disabled);
  await code().press('Control+Space'); await completions();
  await code().press('Control+Enter'); await page.waitForFunction(() => !document.getElementById('run').disabled);
  assert.equal(await readFile(file, 'utf8'), await editorText(page));
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
  await code().press('Control+Space'); await completions(); await option('puts').click();
  assert.equal(await page.locator('#comparison-status').textContent(), '未比較');
  assert.match(await page.locator('#save-state').textContent(), /未保存の変更/);
});

test('E09: completion is blocked during save and composition and resets with the document', async () => {
  await code().fill('previous_secret = 1\npre'); await code().press('Control+Space'); await completions();
  await option('previous_secret').waitFor();
  await page.evaluate(async () => {
    const { ide } = await import('./bridge.js');
    ide.saveFile = () => new Promise(resolve => { window.finishCompletionSave = () => resolve({ canceled: true }); });
  });
  await code().press('Control+s');
  try {
    assert.equal(await code().isEditable(), false);
    assert.equal(await page.locator('#editor-complete').isDisabled(), true);
    assert.equal(await page.locator('.cm-tooltip-autocomplete').count(), 0);
    await code().press('Control+Space');
    assert.equal(await page.locator('.cm-tooltip-autocomplete').count(), 0);
  } finally { await page.evaluate(() => window.finishCompletionSave()); }
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  await dialogs(app, () => page.locator('#new').click(), [discard(true)]);
  await code().fill('p'); await code().press('Control+Space'); await completions();
  assert.equal(await option('previous_secret').count(), 0);
  await code().press('Escape'); await code().fill('');
  await code().press('Control+Space'); await completions();
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
    assert.equal(await page.locator('.cm-tooltip-autocomplete').count(), 0);
    await code().press('Control+Space');
    assert.equal(await page.locator('.cm-tooltip-autocomplete').count(), 0);
    await cdp.send('Input.insertText', { text: '日本語' });
    assert.equal(await editorText(page), '日本語');
  } finally { await cdp.detach(); }
});

test('E10: completion fits a small viewport and works near the end of a large document', async () => {
  await page.setViewportSize({ width: 900, height: 650 });
  const file = path.join(root, 'completion-large.rb');
  await writeFile(file, '# long document\n'.repeat(50000) + 'total_count = 1\ntot');
  await dialogs(app, () => code().press('Control+o'), [open(file)]);
  await code().press('Control+End'); await code().press('Control+Space'); await completions();
  await option('total_count').waitFor();
  const bounds = await page.locator('.cm-tooltip-autocomplete').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 900 && bounds.y + bounds.height <= 650, JSON.stringify(bounds));
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/ruby-completion-900.png' });
  await option('total_count').click();
  assert.ok((await editorText(page)).endsWith('\ntotal_count'));
});

test('E15: literal method completion shows offline argument hints and preserves editing behavior', async () => {
  await code().fill('"abc".up');
  const file = path.join(root, 'method-hints.rb');
  await dialogs(app, () => code().press('Control+s'), [save(file)]);
  await code().press('Control+Space'); await completions();
  await option('upcase').waitFor();
  const info = page.locator('.cm-completionInfo');
  await info.filter({ hasText: 'String#upcase' }).waitFor();
  assert.match(await info.textContent(), /大文字/);
  assert.equal(await option('keys').count(), 0);
  assert.equal(await option('each do … end').count(), 0);
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  await code().press('Escape');
  assert.equal(await info.count(), 0);
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  await code().press('End'); await code().press('Control+Space'); await completions();
  await code().press('Enter');
  assert.equal(await editorText(page), '"abc".upcase');
  await code().press('Control+z'); assert.equal(await editorText(page), '"abc".up');
  await code().press('Control+Shift+Z'); assert.equal(await editorText(page), '"abc".upcase');
  for (const [doc, label, signature] of [['[].fe', 'fetch', 'Array#fetch(index'], ['{}.fe', 'fetch', 'Hash#fetch(key'], ['unknown.sp', 'split', 'String#split']]) {
    await code().fill(doc); await page.locator('#editor-complete').click(); await completions();
    await option(label).waitFor(); await info.filter({ hasText: signature }).waitFor();
    await option(label).click(); assert.equal(await editorText(page), doc.replace(/\w+$/, label));
  }
  await code().fill('puts("abc".upcase)');
  await code().press('Control+s'); await page.waitForFunction(() => !document.getElementById('save').disabled);
  await page.locator('#compare-output').check(); await page.locator('#expected-output').fill('ABC\n');
  await code().press('Control+Enter'); await page.locator('#comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  await code().press('End'); await code().press('ArrowLeft'); await code().press('Control+Space'); await completions();
  await info.filter({ hasText: 'String#upcase' }).waitFor();
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  await code().press('Escape');
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
  assert.equal(await editorText(page), 'puts("abc".upcase)');
  await page.setViewportSize({ width: 900, height: 650 });
  await code().fill('{}.fe'); await code().press('Control+Space'); await completions();
  await info.filter({ hasText: 'Hash#fetch' }).waitFor();
  for (const selector of ['.cm-tooltip-autocomplete', '.cm-completionInfo']) {
    const bounds = await page.locator(selector).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 901 && bounds.y + bounds.height <= 651, JSON.stringify(bounds));
  }
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/ruby-method-hints-900.png' });
});

test('E11: runtime and syntax errors navigate without changing code, saved state or history', async () => {
  assert.equal(await page.locator('#error-location').count(), 1);
  const file = path.join(root, 'error 日本語.rb');
  const text = '# 日本語\n' + '# padding\n'.repeat(80) + "raise 'boom'\n";
  await writeFile(file, text);
  await dialogs(app, () => code().press('Control+o'), [open(file)]);
  await page.locator('#run').click(); await page.waitForFunction(() => !document.getElementById('run').disabled);
  const jump = page.getByRole('button', { name: 'コードの82行目へ', exact: true });
  await jump.waitFor();
  await page.setViewportSize({ width: 900, height: 650 });
  await jump.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#cursor-position').textContent(), 'Ln 82, Col 1');
  assert.equal(await code().evaluate(el => el === document.activeElement), true);
  assert.equal(await editorText(page), text);
  assert.equal(await page.locator('#save-state').textContent(), '保存済み');
  const marked = page.locator('.cm-run-error-line');
  await marked.waitFor();
  assert.equal(await marked.textContent(), "raise 'boom'");
  const rect = await marked.boundingBox();
  const editorRect = await page.locator('.cm-scroller').boundingBox();
  assert.ok(rect.y >= editorRect.y && rect.y + rect.height <= editorRect.y + editorRect.height);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/run-error-900.png' });
  await code().press('Control+s'); await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.equal(await jump.isVisible(), true);
  await page.evaluate(async () => {
    const { ide } = await import('./bridge.js');
    const save = ide.saveFile;
    ide.saveFile = () => new Promise(resolve => { window.finishErrorSave = () => { ide.saveFile = save; resolve({ canceled: true }); }; });
  });
  await code().press('Control+s');
  try {
    assert.equal(await jump.isDisabled(), true);
    assert.equal(await marked.count(), 1);
  } finally { await page.evaluate(() => window.finishErrorSave()); }
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  assert.equal(await jump.isEnabled(), true);
  await code().press('Control+z'); assert.equal(await editorText(page), text);
  await code().press('Home'); await page.keyboard.insertText('# changed\n');
  assert.equal(await page.locator('#error-location').isVisible(), false);
  assert.equal(await marked.count(), 0);
  await code().press('Control+z'); assert.equal(await editorText(page), text);
  assert.equal(await page.locator('#error-location').isVisible(), false);
  await code().fill('# 日本語\nif true\n');
  await page.locator('#run').click(); await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.getByRole('button', { name: 'コードの2行目へ', exact: true }).click();
  assert.equal(await page.locator('#cursor-position').textContent(), 'Ln 2, Col 1');
  await page.locator('#clear-output').click();
  assert.equal(await page.locator('#error-location').isVisible(), false);
  assert.equal(await marked.count(), 0);
});

test('E12: each case keeps its error location and input edits invalidate only the affected case', async () => {
  await code().fill("n = gets.to_i\nif n == 1\n  raise 'one'\nelse\n  raise 'two'\nend\n");
  await page.locator('#stdin').fill('1');
  await page.locator('#case-add').click(); await page.locator('#stdin').fill('2');
  await page.locator('#compare-output').uncheck();
  await page.locator('#run-all').click(); await page.waitForFunction(() => !document.getElementById('run-all').disabled);
  await page.getByRole('button', { name: 'コードの5行目へ', exact: true }).click();
  await page.locator('#case-select').selectOption('0');
  await page.getByRole('button', { name: 'コードの3行目へ', exact: true }).click();
  assert.equal(await page.locator('#cursor-position').textContent(), 'Ln 3, Col 1');
  await page.locator('#stdin').fill('edited');
  assert.equal(await page.locator('#error-location').isVisible(), false);
  assert.equal(await page.locator('.cm-run-error-line').count(), 0);
  await page.locator('#case-select').selectOption('1');
  await page.getByRole('button', { name: 'コードの5行目へ', exact: true }).waitFor();
  await code().press('Control+Home'); await page.keyboard.insertText('# edited\n');
  for (const index of ['0', '1']) {
    await page.locator('#case-select').selectOption(index);
    assert.equal(await page.locator('#error-location').isVisible(), false);
  }
});

test('E13: library callers navigate, warnings and unrelated backtraces do not, and document changes clear marks', async () => {
  await code().fill("require 'json'\nJSON.parse('{')\n");
  await page.locator('#run').click(); await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.getByRole('button', { name: 'コードの2行目へ', exact: true }).click();
  assert.equal(await page.locator('#cursor-position').textContent(), 'Ln 2, Col 1');
  const file = path.join(root, 'different.rb'); await writeFile(file, 'puts 42');
  await dialogs(app, () => code().press('Control+o'), [discard(true), open(file)]);
  assert.equal(await page.locator('#error-location').isVisible(), false);
  assert.equal(await page.locator('.cm-run-error-line').count(), 0);
  for (const text of ["warn \"#{__FILE__}:1: warning\"", "e = RuntimeError.new('boom'); e.set_backtrace(['/other/solution.rb:1:in main']); raise e"]) {
    await code().fill(text);
    await page.locator('#run').click(); await page.waitForFunction(() => !document.getElementById('run').disabled);
    assert.notEqual(await page.locator('#stderr').textContent(), '');
    assert.equal(await page.locator('#error-location').isVisible(), false);
  }
});

test('E14: editing during a batch run prevents late errors from restoring old locations', async () => {
  await code().fill("puts 'started'\nsleep 0.4\nraise 'late'\n");
  await page.locator('#case-add').click();
  await page.locator('#case-select').selectOption('0');
  await page.locator('#run-all').click(); await page.locator('#stdout').filter({ hasText: 'started' }).waitFor();
  await code().press('Control+Home'); await page.keyboard.insertText('# edited\n');
  await page.waitForFunction(() => !document.getElementById('run-all').disabled);
  for (const index of ['0', '1']) {
    await page.locator('#case-select').selectOption(index);
    assert.match(await page.locator('#stderr').textContent(), /late/);
    assert.equal(await page.locator('#error-location').isVisible(), false);
    assert.equal(await page.locator('.cm-run-error-line').count(), 0);
  }
});

});
