const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtemp, rm, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createServer } = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright');

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function verify(executable, screenshot) {
  const profile = await mkdtemp(path.join(tmpdir(), 'tauri-size-webview-'));
  const port = await freePort();
  const app = spawn(executable, [], { env: { ...process.env,
    RUBY_PATH: 'C:\\missing-ruby-for-size-probe.exe',
    WEBVIEW2_USER_DATA_FOLDER: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
  }, stdio: 'inherit' });
  let browser;
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (app.exitCode !== null) throw new Error(`Tauri exited: ${app.exitCode}`);
      try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) break; } catch {}
      if (attempt === 149) throw new Error('WebView2 CDP connection timed out');
      await delay(200);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page;
    for (let attempt = 0; attempt < 100; attempt++) {
      page = browser.contexts().flatMap(context => context.pages()).find(page => /tauri/.test(page.url()));
      if (page) break;
      await delay(100);
    }
    assert.ok(page, 'Tauri page must be available');
    await page.getByTestId('ruby-version').filter({ hasText: /ruby 3\.4\.12/i }).waitFor({ timeout: 15000 });
    const info = await page.evaluate(() => window.__TAURI__.core.invoke('ruby_info'));
    assert.equal(path.resolve(info.path).toLowerCase(), path.resolve(path.dirname(executable), 'ruby/bin/ruby.exe').toLowerCase());
    const run = async code => {
      if (code !== undefined) await page.getByTestId('code-editor').fill(code);
      await page.getByRole('button', { name: '実行', exact: true }).click();
    };
    await run();
    await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
    assert.equal(await page.getByTestId('stdout').textContent(), '6 test\n');
    await page.screenshot({ path: screenshot });
    await run('puts "日本語"; warn "標準エラー"');
    await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
    assert.equal(await page.getByTestId('stdout').textContent(), '日本語\n');
    assert.equal(await page.getByTestId('stderr').textContent(), '標準エラー\n');
    await run('puts "ready"; sleep 10');
    await page.getByTestId('stdout').filter({ hasText: 'ready' }).waitFor();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await page.getByTestId('run-status').filter({ hasText: '停止しました' }).waitFor();
    await run('puts 42');
    await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
    assert.equal(await page.getByTestId('stdout').textContent(), '42\n');
    await run('puts(');
    await page.getByTestId('run-status').filter({ hasText: 'エラー終了' }).waitFor();
    assert.match(await page.getByTestId('stderr').textContent(), /syntax|unexpected/i);
    console.log(`Verified sample, UTF-8 stdout/stderr, stop, rerun and syntax error with bundled Ruby: ${executable}`);
  } finally {
    if (app.exitCode === null) execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    if (browser) await browser.close().catch(() => {});
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

(async () => {
  const artifacts = path.join(__dirname, 'artifacts');
  await verify(path.join(artifacts, 'portable/tauri-size-probe.exe'), path.join(artifacts, 'portable.png'));
  const install = path.join(process.env.RUNNER_TEMP || tmpdir(), 'tauri-size-installed');
  execFileSync(path.join(artifacts, 'tauri-setup.exe'), ['/S', `/D=${install}`], { stdio: 'inherit' });
  const files = await readdir(install);
  console.log(`Installed files: ${files.join(', ')}`);
  await verify(path.join(install, 'tauri-size-probe.exe'), path.join(artifacts, 'installed.png'));
})().catch(error => { console.error(error); process.exitCode = 1; });
