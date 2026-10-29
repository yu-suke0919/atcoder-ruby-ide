const assert = require('node:assert/strict');

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
}
module.exports = { verifyLsp };
