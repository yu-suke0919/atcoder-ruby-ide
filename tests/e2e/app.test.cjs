const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { launch, dialogs, discard, open, save, cancelSave, overwrite, close, requestClose, pause } = require('./support.cjs');

let app;
let page;
let root;
const libraryContest = `ide-e2e-${Date.now()}`;
before(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'AtCoder IDE 日本語 ')));
  app = await launch(root);
  page = app.page;
});
async function resetWorkspace() {
  if (await page.locator('#stop').isEnabled()) {
    await page.locator('#stop').click();
    await page.waitForFunction(() => document.getElementById('stop').disabled);
  }
  if (app.steps) app.steps.length = 0;
  const acceptReload = dialog => dialog.accept();
  page.on('dialog', acceptReload);
  try { await page.reload(); }
  finally { page.off('dialog', acceptReload); }
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.waitForFunction(() => !document.getElementById('run').disabled);
}
beforeEach(resetWorkspace);

after(async () => {
  if (app) await close(app);
  if (app) for (const kind of ['library/problems', 'workspaces']) await rm(path.join(app.dataDir, kind, libraryContest), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  if (app) {
    await rm(path.join(app.dataDir, 'library/collections', libraryContest), { recursive: true, force: true });
    await rm(path.join(app.dataDir, 'library/collections', `${libraryContest}.json`), { force: true });
  }
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function fileOperation(trigger, steps) {
  await dialogs(app, trigger, steps);
}
async function openDocument(file) {
  const dirty = await page.evaluate(() => document.getElementById('save-state').textContent.includes('変更'));
  await fileOperation(() => page.getByRole('button', { name: '開く', exact: true }).click(), [...(dirty ? [discard(true)] : []), open(file)]);
  assert.equal(await page.locator('#file-path').textContent(), file);
}
async function saveAs(file, exists = false) {
  await fileOperation(() => page.getByRole('button', { name: '名前を付けて保存', exact: true }).click(), [save(file), ...(exists ? [overwrite()] : [])]);
  await page.locator('#message').filter({ hasText: 'ファイルを保存しました' }).waitFor();
  assert.equal(await page.locator('#file-path').textContent(), file);
}
async function newDocument() {
  const dirty = await page.evaluate(() => document.getElementById('save-state').textContent.includes('変更'));
  if (dirty) await fileOperation(() => page.getByRole('button', { name: '新規', exact: true }).click(), [discard(true)]);
  else await page.getByRole('button', { name: '新規', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('code-editor').value === '');
}
async function runAndWait(label = '正常終了') {
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: label }).waitFor();
}

async function assertWorkspaceFits() {
  const layout = await page.evaluate(() => ({
    outputBottom: document.querySelector('.output-panel').getBoundingClientRect().bottom,
    toolbarTop: document.querySelector('.run-toolbar').getBoundingClientRect().top,
    summaryBottom: document.querySelector('.run-summary').getBoundingClientRect().bottom,
    stdoutHeight: document.querySelector('#stdout').getBoundingClientRect().height,
    stderrHeight: document.querySelector('#stderr').getBoundingClientRect().height,
    inputHeight: document.querySelector('#stdin').getBoundingClientRect().height,
    expectedHeight: document.querySelector('#expected-output').getBoundingClientRect().height,
    comparisonBottom: document.querySelector('#comparison-status').getBoundingClientRect().bottom,
    textAreas: ['stdin', 'expected-output', 'stdout', 'stderr'].map((id) => {
      const element = document.getElementById(id);
      const style = getComputedStyle(element);
      return { id, contentHeight: element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom), lineHeight: parseFloat(style.lineHeight) };
    }),
    viewportHeight: innerHeight
  }));
  const details = JSON.stringify(layout);
  assert.ok(layout.outputBottom <= layout.toolbarTop, `output must not overlap run controls: ${details}`);
  assert.ok(layout.summaryBottom <= layout.outputBottom, `run summary must remain visible: ${details}`);
  assert.ok(layout.stdoutHeight > 12 && layout.stderrHeight > 12 && layout.inputHeight > 12 && layout.expectedHeight > 12, `text areas must remain usable: ${details}`);
  assert.ok(layout.comparisonBottom <= layout.outputBottom, `comparison must remain visible: ${details}`);
  for (const area of layout.textAreas) {
    assert.ok(area.contentHeight >= area.lineHeight, `at least one complete line must fit in ${area.id}: ${details}`);
  }
}

async function confirmReload(accept) {
  const prompt = page.waitForEvent('dialog');
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  const dialog = await prompt;
  assert.equal(dialog.type(), 'beforeunload');
  if (accept) {
    const navigation = page.waitForEvent('load');
    await dialog.accept();
    await navigation;
    await page.waitForFunction(() => !document.getElementById('run').disabled);
  } else {
    await dialog.dismiss();
  }
}

test('R07: reloading a saved source makes Save choose a new path', async () => {
  const original = path.join(root, 'reload-original.rb');
  await writeFile(original, 'puts "original"');
  await openDocument(original);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  assert.equal(await page.locator('#file-path').textContent(), '無題.rb');
  await page.locator('#code-editor').fill('puts File.exist?("reload-original.rb")');
  await runAndWait();
  assert.equal(await page.locator('#stdout').textContent(), 'false\n');
  // Model a pre-reload file operation completing late, after initialization.
  await fileOperation(() => page.evaluate(() => window.__TAURI__.core.invoke('document_open')), [open(original)]);
  await fileOperation(() => page.locator('#save').click(), [cancelSave()]);
  assert.equal(await readFile(original, 'utf8'), 'puts "original"');
  const saved = path.join(root, 'reload-new.rb');
  await fileOperation(() => page.locator('#save').click(), [save(saved)]);
  assert.equal(await readFile(saved, 'utf8'), await page.locator('#code-editor').inputValue());
  assert.equal(await readFile(original, 'utf8'), 'puts "original"');
});

test('R07: reload protects source edits and accepted reload starts clean', async () => {
  await page.locator('#code-editor').click();
  await page.locator('#code-editor').fill('puts "unsaved source"');
  await confirmReload(false);
  assert.equal(await page.locator('#code-editor').inputValue(), 'puts "unsaved source"');
  await confirmReload(true);
  await runAndWait();
  assert.equal(await page.locator('#stdout').textContent(), '6 test\n');
});

test('R07: reload protects case-only edits', async () => {
  await page.locator('#stdin').click();
  await page.locator('#stdin').fill('unsaved case');
  await confirmReload(false);
  assert.equal(await page.locator('#stdin').inputValue(), 'unsaved case');
  assert.equal(await page.locator('#code-editor').inputValue().then(code => code.includes('gets.to_i')), true);
});

test('R07: accepting reload stops an active run before enabling a new run', async () => {
  await page.locator('#code-editor').fill('puts "ready"; loop { puts "streaming"; sleep 0.01 }');
  await saveAs(path.join(root, 'reload-running.rb'));
  await page.locator('#run').click();
  await page.locator('#stdout').filter({ hasText: 'ready' }).waitFor();
  await confirmReload(true);
  assert.equal(await page.locator('#file-path').textContent(), '無題.rb');
  await runAndWait();
  assert.equal(await page.locator('#stdout').textContent(), '6 test\n');
});

test('R08: editing one case field preserves raw newlines in the other fields', async () => {
  await page.locator('#code-editor').fill("puts STDIN.read.bytes.join(',')");
  for (const [name, newline] of [['crlf', '\r\n'], ['cr', '\r']]) {
    const input = `A${newline}B${newline}`;
    const bytes = [...Buffer.from(input)].join(',');
    const expected = bytes + newline;
    const source = path.join(root, `raw-${name}.json`);
    await writeFile(source, JSON.stringify({ cases: [{ stdin: input, expectedOutput: expected, compare: true }] }));
    for (const field of ['expected-output', 'stdin', 'compare-output']) {
      await loadCases(source);
      if (field === 'compare-output') {
        await page.locator('#compare-output').uncheck();
        await page.locator('#compare-output').check();
        assert.equal(await casesDirty(), false);
      } else {
        await page.locator(`#${field}`).fill('edited');
      }
      if (field !== 'stdin') {
        await runAndWait();
        assert.equal(await page.locator('#stdout').textContent(), bytes + '\n');
      }
      const saved = path.join(root, `raw-${name}-${field}.json`);
      await saveCases(saved);
      const [item] = JSON.parse(await readFile(saved, 'utf8')).cases;
      assert.equal(item.stdin, field === 'stdin' ? 'edited' : input);
      assert.equal(item.expectedOutput, field === 'expected-output' ? 'edited' : expected);
      assert.equal(item.compare, true);
    }
  }
});

test('M12: Ruby detection can fail and recover without losing edits', async () => {
  await page.getByTestId('code-editor').fill('puts "recovered"');
  await page.getByTestId('stdin').fill('keep input');
  await page.evaluate(async () => {
    const { ide } = await import('./bridge.js');
    const original = ide.rubyInfo;
    let attempt = 0;
    ide.rubyInfo = () => {
      attempt++;
      if (attempt === 1) return new Promise((resolve, reject) => { window.rejectRubyProbe = () => reject(new Error('Ruby probe failed')); });
      if (attempt === 2) return Promise.resolve({ available: false, version: 'Ruby unavailable' });
      return original();
    };
  });
  const retry = page.getByRole('button', { name: 'Ruby を再確認', exact: true });
  await retry.click({ timeout: 2000 });
  assert.equal(await retry.isDisabled(), true);
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.locator('#code-editor').isEditable(), true);
  await page.evaluate(() => window.rejectRubyProbe());
  await page.locator('#message').filter({ hasText: 'Ruby probe failed' }).waitFor();
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.locator('#save').isEnabled(), true);
  await retry.click();
  await page.locator('#ruby-version').filter({ hasText: 'Ruby unavailable' }).waitFor();
  assert.equal(await page.locator('#run').isDisabled(), true);
  await retry.click();
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "recovered"');
  assert.equal(await page.getByTestId('stdin').inputValue(), 'keep input');
  await runAndWait();
  assert.equal(await page.getByTestId('stdout').textContent(), 'recovered\n');
});

