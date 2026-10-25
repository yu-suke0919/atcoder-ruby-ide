const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { launch, dialogs, discard, open, save, cancelSave, overwrite, close, pause } = require('./support.cjs');

let app;
let page;
let root;
before(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'AtCoder IDE 日本語 ')));
  app = await launch(root);
  page = app.page;
});
after(async () => {
  if (app) await close(app);
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
  await page.getByTestId('expected-output').fill('ready');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '比較中…');
  await page.getByTestId('expected-output').fill('changed');
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
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
  await page.getByTestId('code-editor').fill('loop { puts "x" * 8192 }');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '出力上限で停止' }).waitFor();
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  assert.ok(Buffer.byteLength(await page.getByTestId('stdout').textContent()) <= 1048576);
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});


test('M02/M03/M09: native open/save preserve Japanese paths and canceled edits', async () => {
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

test('M09: cancel native close/new confirmation, then create and save a document', async () => {
  await page.getByTestId('code-editor').fill('puts "保持"');
  await fileOperation(() => page.getByRole('button', { name: '新規', exact: true }).click(), [discard(false)]);
  await fileOperation(() => page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close()), [discard(false)]);
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

test('M11: native open/new reset the previous comparison', async () => {
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

test('R06: native overwrite and same-path Save As preserve comparison results', async () => {
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

test('M07/M12: bundled Ruby loads JSON and saved-directory files without Ruby on PATH', async () => {
  await writeFile(path.join(root, '入力.json'), '{"message":"日本語"}', 'utf8');
  await page.getByTestId('code-editor').fill('require "json"; puts JSON.parse(File.read("入力.json"))["message"]');
  await runAndWait();
  assert.equal(await page.getByTestId('stdout').textContent(), '日本語\n');
});

test('M06/M09: accepting native close stops Ruby descendants and exits', async () => {
  const marker = path.join(root, 'orphan.txt').replaceAll('\\', '/');
  await page.getByTestId('code-editor').fill(`require 'rbconfig'; spawn(RbConfig.ruby, '-e', 'sleep 2; File.write(${JSON.stringify(marker)}, "survived")'); puts 'ready'; sleep 30`);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
  const exited = once(app.child, 'exit', { signal: AbortSignal.timeout(30000) });
  await Promise.all([exited, dialogs(app, () => page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close()), [discard(true)], true)]);
  await pause(2200);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});
