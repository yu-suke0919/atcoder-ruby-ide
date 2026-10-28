const { editorText } = require('./editor.cjs');
// Explicit live check: excluded from the ordinary offline *.test.cjs suite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
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
    assert.equal(await editorText(page), code);
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

test('AtCoder live: download real images, enlarge, refresh and reopen without network access', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'AtCoder media live '));
  let app;
  let blockedRequests = 0;
  // This local proxy rejects every request; it never forwards to an external host.
  const offlineProxy = http.createServer((request, response) => {
    blockedRequests++;
    response.writeHead(503).end();
  });
  offlineProxy.on('connect', (request, socket) => {
    blockedRequests++;
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
  });
  const url = 'https://atcoder.jp/contests/abc243/tasks/abc243_c';
  async function openProblem() {
    const page = app.page;
    await page.locator('#problem-library').click();
    await page.locator('#problem-url').fill(url);
    await page.locator('#problem-open').click();
    await page.waitForFunction(() => !document.getElementById('problem-open').disabled);
    assert.equal(await page.locator('#problem-title').textContent(), 'C - Collision 2', await page.locator('#problem-message').textContent());
    assert.equal(await page.locator('#problem-dialog').isVisible(), false);
    await page.locator('#problem-statement img').first().waitFor();
    await page.locator('#problem-statement img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  }
  async function checkImages(images) {
    const rendered = await app.page.locator('#problem-statement img').evaluateAll(elements => elements.map(image => ({
      data: image.getAttribute('src'), width: image.naturalWidth, height: image.naturalHeight,
    })));
    assert.deepEqual(rendered, images.map(({ data, width, height }) => ({ data, width, height })));
    assert.ok(await app.page.locator('#problem-statement .katex').count() > 0);
  }
  try {
    await new Promise(resolve => offlineProxy.listen(0, '127.0.0.1', resolve));
    app = await launch(root);
    await openProblem();
    const page = app.page;
    const cachePath = path.join(app.dataDir, 'library/problems/abc243/abc243_c/problem.json');
    const problem = JSON.parse(await readFile(cachePath, 'utf8'));
    const images = problem.statement.filter(part => part.type === 'image');
    assert.ok(images.length > 0);
    for (const image of images) {
      assert.equal(new URL(image.url).hostname, 'img.atcoder.jp');
      assert.match(image.data, /^data:image\/png;base64,/);
      assert.ok(image.width > 0 && image.height > 0);
    }
    await checkImages(images);
    await mkdir('test-results', { recursive: true });
    for (const [width, height] of [[1440, 900], [900, 650]]) {
      await page.setViewportSize({ width, height });
      for (const image of await page.locator('#problem-statement img').all()) {
        assert.ok(await image.evaluate(element => element.getBoundingClientRect().width <= element.parentElement.clientWidth));
      }
      await page.locator('.statement-image').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/atcoder-media-live-${width}.png` });
      await page.locator('.statement-image').first().click();
      assert.equal(await page.locator('#image-dialog').isVisible(), true);
      await page.locator('#image-preview').evaluate(image => image.decode());
      assert.equal(await page.locator('#image-preview').getAttribute('src'), images[0].data);
      await page.screenshot({ path: `test-results/atcoder-media-live-preview-${width}.png` });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#image-dialog').isVisible(), false);
    }
    const code = 'puts "saved media workspace"';
    await page.locator('#code-editor').fill(code);
    await page.locator('#save').click();
    await page.waitForFunction(() => !document.getElementById('save').disabled);
    await page.locator('#stdin').fill('saved media case\n');
    await page.locator('#cases-save').click();
    await page.waitForFunction(() => !document.getElementById('cases-save').disabled);
    const workspace = path.join(app.dataDir, 'workspaces/abc243/abc243_c');
    const savedCases = await readFile(path.join(workspace, 'cases.json'), 'utf8');
    await page.locator('#problem-library').click();
    await page.locator('#problem-refresh').click();
    await page.waitForFunction(() => !document.getElementById('problem-refresh').disabled);
    assert.match(await page.locator('#problem-message').textContent(), /問題文と元のサンプルを更新しました/);
    await page.locator('#problem-close').click();
    await checkImages(images);
    const savedCache = await readFile(cachePath, 'utf8');
    assert.equal(await editorText(page), code);
    assert.equal(await page.locator('#stdin').inputValue(), 'saved media case\n');
    assert.equal(await readFile(path.join(workspace, 'cases.json'), 'utf8'), savedCases);

    await close(app);
    app = null;
    const proxy = `http://127.0.0.1:${offlineProxy.address().port}`;
    app = await launch(root, { hostEnv: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: '' } });
    await app.page.context().setOffline(true);
    await openProblem();
    await checkImages(images);
    assert.equal(blockedRequests, 0, 'Opening the saved problem must not attempt any network request');
    assert.equal(await editorText(app.page), code);
    assert.equal(await app.page.locator('#stdin').inputValue(), 'saved media case\n');
    await app.page.locator('.statement-image').first().click();
    await app.page.locator('#image-preview').evaluate(image => image.decode());
    assert.equal(await app.page.locator('#image-preview').getAttribute('src'), images[0].data);
    await app.page.screenshot({ path: 'test-results/atcoder-media-offline-preview.png' });
    await app.page.keyboard.press('Escape');
    await app.page.locator('#problem-library').click();
    await app.page.locator('#problem-refresh').click();
    await app.page.waitForFunction(() => !document.getElementById('problem-refresh').disabled);
    assert.ok(blockedRequests > 0, 'The Rust host must use the rejecting proxy for a refresh');
    assert.match(await app.page.locator('#problem-message').textContent(), /問題を取得できません/);
    assert.equal(await readFile(cachePath, 'utf8'), savedCache);
    assert.equal(await readFile(path.join(workspace, 'solution.rb'), 'utf8'), code);
    assert.equal(await readFile(path.join(workspace, 'cases.json'), 'utf8'), savedCases);
    await app.page.locator('#problem-close').click();
    await checkImages(images);
    console.log(JSON.stringify({ liveMedia: url, images: images.map(({ url, data, width, height }) => ({
      url, bytes: Buffer.from(data.split(',')[1], 'base64').length, width, height,
    })), offlineRefreshBlocked: blockedRequests }));
  } finally {
    if (app) await close(app);
    await new Promise(resolve => offlineProxy.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