test('M01: editor, output and run controls fit the minimum window size', async () => {
  await page.setViewportSize({ width: 900, height: 650 });
  await assertWorkspaceFits();
  await page.setViewportSize({ width: 1280, height: 850 });
});

test('R03: larger font line boxes do not push output into run controls', async () => {
  await page.setViewportSize({ width: 900, height: 650 });
  try {
    await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
    await page.evaluate(() => { document.body.style.lineHeight = '1.8'; });
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).lineHeight), '23.4px');
    await assertWorkspaceFits();
  } finally {
    await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
    await page.evaluate(() => { document.body.style.lineHeight = ''; });
    await page.setViewportSize({ width: 1280, height: 850 });
  }
});

test('M04: the initial AtCoder sample produces 6 test', async () => {
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('stdout').textContent(), '6 test\n');
  assert.equal(await page.getByTestId('comparison-status').textContent(), '比較なし');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/workspace.png' });
});

test('M11: compare stdout with expected output and keep stderr separate', async () => {
  const toggle = page.getByRole('checkbox', { name: '期待出力と比較' });
  assert.equal(await toggle.count(), 1);
  assert.equal(await page.getByTestId('expected-output').inputValue(), '6 test\n');
  await toggle.check();
  await page.getByTestId('code-editor').fill('puts STDIN.read.upcase; warn "標準エラー"');
  await page.getByTestId('stdin').fill('日本語\nhello\n');
  await page.getByTestId('expected-output').fill('日本語\nHELLO');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  assert.equal(await page.getByTestId('stdout').textContent(), '日本語\nHELLO\n');
  assert.equal(await page.getByTestId('stderr').textContent(), '標準エラー\n');
  await page.screenshot({ path: 'test-results/expected-output.png' });
  await page.getByTestId('expected-output').fill('wrong');
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('comparison-status').filter({ hasText: /^不一致$/ }).waitFor();
  assert.equal(await page.getByTestId('run-status').textContent(), '正常終了');
  await toggle.uncheck();
});

test('M11: distinguish an empty expectation from disabled comparison', async () => {
  const toggle = page.getByRole('checkbox', { name: '期待出力と比較' });
  await toggle.check();
  await page.getByTestId('expected-output').fill('');
  await page.getByTestId('code-editor').fill('# no output');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  await page.getByTestId('code-editor').fill('puts "unexpected"');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('comparison-status').filter({ hasText: /^不一致$/ }).waitFor();
  await toggle.uncheck();
  assert.equal(await page.getByTestId('expected-output').isDisabled(), true);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '比較なし');
});

test('M11: edits and clearing results reset the comparison', async () => {
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  for (const field of ['code-editor', 'stdin', 'expected-output']) {
    await page.getByTestId('code-editor').fill('print STDIN.read');
    await page.getByTestId('stdin').fill('one');
    await page.getByTestId('expected-output').fill('one');
    await page.getByRole('button', { name: '実行', exact: true }).click();
    await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
    await page.getByTestId(field).fill('changed');
    assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  }
  await page.getByTestId('expected-output').fill('one');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  await page.getByRole('button', { name: 'クリア', exact: true }).click();
  assert.equal(await page.getByTestId('stdout').textContent(), '');
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});

test('M11: do not show a stale comparison when expectations change during a run', async () => {
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('code-editor').fill('puts "ready"; sleep 0.5');
  await page.getByTestId('expected-output').fill('old expectation');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '比較中…');
  await page.getByTestId('expected-output').fill('changed');
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});

test('M11: matching stdout from a failed process is not a passing comparison', async () => {
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('code-editor').fill('print "same"; exit 1');
  await page.getByTestId('expected-output').fill('same');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: 'エラー終了' }).waitFor();
  assert.equal(await page.getByTestId('stdout').textContent(), 'same');
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});

