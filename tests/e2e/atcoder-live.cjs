// Explicit live check: excluded from the ordinary offline *.test.cjs suite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { launch, close } = require('./browser.cjs');

test('AtCoder live: import legacy problem, run every sample, save, refresh and reopen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'AtCoder live '));
  let app;
  try {
    app = await launch(root);
    const page = app.page;
    const url = 'https://atcoder.jp/contests/abc001/tasks/abc001_1';
    async function openProblem() {
      await page.locator('#problem-library').click();
      await page.locator('#problem-url').fill(url);
      await page.locator('#problem-open').click();
      await page.waitForFunction(() => !document.getElementById('problem-open').disabled);
      assert.equal(await page.locator('#problem-title').textContent(), 'A - 積雪深差', await page.locator('#problem-message').textContent());
      assert.match(await page.locator('#problem-statement').textContent(), /積雪深/);
      assert.equal(await page.locator('#problem-dialog').isVisible(), false);
    }
    await openProblem();
    assert.equal(await page.locator('#case-count').textContent(), '3 ケース');
    const code = 'puts gets.to_i - gets.to_i';
    await page.locator('#code-editor').fill(code);
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    await page.locator('#run-all').click();
    await page.locator('#cases-summary').filter({ hasText: /完了 3 \/ 3.*一致 3.*不一致 0.*エラー 0/ }).waitFor();
    await page.locator('#case-select').selectOption('0');
    await page.locator('#stdin').fill('30\n10\n');
    await page.locator('#expected-output').fill('20\n');
    await page.locator('#cases-save').click();
    await page.waitForFunction(() => !document.getElementById('cases-save').disabled);
    const workspace = path.join(app.dataDir, 'workspaces/abc001/abc001_1');
    assert.equal(await readFile(path.join(workspace, 'solution.rb'), 'utf8'), code);
    const savedCases = await readFile(path.join(workspace, 'cases.json'), 'utf8');
    await page.locator('#problem-library').click();
    await page.locator('#problem-refresh').click();
    await page.waitForFunction(() => !document.getElementById('problem-refresh').disabled);
    assert.match(await page.locator('#problem-message').textContent(), /問題文と元のサンプルを更新しました/);
    await page.locator('#problem-close').click();
    assert.equal(await readFile(path.join(workspace, 'cases.json'), 'utf8'), savedCases);
    assert.equal(await page.locator('#stdin').inputValue(), '30\n10\n');
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('run').disabled);
    await openProblem();
    assert.equal(await page.locator('#code-editor').inputValue(), code);
    assert.equal(await page.locator('#stdin').inputValue(), '30\n10\n');
    assert.equal(await page.locator('#expected-output').inputValue(), '20\n');
    await page.locator('#run-all').click();
    await page.locator('#cases-summary').filter({ hasText: /完了 3 \/ 3.*一致 3/ }).waitFor();
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/atcoder-live.png' });
  } finally {
    if (app) await close(app);
    await rm(root, { recursive: true, force: true });
  }
});
