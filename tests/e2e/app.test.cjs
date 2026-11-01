const { editorText } = require('./editor.cjs');
const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { runner, launch, close, requestClose, pause, memoryUse } = require('./support.cjs');
const { taskPage } = require('./atcoder-fixture.cjs');
const { sampleCode, seedProblem: seedWorkspaceProblem, openProblem, selectTask, removeContest, waitInitialized } = require('./workspace.cjs');

describe('Application', () => {
let app;
let page;
let root;
const testContest = `ide-e2e-${Date.now()}`;
before(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'AtCoder IDE 日本語 ')));
  app = await launch(root);
  page = app.page;
});
async function resetWorkspace() {
  await page.waitForFunction(() => !['pending', 'saving'].includes(document.getElementById('save-state').dataset.state));
  if (await page.locator('#stop').isEnabled()) {
    await page.locator('#stop').click();
    await page.waitForFunction(() => document.getElementById('stop').disabled);
  }
  const acceptReload = dialog => dialog.accept();
  page.on('dialog', acceptReload);
  try { await page.reload(); }
  finally { page.off('dialog', acceptReload); }
  await page.setViewportSize({ width: 1280, height: 850 });
  await waitInitialized(page);
  await openStarter();
}
beforeEach(resetWorkspace);

after(async () => {
  if (app) await close(app);
  if (app) for (const contest of [testContest, `${testContest}-list`, `${testContest}-memory`]) await removeContest(app, contest);
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

let starterProblem;
async function openStarter(options = {}) {
  starterProblem = await seedWorkspaceProblem(app, testContest, options.task || 'starter', { ...options, task: options.taskData ?? { samples: [] } });
  await openProblem(page, starterProblem, options);
  return starterProblem;
}
async function waitSaved() {
  await page.waitForFunction(() => document.getElementById('save-state').dataset.state === 'saved');
}
async function waitSaveFailed() {
  await page.waitForFunction(() => document.getElementById('save-state').dataset.state === 'failed');
}
// Replacing a workspace file with a directory makes the atomic save fail on every OS.
const blockedFiles = new Map();
async function blockSaving(file) {
  blockedFiles.set(file, await readFile(file));
  await rm(file, { force: true });
  await mkdir(file);
}
async function unblockSaving(file) {
  await rm(file, { recursive: true, force: true });
  await writeFile(file, blockedFiles.get(file));
  blockedFiles.delete(file);
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
    await waitInitialized(page);
  } else {
    await dialog.dismiss();
  }
}

test('M03: edits autosave to the problem workspace and a reload needs no confirmation', async () => {
  await page.getByTestId('code-editor').fill('puts "自動保存"');
  assert.equal(await page.getByTestId('save-state').getAttribute('data-state'), 'pending');
  await page.getByTestId('stdin').fill('保存された入力\n');
  await waitSaved();
  assert.equal(await page.getByTestId('save-state').textContent(), '保存済み');
  assert.equal(await readFile(starterProblem.solution, 'utf8'), 'puts "自動保存"');
  assert.equal(JSON.parse(await readFile(starterProblem.cases, 'utf8')).cases[0].stdin, '保存された入力\n');
  await page.reload();
  await waitInitialized(page);
  await openProblem(page, starterProblem);
  assert.equal(await editorText(page), 'puts "自動保存"');
  assert.equal(await page.getByTestId('stdin').inputValue(), '保存された入力\n');
});

test('M03: Ctrl+S saves immediately without a dialog', async () => {
  await page.getByTestId('code-editor').fill('puts "すぐ保存"');
  await page.keyboard.press('Control+s');
  await waitSaved();
  assert.equal(await readFile(starterProblem.solution, 'utf8'), 'puts "すぐ保存"');
  assert.equal(await page.locator('dialog[open]').count(), 0);
});

test('M03/M09: a failed save keeps edits, can be retried and is confirmed before leaving', async () => {
  const other = await seedWorkspaceProblem(app, testContest, 'other');
  await openProblem(page, starterProblem);
  await blockSaving(starterProblem.solution);
  try {
    await page.getByTestId('code-editor').fill('puts "失敗しても残る"');
    await waitSaveFailed();
    assert.match(await page.getByTestId('save-state').textContent(), /保存に失敗しました/);
    assert.equal(await page.locator('#save-retry').isVisible(), true);
    await selectTask(page, other);
    await page.locator('#save-failed-dialog').waitFor();
    await page.locator('#save-failed-cancel').click();
    assert.equal(await page.locator('#problem-title').textContent(), starterProblem.title);
    assert.equal(await editorText(page), 'puts "失敗しても残る"');
    await requestClose(app);
    await page.locator('#save-failed-dialog').waitFor();
    await page.locator('#save-failed-cancel').click();
    assert.equal(await editorText(page), 'puts "失敗しても残る"');
  } finally {
    await unblockSaving(starterProblem.solution);
  }
  await page.locator('#save-retry').click();
  await waitSaved();
  assert.equal(await readFile(starterProblem.solution, 'utf8'), 'puts "失敗しても残る"');
  await blockSaving(starterProblem.solution);
  try {
    await page.getByTestId('code-editor').fill('puts "破棄する"');
    await waitSaveFailed();
    await selectTask(page, other);
    await page.locator('#save-failed-dialog').waitFor();
    await page.locator('#save-failed-discard').click();
    await page.locator('#problem-title').filter({ hasText: other.title }).waitFor();
  } finally {
    await unblockSaving(starterProblem.solution);
  }
  await openProblem(page, starterProblem);
  assert.equal(await editorText(page), 'puts "失敗しても残る"');
});

test('R07: reload protects a failed source save and an accepted reload starts at home', async () => {
  await blockSaving(starterProblem.solution);
  try {
    await page.locator('#code-editor').fill('puts "unsaved source"');
    await waitSaveFailed();
    await confirmReload(false);
    assert.equal(await editorText(page), 'puts "unsaved source"');
    await confirmReload(true);
  } finally {
    await unblockSaving(starterProblem.solution);
  }
  await page.locator('#problem-title').filter({ hasText: /^ホーム$/ }).waitFor();
  assert.notEqual(await editorText(page), 'puts "unsaved source"');
  await openStarter();
  await runAndWait();
  assert.equal(await page.locator('#stdout').textContent(), '6 test\n');
});

test('R07: reload protects a failed case save', async () => {
  await blockSaving(starterProblem.cases);
  try {
    await page.locator('#stdin').fill('unsaved case');
    await waitSaveFailed();
    await confirmReload(false);
    assert.equal(await page.locator('#stdin').inputValue(), 'unsaved case');
    assert.equal(await editorText(page).then(code => code.includes('gets.to_i')), true);
  } finally {
    await unblockSaving(starterProblem.cases);
  }
});

test('R07: accepting reload stops an active run before enabling a new run', async () => {
  await page.locator('#code-editor').fill('puts "ready"; loop { puts "streaming"; sleep 0.01 }');
  await page.locator('#run').click();
  await page.locator('#stdout').filter({ hasText: 'ready' }).waitFor();
  await confirmReload(true);
  await openStarter();
  await runAndWait();
  assert.equal(await page.locator('#stdout').textContent(), '6 test\n');
});

test('R08: editing one case field preserves raw newlines in the other fields', async () => {
  for (const [name, newline] of [['crlf', '\r\n'], ['cr', '\r']]) {
    const input = `A${newline}B${newline}`;
    const bytes = [...Buffer.from(input)].join(',');
    const expected = bytes + newline;
    for (const field of ['expected-output', 'stdin', 'compare-output']) {
      await openStarter({ task: `raw_${name}_${field}`.replace("-", "_"), code: "puts STDIN.read.bytes.join(',')", cases: [{ stdin: input, expectedOutput: expected, compare: true }] });
      if (field === 'compare-output') {
        await page.locator('#compare-output').uncheck();
        await page.locator('#compare-output').check();
      } else {
        await page.locator(`#${field}`).fill('edited');
      }
      if (field !== 'stdin') {
        await runAndWait();
        assert.equal(await page.locator('#stdout').textContent(), bytes + '\n');
      }
      await page.keyboard.press('Control+s');
      await waitSaved();
      const [item] = JSON.parse(await readFile(starterProblem.cases, 'utf8')).cases;
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
    const { ide } = await import('./bridge.mjs');
    const original = ide.rubyInfo;
    let attempt = 0;
    ide.rubyInfo = () => {
      attempt++;
      if (attempt === 1) return new Promise((resolve, reject) => { window.rejectRubyProbe = () => reject(new Error('Ruby probe failed')); });
      if (attempt === 2) return Promise.reject(new Error('Ruby unavailable'));
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
  await waitSaved();
  await retry.click();
  await page.locator('#message').filter({ hasText: 'Ruby unavailable' }).waitFor();
  assert.equal(await page.locator('#ruby-version').textContent(), 'Ruby を起動できません');
  assert.equal(await page.locator('#run').isDisabled(), true);
  await retry.click();
  await waitInitialized(page);
  assert.equal(await editorText(page), 'puts "recovered"');
  assert.equal(await page.getByTestId('stdin').inputValue(), 'keep input');
  await runAndWait();
  assert.equal(await page.getByTestId('stdout').textContent(), 'recovered\n');
});

test('M01: editor, output and run controls fit the minimum window size', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await assertWorkspaceFits();
  await page.setViewportSize({ width: 1280, height: 850 });
});

test('R03: larger font line boxes do not push output into run controls', async () => {
  await page.setViewportSize({ width: 1280, height: 720 });
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
      try { const { ide } = await import('./bridge.mjs'); await ide.run('puts "must not run"', '', value); }
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
  assert.match(await editorText(page), /  $/);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
  assert.equal(await page.getByTestId('stdout').locator('img').count(), 0);
  assert.match(await page.getByTestId('stdout').textContent(), /<img/);
});

test('M08: a local memory-limit result is distinct and the batch continues', async () => {
  await page.evaluate(async () => {
    const { ide } = await import('./bridge.mjs');
    const run = ide.run;
    ide.run = (code, stdin, ...args) => stdin === 'limit'
      ? Promise.resolve({ status: 'memory-limit', stdout: '', stderr: '', exitCode: 1, durationMs: 100, executionLimitMs: 5000, comparison: null, difference: null, errorLine: null })
      : run(code, stdin, ...args);
  });
  await page.getByTestId('code-editor').fill('puts STDIN.read');
  await page.getByTestId('stdin').fill('limit');
  await page.locator('#compare-output').check();
  await page.locator('#expected-output').fill('must not match');
  await page.locator('#case-add').click();
  await page.getByTestId('stdin').fill('normal');
  await page.locator('#expected-output').fill('normal\n');
  await page.locator('#run-all').click();
  await page.getByTestId('cases-summary').filter({ hasText: '完了 2 / 2' }).waitFor({ timeout: 15000 });
  assert.match(await page.getByTestId('cases-summary').textContent(), /エラー 1/);
  await page.locator('#case-select').selectOption('0');
  assert.equal(await page.getByTestId('run-status').textContent(), 'ローカルのメモリ上限で停止（1 GiB）');
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  assert.equal(await page.locator('#error-location').isHidden(), true);
  await page.setViewportSize({ width: 1280, height: 720 });
  await assertWorkspaceFits();
  assert.equal(await page.locator('#run').isEnabled(), true);
  await page.locator('#case-select').selectOption('1');
  assert.match(await page.getByTestId('run-status').textContent(), /正常終了/);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '一致');
  await page.locator('#run').click();
  await page.waitForFunction(() => document.getElementById('stop').disabled);
  assert.match(await page.getByTestId('run-status').textContent(), /正常終了/);
});

test('M08: Windows enforces the commit cap even without a memory notification', { skip: process.platform !== 'win32' }, async () => {
  await page.getByTestId('code-editor').fill(await readFile(path.join(__dirname, '../fixtures/windows-memory.rb'), 'utf8'));
  await page.getByTestId('stdin').fill('denied');
  await page.locator('#compare-output').check();
  await page.locator('#expected-output').fill('must not match');
  await page.locator('#run').click();
  await page.waitForFunction(() => document.getElementById('stop').disabled);
  const status = await page.getByTestId('run-status').textContent();
  assert.ok(['ローカルのメモリ上限で停止（1 GiB）', '時間制限で停止（5 秒）'].includes(status), status);
  if (status.startsWith('時間制限')) assert.match(await page.getByTestId('stdout').textContent(), /allocation denied/);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  assert.equal(await page.locator('#error-location').isHidden(), true);
  await page.getByTestId('stdin').fill('normal');
  await runAndWait();
});

test('M06/M08: show timeout and output-limit reasons in the UI', async () => {
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('');
  await page.getByTestId('code-editor').fill('loop {}');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('run-status').filter({ hasText: '時間制限で停止' }).waitFor({ timeout: 10000 });
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  await page.getByTestId('code-editor').fill('STDOUT.write("x" * (1024 * 1024 + 1))');
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('stop').disabled);
  assert.match(await page.getByTestId('run-status').textContent(), /出力上限で停止/);
  assert.equal(await page.getByTestId('comparison-status').textContent(), '判定なし');
  assert.equal(await page.getByTestId('comparison-status').isDisabled(), true);
  assert.equal(Buffer.byteLength(await page.getByTestId('stdout').textContent()), 1048576);
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
});


test('M02/U2d: the app starts at home, runs Ruby without a problem and keeps home apart from problems', async () => {
  // Home is shared with the user's own data on Windows, so its files are put back afterwards.
  const home = path.join(app.dataDir, 'home');
  const original = await Promise.all(['solution.rb', 'cases.json'].map(name => readFile(path.join(home, name)).catch(() => null)));
  try {
    await page.reload();
    await waitInitialized(page);
    assert.equal(await page.locator('#home-icon').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#problem-title').textContent(), 'ホーム');
    assert.equal(await page.locator('#contest-title').textContent(), 'ホーム');
    assert.equal(await page.locator('.task-item').count(), 0);
    await page.waitForFunction(() => document.getElementById('browser-url').value === 'https://atcoder.jp/');
    for (const id of ['new', 'open', 'save', 'save-as', 'cases-open', 'cases-save']) assert.equal(await page.locator(`#${id}`).count(), 0, id);
    await page.locator('#code-editor').press('Control+o');
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.locator('#code-editor').fill('puts gets.to_i * 2');
    await page.locator('#stdin').fill('21\n');
    await runAndWait();
    assert.equal(await page.locator('#stdout').textContent(), '42\n');
    await waitSaved();
    assert.equal(await readFile(path.join(home, 'solution.rb'), 'utf8'), 'puts gets.to_i * 2');
    await openProblem(page, starterProblem);
    assert.equal(await page.locator('#home-icon').getAttribute('aria-pressed'), 'false');
    assert.equal(await editorText(page), sampleCode);
    await page.locator('#home-icon').click();
    await page.locator('#problem-title').filter({ hasText: /^ホーム$/ }).waitFor();
    assert.equal(await editorText(page), 'puts gets.to_i * 2');
    assert.equal(await page.locator('#stdin').inputValue(), '21\n');
    await page.waitForFunction(() => document.getElementById('browser-url').value === 'https://atcoder.jp/');
    // The contest's task pages stay open, so its tasks open again from the list.
    await page.locator(`#contest-icons .rail-icon[aria-label="テスト ${testContest}"]`).click();
    await selectTask(page, starterProblem);
    await page.locator('#problem-title').filter({ hasText: starterProblem.title }).waitFor();
  } finally {
    await mkdir(home, { recursive: true });
    for (const [index, name] of ['solution.rb', 'cases.json'].entries()) {
      if (original[index] === null) await rm(path.join(home, name), { force: true });
      else await writeFile(path.join(home, name), original[index]);
    }
  }
});

test('M08: an oversized solution fails to open and preserves the current problem and comparison', async () => {
  await page.getByTestId('code-editor').fill('puts "keep"');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('keep');
  await runAndWait();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  const large = await seedWorkspaceProblem(app, testContest, 'large', { code: 'a'.repeat(1048577) });
  await openProblem(page, starterProblem);
  await selectTask(page, large);
  await page.locator('#task-message').filter({ hasText: '1 MiB' }).waitFor();
  assert.equal(await page.locator('#problem-title').textContent(), starterProblem.title);
  assert.equal(await editorText(page), 'puts "keep"');
  assert.equal(await page.getByTestId('comparison-status').textContent(), '一致');
  await runAndWait();
  assert.equal(await page.getByTestId('stdout').textContent(), 'keep\n');
});

test('R01: a CRLF solution opens clean and remains unchanged on disk', async () => {
  const problem = await openStarter({ task: 'crlf', code: 'puts 1\r\nputs 2\r\n' });
  assert.equal(await editorText(page), 'puts 1\nputs 2\n');
  assert.equal(await page.getByTestId('save-state').getAttribute('data-state'), 'saved');
  await pause(1500);
  assert.equal(await readFile(problem.solution, 'utf8'), 'puts 1\r\nputs 2\r\n');
});

test('M11: switching problems resets the previous comparison', async () => {
  await page.getByTestId('code-editor').fill('puts 1; puts 2');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('1\n2\n');
  await runAndWait();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  await openStarter({ task: 'compare_other', code: 'puts 1\nputs 2\n', cases: [{ stdin: '', expectedOutput: '1\n2\n', compare: true }] });
  assert.equal(await page.getByTestId('comparison-status').textContent(), '未比較');
  await runAndWait();
  await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
});

test('R06: saving keeps comparison results, including a save during execution', async () => {
  const gate = path.join(root, 'continue.txt');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('code-editor').fill('puts "same"');
  for (const [expected, label] of [['same', '一致'], ['different', '不一致']]) {
    await page.getByTestId('expected-output').fill(expected);
    await runAndWait();
    await page.getByTestId('comparison-status').filter({ hasText: new RegExp(`^${label}$`) }).waitFor();
    await page.keyboard.press('Control+s');
    await waitSaved();
    assert.equal(await readFile(starterProblem.solution, 'utf8'), 'puts "same"');
    assert.equal(await page.getByTestId('comparison-status').textContent(), label);
  }
  await page.getByTestId('code-editor').fill(`puts "ready"; sleep 0.01 until File.exist?(${JSON.stringify(gate.replaceAll('\\', '/'))})`);
  await page.getByTestId('expected-output').fill('ready');
  try {
    await page.getByRole('button', { name: '実行', exact: true }).click();
    await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
    await page.keyboard.press('Control+s');
    await waitSaved();
    assert.equal(await page.getByTestId('comparison-status').textContent(), '比較中…');
    await writeFile(gate, 'continue');
    await page.getByTestId('comparison-status').filter({ hasText: /^一致$/ }).waitFor();
  } finally {
    await writeFile(gate, 'continue');
  }
});

test('M19: AtCoder gems run from a problem workspace with Japanese input', async () => {
  const code = await readFile(path.join(__dirname, '../fixtures/runtime-gems.rb'), 'utf8');
  const expected = await readFile(path.join(__dirname, '../fixtures/runtime-gems.txt'), 'utf8');
  await page.getByTestId('code-editor').fill(code);
  await page.locator('#stdin').fill('日本語\n');
  await page.locator('#compare-output').check();
  await page.locator('#expected-output').fill(expected);
  await runAndWait();
  assert.equal(await page.getByTestId('stdout').textContent(), expected);
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
});

test('M07/M12: each run uses a fresh temporary directory with the configured Ruby runtime', async () => {
  await page.getByTestId('code-editor').fill('require "json"; File.write("入力.json", {message: "日本語"}.to_json); puts JSON.parse(File.read("入力.json"))["message"]');
  await runAndWait();
  assert.equal(await page.getByTestId('stdout').textContent(), '日本語\n');
  await page.getByTestId('code-editor').fill('puts File.exist?("入力.json")');
  await runAndWait();
  assert.equal(await page.getByTestId('stdout').textContent(), 'false\n');
  await assert.rejects(access(path.join(starterProblem.workspace, '入力.json')), { code: 'ENOENT' });
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

test('M14: sample edits autosave to the workspace and are restored when the problem opens again', async () => {
  await page.getByTestId('code-editor').fill('puts STDIN.read');
  await page.getByTestId('stdin').fill('日本語\n');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).check();
  await page.getByTestId('expected-output').fill('');
  await addCase('two', 'ignored');
  await page.getByRole('checkbox', { name: '期待出力と比較' }).uncheck();
  await selectCase(1);
  await runAndWait();
  await waitSaved();
  assert.deepEqual(JSON.parse(await readFile(starterProblem.cases, 'utf8')), { cases: [{ stdin: '日本語\n', expectedOutput: '', compare: true }, { stdin: 'two', expectedOutput: 'ignored', compare: false }] });
  await page.reload();
  await waitInitialized(page);
  await openProblem(page, starterProblem);
  assert.equal(await page.getByTestId('stdin').inputValue(), '日本語\n');
  assert.equal(await page.getByTestId('stdout').textContent(), '');
  await selectCase(2);
  assert.equal(await page.getByTestId('expected-output').inputValue(), 'ignored');
  assert.equal(await page.getByTestId('expected-output').isDisabled(), true);
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
  await mismatch('one', 'ONE');
  await addCase('two', 'TWO');
  await runAndWait();
  await selectCase(1);
  await page.keyboard.press('Control+s');
  await waitSaved();
  assert.ok(JSON.parse(await readFile(starterProblem.cases, 'utf8')).cases.every(item => !('difference' in item)));
  await openDifference();
  assert.equal(await page.getByTestId('difference-actual').textContent(), 'one');
  await closeDifference();
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
  await page.setViewportSize({ width: 1280, height: 720 });
  try {
    await page.evaluate(() => { document.body.style.lineHeight = '1.8'; });
    await page.getByTestId('comparison-status').focus();
    await page.getByTestId('comparison-status').press('Enter');
    await page.getByRole('dialog').waitFor();
    const bounds = await page.getByRole('dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1280 && bounds.y + bounds.height <= 720);
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

test('P12: optional problem limits and per-case time warnings work offline at both window sizes', async () => {
  assert.equal(await page.locator('#problem-limits').count(), 1);
  assert.equal(await page.locator('#problem-limits').textContent(), '実行時間制限 不明 / メモリ制限 不明');
  assert.equal(await page.locator('#time-limit-warning').isVisible(), false);
  const samples = [{ stdin: '0', expectedOutput: 'ok\n'.repeat(1000) }, { stdin: '1.1', expectedOutput: 'ok\n'.repeat(1000) }];
  await openStarter({ task: 'limits', taskData: { samples, timeLimitMs: 1000, memoryLimitMiB: 1024 }, cases: samples.map(sample => ({ ...sample, compare: true })) });
  assert.equal(await page.locator('#problem-limits').textContent(), '実行時間制限 1 秒 / メモリ制限 1024 MiB');
  await page.locator('#code-editor').fill('sleep STDIN.read.to_f; 1000.times { puts "ok" }');
  await page.locator('#run-all').click();
  await page.locator('#cases-summary').filter({ hasText: /完了 2 \/ 2.*一致 2/ }).waitFor();
  assert.equal(await page.locator('#time-limit-warning').isVisible(), false);
  assert.match(await page.locator('#cases-summary').textContent(), /制限超過の可能性 1/);
  assert.match(await page.locator('#case-select option').nth(1).textContent(), /制限超過の可能性/);
  await selectCase(2);
  assert.equal(await page.locator('#time-limit-warning').textContent(), '制限超過の可能性（問題の制限 1 秒）');
  assert.equal(await page.locator('#time-limit-warning').isVisible(), true);
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    await page.addStyleTag({ content: '#problem-limits, .run-summary { line-height: 24px; }' });
    await assertWorkspaceFits();
    await page.screenshot({ path: `test-results/problem-limits-${width}.png` });
  }
  await page.locator('#stdin').fill('0');
  assert.equal(await page.locator('#time-limit-warning').isVisible(), false);
  assert.doesNotMatch(await page.locator('#cases-summary').textContent(), /制限超過の可能性/);
  await runAndWait();
  assert.equal(await page.locator('#time-limit-warning').isVisible(), false);
  await page.locator('#code-editor').fill('puts "ready"; sleep 30');
  await page.locator('#run').click();
  await page.locator('#stdout').filter({ hasText: 'ready' }).waitFor();
  await page.locator('#stop').click();
  await page.locator('#run-status').filter({ hasText: '停止しました' }).waitFor();
  assert.equal(await page.locator('#time-limit-warning').isVisible(), false);
});

test('P14: long problem runs receive their budget before output and keep per-case limits', async () => {
  const samples = [{ stdin: '6', expectedOutput: 'ok\n' }, { stdin: '0', expectedOutput: 'ok\n' }];
  await openStarter({ task: 'long_execution', taskData: { samples, timeLimitMs: 8000, memoryLimitMiB: 1024 }, cases: samples.map(sample => ({ ...sample, compare: true })) });
  assert.equal(await page.locator('#execution-limit').count(), 1);
  assert.equal(await page.locator('#execution-limit').textContent(), '実行上限 5〜30 秒');
  await page.locator('#code-editor').fill('sleep STDIN.read.to_f; puts :ok');
  await page.locator('#run-all').click();
  await page.locator('#execution-limit').filter({ hasText: '実行時上限 9 秒' }).waitFor();
  assert.equal(await page.locator('#stdout').textContent(), '');
  await page.locator('#cases-summary').filter({ hasText: /完了 2 \/ 2.*一致 2/ }).waitFor({ timeout: 12000 });
  assert.equal(await page.locator('#time-limit-warning').isVisible(), false);
  await selectCase(2);
  assert.equal(await page.locator('#execution-limit').textContent(), '実行時上限 9 秒');
  await page.locator('#code-editor').fill('puts :ready; sleep 30');
  await page.locator('#run').click();
  await page.locator('#stdout').filter({ hasText: 'ready' }).waitFor();
  await page.locator('#stop').click();
  await page.locator('#run-status').filter({ hasText: '停止しました' }).waitFor();
  assert.equal(await page.locator('#execution-limit').textContent(), '実行時上限 9 秒');
  await page.evaluate(async () => {
    const { ide } = await import('./bridge.mjs');
    ide.run = async (code, stdin, expectedOutput, tolerance, problemTimeLimitMs, notify) => {
      if (problemTimeLimitMs !== 8000) throw new Error('run did not use the problem limit');
      notify({ type: 'started', executionLimitMs: 30000 });
      return { status: 'timeout', stdout: '', stderr: '', exitCode: 1, durationMs: 30001, executionLimitMs: 30000, comparison: null, difference: null, errorLine: null };
    };
  });
  await runAndWait('時間制限で停止');
  assert.equal(await page.locator('#run-status').textContent(), '時間制限で停止（30 秒）');
  assert.equal(await page.locator('#execution-limit').textContent(), '実行時上限 30 秒');
  assert.equal(await page.locator('#comparison-status').textContent(), '判定なし');
  assert.match(await page.locator('#case-select option').nth(1).textContent(), /30 秒/);
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    await assertWorkspaceFits();
    const right = await page.locator('#execution-limit').evaluate(element => element.getBoundingClientRect().right);
    assert.ok(right <= width);
    await page.screenshot({ path: `test-results/execution-limit-${width}.png` });
  }
  await selectCase(1);
  assert.equal(await page.locator('#execution-limit').textContent(), '実行時上限 9 秒');
  await selectCase(2); await page.locator('#clear-output').click();
  assert.equal(await page.locator('#execution-limit').textContent(), '実行上限 5〜30 秒');
});

const railIcon = contest => page.locator(`#contest-icons .rail-icon[aria-label="テスト ${contest}"]`);

test('M17/M18: a registered contest lists its tasks in official order and the four columns fit 1280x720', async () => {
  const contest = `${testContest}-list`;
  const first = await seedWorkspaceProblem(app, contest, 'list_b', { label: 'A', title: '最初' });
  await seedWorkspaceProblem(app, contest, 'list_a', { label: 'B', title: '次' });
  await page.locator('#contest-add').click();
  await page.locator('#contest-url').fill(`https://atcoder.jp/contests/${contest}`);
  await page.locator('#contest-register').click();
  await page.waitForFunction(() => !document.querySelector('dialog[open]'));
  assert.equal(await railIcon(contest).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await page.locator('.task-item .task-label').allTextContents(), ['A', 'B']);
  assert.equal(await page.locator('#problem-title').textContent(), starterProblem.title);
  await selectTask(page, first);
  await page.locator('#problem-title').filter({ hasText: 'A - 最初' }).waitFor();
  assert.equal(await page.locator(`.task-item[data-url="${first.url}"]`).getAttribute('aria-current'), 'true');
  const saved = JSON.parse(await readFile(path.join(app.dataDir, 'contests', `${contest}.json`), 'utf8'));
  assert.deepEqual(saved.tasks.map(task => task.label), ['A', 'B']);
  await page.setViewportSize({ width: 1280, height: 720 });
  const columns = await page.evaluate(() => ['contest-rail', 'task-list', 'editor-host', 'browser-host'].map(id => document.getElementById(id).getBoundingClientRect().width));
  assert.ok(columns.every(width => width > 30), JSON.stringify(columns));
  assert.ok(columns[3] >= 300, JSON.stringify(columns));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await assertWorkspaceFits();
  await page.screenshot({ path: 'test-results/contest-columns-1280.png' });
});

test('M18: each task has its own page, pages close with the contest and the memory use is reported', { skip: runner !== 'native' && 'needs the WebView2 child pages' }, async () => {
  const contest = `${testContest}-memory`;
  const problems = [];
  for (const label of 'ABCDEFGH') problems.push(await seedWorkspaceProblem(app, contest, `memory_${label.toLowerCase()}`, { label, page: { samples: [['1\n', '1\n']] } }));
  const taskPages = () => app.browser.contexts()[0].pages().filter(candidate => candidate.url().startsWith(`${app.atcoder.origin}/contests/${contest}/tasks/`));
  const waitPages = async count => {
    const deadline = Date.now() + 15000;
    while (taskPages().length !== count) {
      if (Date.now() > deadline) throw new Error(`expected ${count} task pages, got ${taskPages().length}`);
      await pause(200);
    }
  };
  await openProblem(page, problems[0]);
  for (const problem of problems.slice(1)) {
    await selectTask(page, problem);
    await page.locator('#problem-title').filter({ hasText: problem.title }).waitFor();
  }
  await waitPages(8);
  const open = await memoryUse(app);
  await page.locator(`#contest-icons .rail-icon[aria-label="テスト ${testContest}"]`).click();
  await waitPages(0);
  console.log(JSON.stringify({ taskPages: 8, open, closed: await memoryUse(app) }));
  assert.ok(open.processes > 1, JSON.stringify(open));
});

const LAYOUT_KEY = 'atcoder-ide-layout';
const paneSizes = () => page.evaluate(() => Object.fromEntries(Object.entries({ rail: '#contest-rail', tasks: '.task-panel', center: '.workspace', browser: '.browser-column', editor: '.editor-panel', input: '.input-panel', icon: '.rail-icon' })
  .map(([name, selector]) => { const rect = document.querySelector(selector).getBoundingClientRect(); return [name, { width: rect.width, height: rect.height }]; })));
async function drag(name, dx, dy) {
  const box = await page.locator(`.splitter[data-split="${name}"]`).boundingBox();
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 2, `${label}: ${actual} != ${expected}`);

test('U2c: dragging the borders resizes every pane, scales the icons, survives a reload and double-click restores it', async () => {
  try {
    const before = await paneSizes();
    near(before.icon.width, before.rail.width - 16, 'icon at the default width');
    // Each drag moves its border by the pointer's distance, measured from the panes just before it.
    for (const [name, dx, dy, pane, dimension, change] of [
      ['rail', 24, 0, 'rail', 'width', 24], ['tasks', 40, 0, 'tasks', 'width', 40], ['browser', -40, 0, 'browser', 'width', 40],
      ['editor', 0, -60, 'editor', 'height', -60], ['input', -20, 0, 'input', 'width', -20]
    ]) {
      const start = (await paneSizes())[pane][dimension];
      await drag(name, dx, dy);
      near((await paneSizes())[pane][dimension], start + change, name);
    }
    const after = await paneSizes();
    near(after.icon.width, after.rail.width - 16, 'icon follows the rail');
    const accept = dialog => dialog.accept();
    page.on('dialog', accept);
    try { await page.reload(); } finally { page.off('dialog', accept); }
    await waitInitialized(page);
    const restored = await paneSizes();
    for (const name of ['rail', 'tasks', 'browser', 'editor', 'input']) near(restored[name].width, after[name].width, `${name} after reload`);
    near(restored.editor.height, after.editor.height, 'editor height after reload');
    await page.setViewportSize({ width: 1280, height: 720 });
    const small = await paneSizes();
    assert.ok(small.center.width >= 480 && small.browser.width >= 360, JSON.stringify(small));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1280, height: 850 });
    for (const name of ['rail', 'tasks', 'browser', 'editor', 'input']) await page.locator(`.splitter[data-split="${name}"]`).dblclick();
    const reset = await paneSizes();
    for (const name of ['rail', 'tasks', 'browser', 'input']) near(reset[name].width, before[name].width, `${name} reset`);
    near(reset.editor.height, before.editor.height, 'editor reset');
  } finally {
    await page.evaluate(key => localStorage.removeItem(key), LAYOUT_KEY);
  }
});

test('U2c: the URL field follows the shown page and opens only AtCoder pages', async () => {
  const field = page.locator('#browser-url');
  const showing = url => page.waitForFunction(expected => document.getElementById('browser-url').value === expected, url);
  await showing(starterProblem.url);
  await field.fill('https://example.com/');
  await field.press('Enter');
  await page.locator('#browser-message').filter({ hasText: 'https://atcoder.jp' }).waitFor();
  const list = `https://atcoder.jp/contests/${testContest}/tasks`;
  await field.fill(list.replace('https://', ''));
  await field.press('Enter');
  await showing(list);
  assert.equal(await page.locator('#browser-message').textContent(), '');
  if (runner !== 'native') return; // The test host has no pages to go back and forward in.
  await page.locator('#browser-back').click();
  await showing(starterProblem.url);
  await page.locator('#browser-forward').click();
  await showing(list);
  const loads = () => app.atcoder.requests.filter(request => request === `/contests/${testContest}/tasks`).length;
  const count = loads();
  await page.locator('#browser-reload').click();
  const deadline = Date.now() + 10000;
  while (loads() === count) {
    assert.ok(Date.now() < deadline, 'reload did not request the page again');
    await pause(100);
  }
});

test('M16: a task without saved data is read from its page with samples and limits', async () => {
  const problem = await seedWorkspaceProblem(app, testContest, 'read_page', { task: null, code: null, cases: null, page: { samples: [['1 2\n', '3\n'], ['10 20\n', '30\n']], timeLimit: '2 sec', memoryLimit: '256 MiB' } });
  await openProblem(page, problem);
  assert.equal(await page.locator('#stdin').inputValue(), '1 2\n');
  assert.equal(await page.locator('#expected-output').inputValue(), '3\n');
  assert.equal(await page.locator('#compare-output').isChecked(), true);
  assert.equal(await page.locator('#case-count').textContent(), '2 ケース');
  assert.equal(await page.locator('#problem-limits').textContent(), '実行時間制限 2 秒 / メモリ制限 256 MiB');
  const task = JSON.parse(await readFile(path.join(problem.workspace, 'task.json'), 'utf8'));
  assert.deepEqual(task, { url: problem.url, samples: [{ stdin: '1 2\n', expectedOutput: '3\n' }, { stdin: '10 20\n', expectedOutput: '30\n' }], timeLimitMs: 2000, memoryLimitMiB: 256 });
  await page.locator('#code-editor').fill('puts STDIN.read.split.map(&:to_i).sum');
  await page.locator('#run-all').click();
  await page.locator('#cases-summary').filter({ hasText: /完了 2 \/ 2.*一致 2/ }).waitFor();
});

test('M16: a page that needs login asks to log in and opens once the page can be read', async () => {
  const problem = await seedWorkspaceProblem(app, testContest, 'needs_login', { task: null, code: null, cases: null });
  await page.locator('#contest-add').click();
  await page.locator('#contest-url').fill(problem.url);
  await page.locator('#contest-register').click();
  await page.locator('#task-message').filter({ hasText: 'ログイン' }).waitFor();
  assert.equal(await page.locator('#problem-title').textContent(), starterProblem.title);
  await assert.rejects(access(path.join(problem.workspace, 'task.json')), { code: 'ENOENT' });
  app.atcoder.pages.set(`/contests/${testContest}/tasks/needs_login`, taskPage({ samples: [['x\n', 'x\n']] }));
  await selectTask(page, problem);
  await page.locator('#problem-title').filter({ hasText: problem.title }).waitFor();
  assert.equal(await page.locator('#stdin').inputValue(), 'x\n');
});

test('M17: contest icons can be hidden and restored from the rail', async () => {
  const icon = railIcon(testContest);
  await icon.click({ button: 'right' });
  await page.getByRole('menuitem', { name: /非表示にする/ }).click();
  await icon.waitFor({ state: 'detached' });
  assert.equal(JSON.parse(await readFile(path.join(app.dataDir, 'contests', `${testContest}.json`), 'utf8')).hidden, true);
  assert.equal(await page.locator('#problem-title').textContent(), starterProblem.title);
  await page.locator('#contest-rail').click({ button: 'right', position: { x: 28, y: 300 } });
  await page.getByRole('menuitem', { name: /表示する/ }).click();
  await icon.waitFor();
  assert.equal(JSON.parse(await readFile(path.join(app.dataDir, 'contests', `${testContest}.json`), 'utf8')).hidden, false);
  await workspaceStillOpen();
});
async function workspaceStillOpen() {
  await runAndWait();
  assert.equal(await page.locator('#stdout').textContent(), '6 test\n');
}

test('T01: tolerant comparison keeps exact whitespace, separate columns and saved per-case settings', async () => {
  await openStarter({ task: 'tolerance', cases: [{ stdin: '1 2\n', expectedOutput: '3\n', compare: true }, { stdin: '10 20\n', expectedOutput: '30\n', compare: true }] });
  assert.equal(await page.locator('#tolerant-compare').count(), 1);
  assert.equal(await page.locator('#tolerant-compare').isChecked(), false);
  await page.locator('#code-editor').fill('puts "0.500 日😀A"');
  await page.locator('#expected-output').fill('0.5 日😀B');
  await page.locator('#tolerant-compare').check();
  assert.equal(Number(await page.locator('#tolerance').inputValue()), 1e-6);
  await runAndWait();
  await page.locator('#comparison-status').click();
  assert.match(await page.locator('#difference-position').textContent(), /実際 9 列.*期待 7 列/);
  assert.equal(await page.locator('#difference-actual mark').textContent(), 'A');
  assert.equal(await page.locator('#difference-expected mark').textContent(), 'B');
  await page.locator('#difference-close').click();
  await page.locator('#expected-output').fill('0.5 日😀A');
  await runAndWait();
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
  await page.locator('#expected-output').fill('0.5  日😀A');
  await runAndWait();
  assert.equal(await page.locator('#comparison-status').textContent(), '不一致');
  await page.locator('#expected-output').fill('0.5 日😀A');
  await page.locator('#tolerance').fill('0');
  await runAndWait('実行できませんでした');
  assert.match(await page.locator('#stderr').textContent(), /許容誤差/);
  await page.locator('#tolerance').fill('1e-9');
  await waitSaved();
  const saved = JSON.parse(await readFile(starterProblem.cases, 'utf8'));
  assert.equal(saved.cases[0].tolerance, 1e-9);
  assert.equal(saved.cases[1].tolerance, undefined);
  await selectCase(2);
  assert.equal(await page.locator('#tolerant-compare').isChecked(), false);
  await selectCase(1);
  assert.equal(Number(await page.locator('#tolerance').inputValue()), 1e-9);
  await runAndWait();
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => { document.body.style.lineHeight = '1.8'; });
    await assertWorkspaceFits();
    await page.screenshot({ path: `test-results/tolerance-${width}.png` });
  }
  await page.locator('#code-editor').fill('sleep 0.3; puts "0.500 日😀A"');
  await page.locator('#run').click();
  await page.locator('#tolerance').fill('1e-6');
  await page.waitForFunction(() => document.getElementById('stop').disabled);
  assert.equal(await page.locator('#comparison-status').textContent(), '未比較');
});

test('T02: mixed strict and tolerant cases are restored and invalid input is never saved as strict', async () => {
  const data = { cases: [
    { stdin: '1.0000001', expectedOutput: '1', compare: true, tolerance: 1e-6 },
    { stdin: '1.0000001', expectedOutput: '1', compare: true },
  ] };
  await openStarter({ task: 'tolerance_mixed', code: 'print STDIN.read', cases: data.cases });
  await page.locator('#run-all').click();
  await page.locator('#cases-summary').filter({ hasText: /完了 2 \/ 2.*一致 1.*不一致 1/ }).waitFor();
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
  await selectCase(2);
  assert.equal(await page.locator('#comparison-status').textContent(), '不一致');
  assert.equal(await page.locator('#tolerant-compare').isChecked(), false);
  await selectCase(1);
  await page.locator('#tolerance').fill('');
  await waitSaveFailed();
  assert.match(await page.locator('#save-state').getAttribute('title'), /許容誤差/);
  assert.deepEqual(JSON.parse(await readFile(starterProblem.cases, 'utf8')), data);
  assert.equal(await page.locator('#tolerant-compare').isChecked(), true);
  assert.equal(await page.locator('#tolerance').inputValue(), '');
  await page.locator('#tolerance').fill('1e-6');
  await page.locator('#compare-output').uncheck();
  assert.equal(await page.locator('#tolerance').isDisabled(), true);
  await waitSaved();
  assert.equal(JSON.parse(await readFile(starterProblem.cases, 'utf8')).cases[0].tolerance, 1e-6);
  await openProblem(page, starterProblem);
  assert.equal(await page.locator('#tolerant-compare').isChecked(), true);
  assert.equal(await page.locator('#tolerance').isDisabled(), true);
  await page.locator('#compare-output').check();
  assert.equal(await page.locator('#tolerance').isEnabled(), true);
  await runAndWait();
  assert.equal(await page.locator('#comparison-status').textContent(), '一致');
});
test('M06/M09: accepting close stops Ruby descendants and exits', async () => {
  const marker = path.join(root, 'orphan.txt').replaceAll('\\', '/');
  await page.getByTestId('code-editor').fill(`require 'rbconfig'; spawn(RbConfig.ruby, '-e', 'sleep 2; File.write(${JSON.stringify(marker)}, "survived")'); puts 'ready'; sleep 30`);
  await page.getByRole('button', { name: '実行', exact: true }).click();
  await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
  const exited = once(app.child, 'exit', { signal: AbortSignal.timeout(30000) });
  await Promise.all([exited, requestClose(app)]);
  await pause(2200);
  await assert.rejects(access(marker), { code: 'ENOENT' });
});

});