test('M11: reject invalid or oversized UTF-8 expectations before running Ruby', async () => {
  for (const expected of [123, 'あ'.repeat(349526)]) {
    const error = await page.evaluate(async (value) => {
      try { const { ide } = await import('./bridge.js'); await ide.run('puts "must not run"', '', value); }
      catch (error) { return error.message; }
    }, expected);
    assert.match(error, /期待出力/);
  }
  await page.getByTestId('code-editor').fill('puts 42');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('stdout').textContent(), '42\n');
});

test('M01/M04/M05: edit code and stdin, then show stdout and stderr', async () => {
  await page.getByTestId('code-editor').fill('puts STDIN.read.upcase; warn "エラー欄"');
  await page.getByTestId('stdin').fill('hello\n');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('stdout').textContent(), 'HELLO\n');
  assert.equal(await page.getByTestId('stderr').textContent(), 'エラー欄\n');
});

test('M05: syntax errors are visible and a later run succeeds', async () => {
  await page.getByTestId('code-editor').fill('puts(');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: 'エラー終了' }).waitFor();
  assert.match(await page.getByTestId('stderr').textContent(), /syntax|unexpected/i);
  await page.getByTestId('code-editor').fill('puts 42');
  await page.keyboard.press('Control+Enter');
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('stdout').textContent(), '42\n');
});

test('M06: stop a running program from the UI', async () => {
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('ready');
  await page.getByTestId('code-editor').fill('$stdout.sync = true; puts "ready"; loop { sleep 0.01 }');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '実行', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '停止しました' }).waitFor();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '実行', exact: true }).isEnabled(), true);
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});

test('M01: Tab inserts two spaces and output is rendered as text', async () => {
  await page.getByTestId('code-editor').fill('puts "<img src=x onerror=alert(1)>"');
  await page.getByTestId('code-editor').press('End');
  await page.getByTestId('code-editor').press('Tab');
  assert.match(await page.getByTestId('code-editor').inputValue(), /  $/);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('stdout').locator('img').count(), 0);
  assert.match(await page.getByTestId('stdout').textContent(), /<img/);
});

test('M06/M08: show timeout and output-limit reasons in the UI', async () => {
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('');
  await page.getByTestId('code-editor').fill('loop {}');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '時間制限で停止' }).waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  await page.getByTestId('code-editor').fill('loop { puts "x" * 8192 }');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('stop').disabled);
  assert.match(await page.getByTestId('run-status').textContent(), /出力上限で停止/);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  assert.ok(Buffer.byteLength(await page.getByTestId('stdout').textContent()) <= 1048576);
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});


test('M02/M03/M09: open/save preserve Japanese paths and canceled edits', async () => {
  const file = path.join(root, '解答.rb');
  await writeFile(file, '\uFEFFputs "ファイル"\n', 'utf8');
  await openDocument(file);
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "ファイル"\n');
  await page.getByTestId('code-editor').fill('puts "変更済み"\n');
  await fileOperation(() => page.getByRole('button', { name: '開く', exact: true }).click(), [discard(false)]);
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "変更済み"\n');
  await page.keyboard.press('Control+s');
  await page.getByTestId('save-state').filter({ hasText: '保存済み' }).waitFor();
  assert.equal(await readFile(file, 'utf8'), 'puts "変更済み"\n');
  await page.getByTestId('code-editor').fill('puts "未保存"');
  await fileOperation(() => page.keyboard.press('Control+Shift+s'), [cancelSave()]);
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "未保存"');
  assert.match(await page.getByTestId('save-state').textContent(), /未保存/);
  assert.equal(await readFile(file, 'utf8'), 'puts "変更済み"\n');
});

test('M08: opening an oversized source preserves the current code, path and comparison', async () => {
  await page.getByTestId('code-editor').fill('puts "keep"');
  await saveAs(path.join(root, '保持するソース.rb'));
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('keep');
  await runAndWait();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  const currentPath = await page.locator('#file-path').textContent();
  const large = path.join(root, 'large.rb');
  await writeFile(large, 'a'.repeat(1048577));
  await fileOperation(() => page.locator('#open').click(), [open(large)]);
  await page.locator('#message').filter({ hasText: '1 MiB' }).waitFor();
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "keep"');
  assert.equal(await page.locator('#file-path').textContent(), currentPath);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '一致');
  await runAndWait();
  assert.equal(await page.getByTestId('stdout').textContent(), 'keep\n');
});

test('M09: cancel close/new confirmation, then create and save a document', async () => {
  await page.getByTestId('code-editor').fill('puts "保持"');
  await fileOperation(() => page.getByRole('button', { name: '新規', exact: true }).click(), [discard(false)]);
  await fileOperation(() => requestClose(app), [discard(false)]);
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "保持"');
  await newDocument();
  await page.getByTestId('code-editor').fill('puts "新規保存"');
  const file = path.join(root, '新しい解答.rb');
  await fileOperation(() => page.getByRole('button', { name: '保存', exact: true }).click(), [save(file)]);
  assert.equal(await page.locator('#file-path').textContent(), file);
  assert.equal(await readFile(file, 'utf8'), 'puts "新規保存"');
});

test('R01: a CRLF document opens clean and remains unchanged on disk', async () => {
  const file = path.join(root, 'Windows 改行.rb');
  await writeFile(file, 'puts 1\r\nputs 2\r\n', 'utf8');
  await openDocument(file);
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts 1\nputs 2\n');
  assert.equal(await page.getByTestId('save-state').textContent(), '保存済み');
  assert.equal(await readFile(file, 'utf8'), 'puts 1\r\nputs 2\r\n');
});

test('M11: open/new reset the previous comparison', async () => {
  await page.getByTestId('code-editor').fill('puts 1; puts 2');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('1\n2\n');
  await runAndWait();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  const file = path.join(root, '別の解答.rb');
  await writeFile(file, 'puts 1\nputs 2\n');
  await openDocument(file);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  await runAndWait();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  await newDocument();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});

test('R06: overwrite and same-path Save As preserve comparison results', async () => {
  const file = path.join(root, '上書き保存.rb');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('code-editor').fill('puts "same"');
  await saveAs(file);
  for (const [expected, label] of [['same', '一致'], ['different', '不一致']]) {
    await page.getByTestId('expected-output').fill(expected);
    await runAndWait();
    await page.getByTestId('comparison-status').filter({ hasText: new RegExp(`^${label}$`) }).waitFor();
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    assert.equal(await readFile(file, 'utf8'), 'puts "same"');
    assert.equal(await page.getByTestId('comparison-status').textContent(), label);
  }
  await saveAs(file, true);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '不一致');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});

