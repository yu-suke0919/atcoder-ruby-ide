const assert = require('node:assert/strict');
const { editorText } = require('./editor.cjs');

async function verifyLsp(page) {
  const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
  const first = await invoke('lsp_start');
  assert.equal(first.position_encoding, 'utf-16');
  assert.equal((await invoke('lsp_start')).pid, first.pid);
  try {
    for (const [name, method] of [['IdeFirst', 'first_ide_method'], ['IdeChanged', 'changed_ide_method']]) {
      const line = `"😀日本語"; ${name}.new.${method.slice(0, -6)}`;
      const result = await invoke('lsp_complete', { code: `limit = 10\nclass ${name}; def ${method}; end; end\n${line}`, line: 2, character: line.length });
      const items = Array.isArray(result) ? result : result.items;
      assert.ok(items.some(item => item.label.startsWith(method)), JSON.stringify(result));
    }
  } finally { assert.equal(await invoke('lsp_stop'), true); }
  assert.equal(await invoke('lsp_stop'), false);
  await assert.rejects(invoke('lsp_complete', { code: 'puts', line: 0, character: 4 }), /起動していません/);
  await invoke('lsp_start');
  assert.equal(await invoke('lsp_stop'), true);
  const editor = page.getByTestId('code-editor');
  const original = await editorText(page);
  const snapshot = 'limit = 10\nclass InstallProbe; def unique_install_method; end; end\n"😀日本語"; InstallProbe.new.unique_install_';
  try {
    await editor.fill(snapshot); await editor.press('Control+End'); await editor.press('Control+Space');
    const option = page.getByRole('option').filter({ has: page.locator('.cm-completionLabel', { hasText: /^unique_install_method$/ }) });
    await option.waitFor();
    assert.match(await option.textContent(), /LSP/);
    await page.waitForTimeout(100);
    await option.click();
    assert.equal(await editorText(page), snapshot.replace(/unique_install_$/, 'unique_install_method'));
    await editor.press('Control+z'); assert.equal(await editorText(page), snapshot);
  } finally { await editor.fill(original); }
}
module.exports = { verifyLsp };
