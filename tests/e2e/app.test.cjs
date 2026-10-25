const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

let app;
let page;
let root;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'AtCoder IDE 日本語 '));
  const executablePath = process.env.PACKAGED_APP || require('electron');
  app = await electron.launch({
    executablePath,
    args: [
      `--user-data-dir=${path.join(root, 'electron-profile')}`,
      ...(process.platform === 'linux' && !process.env.DISPLAY ? ['--ozone-platform=headless', '--disable-gpu'] : []),
      ...(process.env.PACKAGED_APP ? [] : ['.'])
    ],
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
    timeout: 30000
  });
  page = await app.firstWindow();
  await page.getByTestId('ruby-version').filter({ hasText: /ruby 3\./i }).waitFor();
});
after(async () => {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0));
    await app.close();
  }
  if (root) await rm(root, { recursive: true, force: true });
});

async function assertWorkspaceFits() {
  const layout = await page.evaluate(() => ({
    outputBottom: document.querySelector('.output-panel').getBoundingClientRect().bottom,
    toolbarTop: document.querySelector('.run-toolbar').getBoundingClientRect().top,
    summaryBottom: document.querySelector('.run-summary').getBoundingClientRect().bottom,
    stdoutHeight: document.querySelector('#stdout').getBoundingClientRect().height,
    stderrHeight: document.querySelector('#stderr').getBoundingClientRect().height,
    inputHeight: document.querySelector('#stdin').getBoundingClientRect().height,
    viewportHeight: innerHeight
  }));
  const details = JSON.stringify(layout);
  assert.ok(layout.outputBottom <= layout.toolbarTop, `output must not overlap run controls: ${details}`);
  assert.ok(layout.summaryBottom <= layout.outputBottom, `run summary must remain visible: ${details}`);
  assert.ok(layout.stdoutHeight > 12 && layout.stderrHeight > 12 && layout.inputHeight > 12, `text areas must remain usable: ${details}`);
}

test('M01: editor, output and run controls fit the minimum window size', async () => {
  await page.setViewportSize({ width: 900, height: 650 });
  await assertWorkspaceFits();
  await page.setViewportSize({ width: 1280, height: 850 });
});

test('R03: larger font line boxes do not push output into run controls', async () => {
  await page.setViewportSize({ width: 900, height: 650 });
  try {
    await page.evaluate(() => { document.body.style.lineHeight = '1.8'; });
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).lineHeight), '23.4px');
    await assertWorkspaceFits();
  } finally {
    await page.evaluate(() => { document.body.style.lineHeight = ''; });
    await page.setViewportSize({ width: 1280, height: 850 });
  }
});

test('M04: the initial AtCoder sample produces 6 test', async () => {
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('stdout').textContent(), '6 test\n');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/workspace.png' });
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
  await page.getByTestId('code-editor').fill('$stdout.sync = true; puts "ready"; loop { sleep 0.01 }');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '実行', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '停止しました' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '実行', exact: true }).isEnabled(), true);
});

test('M02/M03/M09: load, edit and save a file; retain edits when discard is canceled', async () => {
  const filePath = path.join(root, '解答.rb');
  await writeFile(filePath, 'puts "ファイル"\n', 'utf8');
  await app.evaluate(({ dialog }, selected) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, filePath);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="code-editor"]').value === 'puts "ファイル"\n');
  await page.getByTestId('code-editor').fill('puts "変更済み"\n');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.getByRole('button', { name: '開く', exact: true }).click();
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "変更済み"\n');
  await page.keyboard.press('Control+s');
  await page.getByTestId('save-state').filter({ hasText: '保存済み' }).waitFor();
  assert.equal(await readFile(filePath, 'utf8'), 'puts "変更済み"\n');
});

test('M03: canceled Save As keeps the buffer and existing file', async () => {
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await page.getByTestId('code-editor').fill('puts "未保存"');
  await page.keyboard.press('Control+Shift+s');
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "未保存"');
  assert.match(await page.getByTestId('save-state').textContent(), /未保存/);
  assert.equal(await readFile(path.join(root, '解答.rb'), 'utf8'), 'puts "変更済み"\n');
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
  await page.getByTestId('code-editor').fill('loop {}');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '時間制限で停止' }).waitFor({ timeout: 10000 });
  await page.getByTestId('code-editor').fill('loop { puts "x" * 8192 }');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '出力上限で停止' }).waitFor();
  assert.ok(Buffer.byteLength(await page.getByTestId('stdout').textContent()) <= 1048576);
});

test('M09: cancel closing or replacing a dirty buffer; create and save a new file', async () => {
  await page.getByTestId('code-editor').fill('puts "保持"');
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.getByRole('button', { name: '新規', exact: true }).click();
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "保持"');
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  assert.equal(await page.getByTestId('code-editor').inputValue(), 'puts "保持"');
  const newPath = path.join(root, '新しい解答.rb');
  await app.evaluate(({ dialog }, selected) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected });
  }, newPath);
  await page.getByRole('button', { name: '新規', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="code-editor"]').value === '');
  await page.getByTestId('code-editor').fill('puts "新規保存"');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByTestId('save-state').filter({ hasText: '保存済み' }).waitFor();
  assert.equal(await readFile(newPath, 'utf8'), 'puts "新規保存"');
});

test('R01: opening a CRLF file keeps the normalized buffer clean', async () => {
  const filePath = path.join(root, 'Windows 改行.rb');
  await writeFile(filePath, 'puts 1\r\nputs 2\r\n', 'utf8');
  await app.evaluate(({ dialog }, selected) => {
    dialog.showMessageBox = async () => ({ response: 0 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  }, filePath);
  await page.getByRole('button', { name: '開く', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="code-editor"]').value === 'puts 1\nputs 2\n');
  assert.equal(await page.getByTestId('save-state').textContent(), '保存済み');
  assert.equal(await readFile(filePath, 'utf8'), 'puts 1\r\nputs 2\r\n');
});