test('R06: initial/path-changing saves reset comparisons; cancel and write failure preserve them', async () => {
  await newDocument();
  await page.getByTestId('code-editor').fill('puts "same"');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('same');
  await runAndWait();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  const directory = path.join(root, '削除されるディレクトリ');
  await mkdir(directory);
  const first = path.join(directory, '初回保存.rb');
  await fileOperation(() => page.keyboard.press('Control+s'), [save(first)]);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  await runAndWait();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  await fileOperation(() => page.getByRole('button', { name: '名前を付けて保存', exact: true }).click(), [cancelSave()]);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '一致');
  await rm(directory, { recursive: true });
  await page.keyboard.press('Control+s');
  await page.locator('#message').filter({ hasText: 'ファイル操作に失敗しました' }).waitFor();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '一致');
  assert.equal(await page.locator('#file-path').textContent(), first);
  const second = path.join(root, '別名保存.rb');
  await saveAs(second);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  assert.equal(await readFile(second, 'utf8'), 'puts "same"');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});

test('R06: overwrite during execution preserves the eventual comparison', async () => {
  const file = path.join(root, '実行中の保存.rb');
  const gate = path.join(root, 'continue.txt');
  await page.getByTestId('code-editor').fill(`puts "ready"; sleep 0.01 until File.exist?(${JSON.stringify(gate.replaceAll('\\', '/'))})`);
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('ready');
  await saveAs(file);
  try {
    await page.getByRole('button', { name: '実行', exact: true }).click();
    await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    assert.equal(await page.getByTestId('comparison-status').textContent(), '比較中…');
    await writeFile(gate, 'continue');
    await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  } finally {
    await writeFile(gate, 'continue');
    await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
  }
});

test('M07/M12: JSON and saved-directory files work with the configured Ruby runtime', async () => {
  await saveAs(path.join(root, 'JSON 解答.rb'));
  await writeFile(path.join(root, '入力.json'), '{"message":"日本語"}', 'utf8');
  await page.getByTestId('code-editor').fill('require "json"; puts JSON.parse(File.read("入力.json"))["message"]');
  await runAndWait();
  assert.equal(await page.getByTestId('stdout').textContent(), '日本語\n');
});

async function selectCase(number) {
  await page.getByLabel('サンプルケース', { exact: true }).selectOption(String(number - 1));
}
async function resetCases() {
  while (await page.getByLabel('サンプルケース', { exact: true }).locator('option').count() > 1) {
    await page.getByRole('button', { name: 'ケース削除', exact: true }).click();
  }
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
}
async function addCase(stdin, expected = stdin) {
  await page.getByRole('button', { name: 'ケース追加', exact: true }).click();
  await page.getByTestId('stdin').fill(stdin);
  await page.getByTestId('expected-output').fill(expected);
}

test('M13: cases keep independent inputs, expectations and results', async () => {
  assert.equal(await page.getByRole('button', { name: 'ケース削除', exact: true }).isDisabled(), true);
  await page.getByTestId('code-editor').fill('puts STDIN.read.upcase');
  await page.getByTestId('stdin').fill('one');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('ONE');
  await runAndWait();
  await addCase('two', 'TWO');
  await runAndWait();
  await selectCase(1);
  assert.equal(await page.getByTestId('stdin').inputValue(), 'one');
  assert.equal(await page.getByTestId('stdout').textContent(), 'ONE\n');
  assert.equal(await page.getByTestId('comparison-status').textContent(), '一致');
  await page.getByTestId('expected-output').fill('changed');
  await selectCase(2);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '一致');
  assert.equal(await page.getByTestId('stdout').textContent(), 'TWO\n');
  await resetCases();
});

test('M13: all cases run sequentially and continue after an error', async () => {
  await page.getByTestId('code-editor').fill('s = STDIN.read; puts s; warn "bad" if s == "error"; exit 1 if s == "error"');
  await page.getByTestId('stdin').fill('error');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('error');
  await addCase('two', 'different');
  await addCase('three');
  await page.getByRole('button', { name: '全件実行', exact: true }).click();
  await page.getByTestId('cases-summary').filter({ hasText: '完了 3 / 3' }).waitFor();
  assert.match(await page.getByTestId('cases-summary').textContent(), /一致 1.*不一致 1.*エラー 1/);
  await selectCase(1);
  assert.match(await page.getByTestId('run-status').textContent(), /エラー終了/);
  assert.equal(await page.getByTestId('stderr').textContent(), 'bad\n');
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  await selectCase(2);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '不一致');
  await selectCase(3);
  assert.equal(await page.getByTestId('stdout').textContent(), 'three\n');
  await resetCases();
});

test('M13: a timeout does not prevent the next case from running', async () => {
  await page.getByTestId('code-editor').fill('s = STDIN.read; sleep 30 if s == "timeout"; puts s');
  await page.getByTestId('stdin').fill('timeout');
  await addCase('after');
  await page.getByRole('button', { name: '全件実行', exact: true }).click();
  await page.getByTestId('cases-summary').filter({ hasText: '完了 2 / 2' }).waitFor({ timeout: 12000 });
  await selectCase(1);
  assert.match(await page.getByTestId('run-status').textContent(), /時間制限/);
  await selectCase(2);
  assert.equal(await page.getByTestId('stdout').textContent(), 'after\n');
  await resetCases();
});

test('M13: a batch uses starting code and inputs without restoring stale comparisons', async () => {
  const gate = path.join(root, 'batch-gate.txt');
  await page.getByTestId('code-editor').fill(`puts "ready"; sleep 0.01 until File.exist?(${JSON.stringify(gate.replaceAll('\\', '/'))}); puts STDIN.read.upcase`);
  await page.getByTestId('stdin').fill('one');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('wrong first');
  await addCase('two', 'wrong second');
  await selectCase(1);
  try {
    await page.getByRole('button', { name: '全件実行', exact: true }).click();
    await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'ケース追加', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '開く', exact: true }).isDisabled(), true);
    await selectCase(2);
    await page.getByTestId('stdin').fill('edited');
    await page.getByTestId('code-editor').fill('puts "changed code"');
    await writeFile(gate, 'go');
    await page.getByTestId('cases-summary').filter({ hasText: '完了 2 / 2' }).waitFor();
    assert.equal(await page.getByTestId('stdout').textContent(), 'ready\nTWO\n');
    assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
    assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
    await selectCase(1);
    assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
    assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  } finally { await writeFile(gate, 'go'); }
  await resetCases();
});

test('M13: stopping a batch skips remaining cases and allows another run', async () => {
  const marker = path.join(root, 'batch-should-not-run.txt');
  await page.getByTestId('code-editor').fill(`s = STDIN.read; puts "ready"; sleep 30 if s == "wait"; File.write(${JSON.stringify(marker.replaceAll('\\', '/'))}, s)`);
  await page.getByTestId('stdin').fill('wait');
  await addCase('next', 'ready');
  await selectCase(1);
  await page.getByRole('button', { name: '全件実行', exact: true }).click();
  await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('button', { name: '全件実行', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('run-all').disabled);
  await assert.rejects(access(marker), { code: 'ENOENT' });
  await selectCase(2);
  assert.match(await page.getByTestId('run-status').textContent(), /中止/);
  await runAndWait();
  assert.equal(await readFile(marker, 'utf8'), 'next');
  await resetCases();
});

const casesDirty = async () => (await page.locator('#case-count').textContent()).includes('未保存');
async function saveCases(file) {
  await fileOperation(() => page.getByRole('button', { name: 'ケース保存', exact: true }).click(), [{ title: 'サンプルを保存', path: file, buttonId: '1' }]);
}
async function loadCases(file) {
  await fileOperation(() => page.getByRole('button', { name: 'ケース読込', exact: true }).click(), [...(await casesDirty() ? [discard(true)] : []), { title: 'サンプルを開く', path: file, buttonId: '1' }]);
}

test('M14: JSON roundtrip preserves case data and leaves the source and cwd unchanged', async () => {
  await page.getByTestId('code-editor').fill('puts STDIN.read');
  await saveAs(path.join(root, 'ケース往復.rb'));
  await page.getByTestId('stdin').fill('日本語\n');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('');
  await addCase('two', 'ignored');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
  const source = await page.getByTestId('code-editor').inputValue();
  const sourcePath = await page.locator('#file-path').textContent();
  const file = path.join(root, 'サンプル 空白.json');
  await saveCases(file);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(data, { cases: [{ stdin: '日本語\n', expectedOutput: '', compare: true }, { stdin: 'two', expectedOutput: 'ignored', compare: false }] });
  assert.equal(await casesDirty(), false);
  await selectCase(1);
  await runAndWait();
  assert.equal(await casesDirty(), false);
  await page.getByTestId('stdin').fill('edited');
  await loadCases(file);
  assert.equal(await page.getByTestId('code-editor').inputValue(), source);
  assert.equal(await page.locator('#file-path').textContent(), sourcePath);
  assert.equal(await page.getByTestId('stdin').inputValue(), '日本語\n');
  assert.equal(await page.getByTestId('stdout').textContent(), '');
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  await selectCase(2);
  assert.equal(await page.getByTestId('expected-output').inputValue(), 'ignored');
  assert.equal(await page.getByTestId('expected-output').isDisabled(), true);
  assert.equal(await casesDirty(), false);
});

test('M14: canceling and invalid JSON preserve cases and unsaved edits', async () => {
  await addCase('second');
  await page.getByTestId('stdin').fill('keep this');
  await fileOperation(() => page.getByRole('button', { name: 'ケース読込', exact: true }).click(), [discard(false)]);
  await fileOperation(() => page.getByRole('button', { name: 'ケース読込', exact: true }).click(), [discard(true), { title: 'サンプルを開く', buttonId: '2' }]);
  await fileOperation(() => page.getByRole('button', { name: 'ケース保存', exact: true }).click(), [{ title: 'サンプルを保存', buttonId: '2' }]);
  assert.equal(await page.getByTestId('stdin').inputValue(), 'keep this');
  assert.equal(await casesDirty(), true);
  const bad = path.join(root, 'bad-cases.json');
  await writeFile(bad, '{"cases":[]}');
  await loadCases(bad);
  await page.locator('#message').filter({ hasText: 'ファイル操作に失敗しました' }).waitFor();
  assert.equal(await page.getByTestId('stdin').inputValue(), 'keep this');
  assert.equal(await page.getByLabel('サンプルケース', { exact: true }).locator('option').count(), 2);
  assert.equal(await casesDirty(), true);
});

test('M14: closing protects case-only edits and a new source keeps cases', async () => {
  await page.getByTestId('stdin').fill('keep this');
  await saveAs(path.join(root, '保存済みソース.rb'));
  assert.equal(await page.getByTestId('save-state').textContent(), '保存済み');
  await fileOperation(() => requestClose(app), [discard(false)]);
  assert.equal(await page.getByTestId('stdin').inputValue(), 'keep this');
  await newDocument();
  assert.equal(await page.getByTestId('stdin').inputValue(), 'keep this');
  assert.equal(await casesDirty(), true);
  await resetCases();
});

test('M13: validation errors remain visible after a later case succeeds', async () => {
  await page.getByTestId('code-editor').fill('puts STDIN.read');
  await page.getByTestId('stdin').fill('あ'.repeat(349526));
  await addCase('valid');
  await page.getByRole('button', { name: '全件実行', exact: true }).click();
  await page.getByTestId('cases-summary').filter({ hasText: '完了 2 / 2' }).waitFor();
  await selectCase(1);
  assert.match(await page.getByTestId('stderr').textContent(), /標準入力.*1 MiB/);
  await selectCase(2);
  assert.equal(await page.getByTestId('stdout').textContent(), 'valid\n');
  await resetCases();
  await page.getByTestId('stdin').fill('');
});

async function mismatch(actual, expected) {
  await page.getByTestId('code-editor').fill('print STDIN.read');
  await page.getByTestId('stdin').fill(actual);
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill(expected);
  await runAndWait();
  await page.getByTestId('comparison-status').filter({ hasText: /^不一致$/ }).waitFor();
}
async function openDifference() {
  await page.getByTestId('comparison-status').click();
  await page.getByRole('dialog').waitFor();
}
async function closeDifference() {
  await page.getByRole('button', { name: '閉じる', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
}

test('M15: show Unicode positions and render output safely as text', async () => {
  await mismatch('ok\n日😀A', 'ok\n日😀B');
  await openDifference();
  assert.equal(await page.getByTestId('difference-position').textContent(), '最初の不一致：2 行 3 列');
  assert.equal(await page.getByTestId('difference-actual').locator('mark').textContent(), 'A');
  assert.equal(await page.getByTestId('difference-expected').locator('mark').textContent(), 'B');
  await closeDifference();
  await mismatch('👩‍💻A', '👩‍💻B');
  await openDifference();
  assert.equal(await page.getByTestId('difference-position').textContent(), '最初の不一致：1 行 4 列');
  assert.equal(await page.getByTestId('difference-actual').locator('mark').textContent(), 'A');
  await closeDifference();
  await mismatch('<img><script>alert(1)</script>', '<img><script>alert(2)</script>');
  await openDifference();
  assert.match(await page.getByTestId('difference-actual').textContent(), /<img/);
  assert.equal(await page.getByRole('dialog').locator('img, script').count(), 0);
  await closeDifference();
});

test('M15: whitespace, empty lines and missing lines have distinct labels', async () => {
  for (const [actual, expected, actualMark, expectedMark] of [
    ['a ', 'a', '␠（半角空白）', '（行末）'],
    ['\t', ' ', '⇥（タブ）', '␠（半角空白）'],
    ['　', ' ', '□（全角空白）', '␠（半角空白）'],
    ['␠', ' ', '␠', '␠（半角空白）'],
    ['ok', 'ok\n\n', '（行なし）', '（空行）'],
    ['\n\n', '', '（空行）', '（行なし）'],
    ['', 'x', '（空行）', 'x'],
  ]) {
    await mismatch(actual, expected);
    await openDifference();
    assert.equal(await page.getByTestId('difference-actual').locator('mark').textContent(), actualMark);
    assert.equal(await page.getByTestId('difference-expected').locator('mark').textContent(), expectedMark);
    await closeDifference();
  }
});

test('M15: case details survive selection and saving, then invalidate independently', async () => {
  await page.getByTestId('code-editor').fill('print STDIN.read');
  await saveAs(path.join(root, '不一致の詳細.rb'));
  await mismatch('one', 'ONE');
  await addCase('two', 'TWO');
  await runAndWait();
  await selectCase(1);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  const caseFile = path.join(root, 'detail-cases.json');
  await saveCases(caseFile);
  assert.ok(JSON.parse(await readFile(caseFile, 'utf8')).cases.every(item => !('difference' in item)));
  assert.equal(await casesDirty(), false);
  await openDifference();
  assert.equal(await page.getByTestId('difference-actual').textContent(), 'one');
  await closeDifference();
  assert.equal(await casesDirty(), false);
  await page.getByTestId('expected-output').fill('edited');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  await selectCase(2);
  await openDifference();
  assert.equal(await page.getByTestId('difference-actual').textContent(), 'two');
  await closeDifference();
  await page.getByTestId('code-editor').fill('print "changed"');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  await selectCase(1);
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  await resetCases();
});

test('M15: edits, clearing and a later matching run remove old details', async () => {
  for (const change of [
    () => page.getByTestId('stdin').fill('changed'),
    () => page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck(),
    () => page.getByRole('button', { name: 'クリア', exact: true }).click(),
  ]) {
    await mismatch('actual', 'expected');
    await change();
    assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
    assert.equal(await page.getByRole('dialog').isVisible(), false);
  }
  await mismatch('actual', 'expected');
  await page.getByTestId('expected-output').fill('actual');
  await runAndWait();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '一致');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});

test('M15: keyboard details fit the minimum window and larger line boxes', async () => {
  await mismatch('日😀A', '日😀B');
  await page.setViewportSize({ width: 900, height: 650 });
  try {
    await page.evaluate(() => { document.body.style.lineHeight = '1.8'; });
    await page.getByTestId('comparison-status').focus();
    await page.getByTestId('comparison-status').press('Enter');
    await page.getByRole('dialog').waitFor();
    const bounds = await page.getByRole('dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 900 && bounds.y + bounds.height <= 650);
    await assertWorkspaceFits();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('comparison-status').isEnabled(), true);
  } finally {
    await page.evaluate(() => { document.getElementById('difference-dialog').close(); document.body.style.lineHeight = ''; });
    await page.setViewportSize({ width: 1280, height: 850 });
  }
});

test('M15: long lines show bounded context around the correct Unicode column', async () => {
  const prefix = 'あ'.repeat(65536);
  await mismatch(`${prefix}A`, `${prefix}B`);
  await openDifference();
  assert.equal(await page.getByTestId('difference-position').textContent(), '最初の不一致：1 行 65537 列');
  for (const id of ['difference-actual', 'difference-expected']) {
    assert.ok((await page.getByTestId(id).textContent()).length < 150);
    assert.match(await page.getByTestId(id).textContent(), /^…/);
  }
  assert.equal(await page.getByTestId('difference-actual').locator('mark').textContent(), 'A');
  await closeDifference();
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
  await page.getByTestId('stdin').fill('');
});

async function seedProblem(task) {
  const url = `https://atcoder.jp/contests/${libraryContest}/tasks/${task}`;
  const problem = { url, title: `A - ${task}`, statement: '整数AとBの和。<img src=x onerror=alert(1)>\n1 \\leq A,B \\leq 100\n'.repeat(80), samples: [{ stdin: '1 2\n', expectedOutput: '3\n', compare: true }, { stdin: '10 20\n', expectedOutput: '30\n', compare: true }] };
  const directory = path.join(app.dataDir, 'library/problems', libraryContest, task);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'problem.json'), JSON.stringify(problem));
  return problem;
}
async function openProblemDialog(url) {
  await page.locator('#problem-library').click();
  await page.locator('#problem-url').fill(url);
}
async function waitProblem() {
  await page.waitForFunction(() => !document.getElementById('problem-open').disabled);
}

test('P01: cached problem opens offline, runs samples and restores its saved workspace', async () => {
  const problem = await seedProblem('save');
  await page.setViewportSize({ width: 900, height: 650 });
  await openProblemDialog(problem.url);
  await page.locator('#problem-open').click({ timeout: 2000 });
  await page.locator('#problem-title').filter({ hasText: problem.title }).waitFor();
  assert.equal(await page.locator('#problem-statement img').count(), 0);
  assert.equal(await page.locator('#problem-statement').textContent(), problem.statement);
  const dialogFits = await page.locator('#problem-dialog').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
  });
  assert.equal(dialogFits, true);
  await page.screenshot({ path: 'test-results/problem-library.png' });
  await page.locator('#problem-close').click();
  assert.equal(await page.locator('#code-editor').inputValue(), '');
  const sourcePath = path.join(app.dataDir, 'workspaces', libraryContest, 'save', 'solution.rb');
  const normalizePath = value => process.platform === 'win32' ? path.toNamespacedPath(value).toLowerCase() : path.resolve(value);
  assert.equal(normalizePath(await page.locator('#file-path').textContent()), normalizePath(sourcePath));
  await page.locator('#code-editor').fill('puts STDIN.read.split.map(&:to_i).sum');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  await page.locator('#run-all').click();
  await page.locator('#cases-summary').filter({ hasText: /完了 2 \/ 2.*一致 2/ }).waitFor();
  await selectCase(1);
  await page.locator('#stdin').fill('9 1\n');
  await page.locator('#expected-output').fill('10\n');
  await page.locator('#cases-save').click();
  await page.waitForFunction(() => !document.getElementById('cases-save').disabled);
  assert.equal(await casesDirty(), false, await page.locator('#message').textContent());
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await openProblemDialog(problem.url);
  await page.locator('#problem-open').click();
  await page.locator('#problem-title').filter({ hasText: problem.title }).waitFor();
  await page.locator('#problem-close').click();
  assert.equal(await page.locator('#stdin').inputValue(), '9 1\n');
  assert.equal(await page.locator('#code-editor').inputValue(), await readFile(sourcePath, 'utf8'));
  await runAndWait();
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
});

test('P02: problem switching protects both unsaved code and cases', async () => {
  const a = await seedProblem('guard_a'); const b = await seedProblem('guard_b');
  await openProblemDialog(a.url); await page.locator('#problem-open').click();
  await page.locator('#problem-title').filter({ hasText: a.title }).waitFor();
  await page.locator('#problem-close').click();
  await page.locator('#code-editor').fill('puts "keep code"');
  await page.locator('#stdin').fill('keep cases');
  const originalPath = await page.locator('#file-path').textContent();
  await openProblemDialog(b.url);
  await fileOperation(() => page.locator('#problem-open').click(), [discard(false)]);
  assert.equal(await page.locator('#problem-title').textContent(), a.title);
  assert.equal(await page.locator('#file-path').textContent(), originalPath);
  assert.equal(await page.locator('#code-editor').inputValue(), 'puts "keep code"');
  assert.equal(await page.locator('#stdin').inputValue(), 'keep cases');
  await fileOperation(() => page.locator('#problem-open').click(), [discard(true)]);
  await page.locator('#problem-title').filter({ hasText: b.title }).waitFor();
  await page.locator('#problem-close').click();
  assert.equal(await page.locator('#code-editor').inputValue(), '');
  assert.equal(await page.locator('#stdin').inputValue(), '1 2\n');
});

test('P03: invalid cache preserves the current problem and workspace', async () => {
  const a = await seedProblem('failure_a'); const b = await seedProblem('failure_b');
  await openProblemDialog(a.url); await page.locator('#problem-open').click();
  await page.locator('#problem-title').filter({ hasText: a.title }).waitFor();
  await writeFile(path.join(app.dataDir, 'library/problems', libraryContest, 'failure_b', 'problem.json'), '{}');
  await page.locator('#problem-url').fill(b.url);
  await page.locator('#problem-open').click(); await waitProblem();
  await page.locator('#message').filter({ hasText: '失敗' }).waitFor();
  assert.equal(await page.locator('#problem-title').textContent(), a.title);
  await page.locator('#problem-close').click();
  assert.equal(await page.locator('#stdin').inputValue(), '1 2\n');
});

test('P04: refresh keeps edited code and cases and retains the previous statement on error', async () => {
  const problem = await seedProblem('refresh');
  await openProblemDialog(problem.url); await page.locator('#problem-open').click();
  await page.locator('#problem-title').filter({ hasText: problem.title }).waitFor();
  await page.locator('#problem-close').click();
  await page.locator('#code-editor').fill('puts "my edits"');
  await page.locator('#stdin').fill('my cases');
  await page.locator('#problem-library').click();
  // Isolate external HTTP at the bridge; Rust separately verifies HTTP and atomic cache updates.
  await page.evaluate(async problem => {
    const { ide } = await import('./bridge.js');
    ide.refreshProblem = async () => ({ ...problem, title: 'Updated problem' });
  }, problem);
  await page.locator('#problem-refresh').click();
  await page.locator('#problem-title').filter({ hasText: 'Updated problem' }).waitFor();
  assert.equal(await page.locator('#code-editor').inputValue(), 'puts "my edits"');
  assert.equal(await page.locator('#stdin').inputValue(), 'my cases');
  assert.equal(await casesDirty(), true);
  assert.match(await page.locator('#save-state').textContent(), /変更/);
  const workspace = path.join(app.dataDir, 'workspaces', libraryContest, 'refresh');
  assert.equal(await readFile(path.join(workspace, 'solution.rb'), 'utf8'), '');
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, 'cases.json'), 'utf8')).cases, problem.samples);
  await page.evaluate(async () => {
    const { ide } = await import('./bridge.js');
    ide.refreshProblem = async () => { throw new Error('network offline'); };
  });
  await page.locator('#problem-refresh').click(); await waitProblem();
  await page.locator('#problem-message').filter({ hasText: 'network offline' }).waitFor();
  assert.equal(await page.locator('#problem-title').textContent(), 'Updated problem');
  await page.locator('#problem-close').click();
});

test('P05: imported case JSON is unsaved for the workspace and New returns to normal file operations', async () => {
  const problem = await seedProblem('import');
  await openProblemDialog(problem.url); await page.locator('#problem-open').click();
  await page.locator('#problem-title').filter({ hasText: problem.title }).waitFor();
  await page.locator('#problem-close').click();
  const imported = [{ stdin: 'imported\n', expectedOutput: '', compare: false }];
  const file = path.join(root, 'problem-import.json');
  await writeFile(file, JSON.stringify({ cases: imported }));
  await loadCases(file);
  assert.equal(await casesDirty(), true);
  await page.locator('#cases-save').click();
  await page.waitForFunction(() => !document.getElementById('cases-save').disabled);
  assert.equal(await casesDirty(), false);
  const saved = path.join(app.dataDir, 'workspaces', libraryContest, 'import', 'cases.json');
  assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')).cases, imported);
  await newDocument();
  await page.locator('#problem-library').click();
  assert.equal(await page.locator('#problem-refresh').isEnabled(), true);
  assert.equal(await page.locator('#problem-title').textContent(), '問題を選んでください');
  await page.locator('#problem-close').click();
  await fileOperation(() => page.locator('#cases-save').click(), [{ title: 'サンプルを保存', buttonId: '2' }]);
});

test('P06: refresh can repair a cache before any problem is selected', async () => {
  const problem = await seedProblem('repair');
  const cache = path.join(app.dataDir, 'library/problems', libraryContest, 'repair', 'problem.json');
  await writeFile(cache, '{}');
  await openProblemDialog(problem.url);
  await page.locator('#problem-open').click(); await waitProblem();
  await page.locator('#problem-message').filter({ hasText: '再取得' }).waitFor();
  assert.equal(await page.locator('#problem-refresh').isEnabled(), true);
  await page.evaluate(async problem => {
    const { ide } = await import('./bridge.js');
    window.refreshedUrl = null;
    ide.refreshProblem = async url => { window.refreshedUrl = url; return problem; };
  }, problem);
  await page.locator('#problem-refresh').click(); await waitProblem();
  assert.equal(await page.evaluate(() => window.refreshedUrl), problem.url);
  assert.equal(await page.locator('#problem-title').textContent(), '問題を選んでください');
  assert.match(await page.locator('#problem-message').textContent(), /「開く」/);
  // The bridge mock represents only HTTP; open through the real cache/workspace API.
  await writeFile(cache, JSON.stringify(problem));
  await page.locator('#problem-open').click();
  await page.locator('#problem-title').filter({ hasText: problem.title }).waitFor();
  await page.locator('#problem-close').click();
});

async function seedCollection(count = 2) {
  await rm(path.join(app.dataDir, 'workspaces', libraryContest), { recursive: true, force: true });
  const url = `https://atcoder.jp/contests/${libraryContest}`;
  const collection = { url, title: '練習問題集 <script>safe</script>', tasks: Array.from({ length: count }, (_, index) => ({ label: `A${String(index + 1).padStart(2, '0')}`, title: `Problem ${index + 1}`, url: `${url}/tasks/collection_${index}`, error: null })) };
  const directory = path.join(app.dataDir, 'library/collections');
  await rm(path.join(directory, libraryContest), { recursive: true, force: true });
  await mkdir(path.join(directory, libraryContest), { recursive: true });
  await writeFile(path.join(directory, `${libraryContest}.json`), JSON.stringify(collection));
  return collection;
}
async function seedCollectionTask(task) {
  const problem = { url: task.url, title: `${task.label} - ${task.title}`, statement: '固定保存した問題文', samples: [{ stdin: '1 2\n', expectedOutput: '3\n', compare: true }] };
  await writeFile(path.join(app.dataDir, 'library/collections', libraryContest, `${task.url.split('/').at(-1)}.json`), JSON.stringify(problem));
}
async function showCollections() {
  await page.locator('#collections').click();
  await page.waitForFunction(() => !document.getElementById('collection-register').disabled);
  await page.locator('#collection-select').selectOption(`https://atcoder.jp/contests/${libraryContest}`);
}

test('C01: fixed collection opens offline, protects edits and restores the saved workspace', async () => {
  const collection = await seedCollection();
  await Promise.all(collection.tasks.map(seedCollectionTask));
  await showCollections();
  assert.equal(await page.locator('#collection-title').textContent(), collection.title);
  assert.equal(await page.locator('#collection-title script').count(), 0);
  await page.setViewportSize({ width: 900, height: 650 });
  assert.equal(await page.locator('#collection-dialog').evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && el.scrollWidth <= el.clientWidth; }), true);
  await page.screenshot({ path: 'test-results/collection-library.png' });
  await page.locator('#collection-tasks button').first().click();
  await page.locator('#problem-title').filter({ hasText: 'A01 - Problem 1' }).waitFor();
  assert.equal(await page.locator('#problem-refresh').isDisabled(), true);
  await page.locator('#problem-close').click();
  await page.locator('#code-editor').fill('puts STDIN.read.split.map(&:to_i).sum');
  await page.locator('#save').click();
  await page.waitForFunction(() => !document.getElementById('save').disabled);
  await page.locator('#stdin').fill('4 5\n');
  await page.locator('#expected-output').fill('9\n');
  await page.locator('#cases-save').click();
  await page.waitForFunction(() => !document.getElementById('cases-save').disabled);
  await page.locator('#stdin').fill('unsaved');
  await showCollections();
  await fileOperation(() => page.locator('#collection-tasks button').nth(1).click(), [discard(false)]);
  assert.equal(await page.locator('#stdin').inputValue(), 'unsaved');
  await fileOperation(() => page.locator('#collection-tasks button').nth(1).click(), [discard(true)]);
  await page.locator('#problem-close').click();
  await showCollections();
  await page.locator('#collection-tasks button').first().click();
  await page.locator('#problem-close').click();
  assert.equal(await page.locator('#stdin').inputValue(), '4 5\n');
  await runAndWait();
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
});

test('C02: registration fetches sequentially, pauses and resumes only missing tasks after reload', async () => {
  const collection = await seedCollection(3);
  // HTTP alone is replaced; persistence and subsequent opens use the real store.
  const calls = [];
  let failFirst = true;
  let signalFirst;
  const firstStarted = new Promise(resolve => { signalFirst = resolve; });
  let releaseFirst;
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  await page.exposeFunction('__collectionFetch', async (url, taskUrl) => {
    calls.push(taskUrl);
    const task = collection.tasks.find(task => task.url === taskUrl);
    if (task === collection.tasks[0] && failFirst) { signalFirst(); await firstResponse; task.error = 'network offline'; failFirst = false; }
    else { await seedCollectionTask(task); task.error = null; }
    await writeFile(path.join(app.dataDir, 'library/collections', `${libraryContest}.json`), JSON.stringify(collection));
    const downloaded = [];
    for (const task of collection.tasks) if (await access(path.join(app.dataDir, 'library/collections', libraryContest, `${task.url.split('/').at(-1)}.json`)).then(() => true, () => false)) downloaded.push(task.url);
    return { collection, downloaded };
  });
  await page.evaluate(async collection => {
    const { ide } = await import('./bridge.js');
    ide.registerCollection = async () => ({ view: { collection, downloaded: [] }, created: true });
    ide.fetchCollectionTask = (url, task) => window.__collectionFetch(url, task);
  }, collection);
  await page.locator('#collections').click();
  await page.waitForFunction(() => !document.getElementById('collection-register').disabled);
  await page.locator('#collection-url').fill(collection.url);
  await page.locator('#collection-register').click();
  await firstStarted;
  await page.locator('#collection-pause').click();
  releaseFirst();
  await page.waitForFunction(() => !document.getElementById('collection-register').disabled);
  await page.locator('#collection-tasks').filter({ hasText: 'network offline' }).waitFor();
  const beforeReload = calls.length;
  assert.ok(beforeReload < 3);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('run').disabled);
  await page.evaluate(async () => { const { ide } = await import('./bridge.js'); ide.fetchCollectionTask = (url, task) => window.__collectionFetch(url, task); });
  await showCollections();
  await page.locator('#collection-resume').click();
  await page.waitForFunction(() => document.getElementById('collection-progress').textContent.includes('取得済み 3 / 3'));
  await page.waitForFunction(() => document.getElementById('collection-pause').disabled);
  assert.equal(calls.filter(url => url === collection.tasks[0].url).length, 2);
  for (const task of collection.tasks.slice(1)) assert.equal(calls.filter(url => url === task.url).length, 1);
  const total = calls.length;
  await page.locator('#collection-url').fill(collection.url);
  await page.locator('#collection-register').click();
  await page.waitForFunction(() => !document.getElementById('collection-register').disabled);
  assert.equal(calls.length, total);
  assert.equal(await page.locator('#collection-resume').isDisabled(), true);
  await page.locator('#collection-close').click();
});

test('C03: tasks without inline samples open, and corrupt snapshots preserve the current document', async () => {
  const collection = await seedCollection();
  const directory = path.join(app.dataDir, 'library/collections', libraryContest);
  await writeFile(path.join(directory, 'collection_0.json'), JSON.stringify({ url: collection.tasks[0].url, title: 'A01 - No inline samples', statement: 'サンプルは別ファイルで配布', samples: [] }));
  await writeFile(path.join(directory, 'collection_1.json'), 'corrupt');
  await showCollections();
  await page.locator('#collection-tasks button').first().click();
  await page.locator('#problem-title').filter({ hasText: 'No inline samples' }).waitFor();
  await page.locator('#problem-close').click();
  assert.equal(await page.locator('#case-count').textContent(), '1 ケース');
  assert.equal(await page.locator('#compare-output').isChecked(), false);
  await page.locator('#code-editor').fill('puts 42');
  const currentPath = await page.locator('#file-path').textContent();
  await showCollections();
  await fileOperation(() => page.locator('#collection-tasks button').nth(1).click(), [discard(true)]);
  await page.locator('#collection-message').filter({ hasText: '不正' }).waitFor();
  assert.equal(await page.locator('#code-editor').inputValue(), 'puts 42');
  assert.equal(await page.locator('#file-path').textContent(), currentPath);
  await page.locator('#collection-close').click();
});

test('M06/M09: accepting close stops Ruby descendants and exits', async () => {
  const marker = path.join(root, 'orphan.txt').replaceAll('\\', '/');
  await page.getByTestId('code-editor').fill(`require 'rbconfig'; spawn(RbConfig.ruby, '-e', 'sleep 2; File.write(${JSON.stringify(marker)}, "survived")'); puts 'ready'; sleep 30`);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
  const exited = once(app.child, 'exit', { signal: AbortSignal.timeout(30000) });
  await Promise.all([exited, dialogs(app, () => requestClose(app), [discard(true)], true)]);
  await pause(2200);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
