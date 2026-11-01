const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { writeFile, mkdir, realpath } = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright');
const { startAtCoder } = require('./atcoder-fixture.cjs');
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const system = name => path.join(process.env.SystemRoot, 'System32', name);

async function launch(root, { hostEnv = {} } = {}) {
  assert.equal(process.platform, 'win32', 'Native GUI tests require Windows');
  const executable = path.resolve(process.env.APP_EXE);
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const env = { ...process.env, ...hostEnv };
  for (const key of Object.keys(env)) {
    if (['PATH', 'RUBY_PATH', 'RUBYOPT', 'RUBYLIB', 'BUNDLE_GEMFILE', 'GEM_HOME', 'GEM_PATH'].includes(key.toUpperCase())) delete env[key];
  }
  env.Path = `${path.join(process.env.SystemRoot, 'System32')};${process.env.SystemRoot}`;
  env.RUBY_PATH = 'C:\\no-system-ruby\\ruby.exe';
  env.GEM_HOME = path.join(root, 'external-gems');
  env.GEM_PATH = env.GEM_HOME;
  await mkdir(env.GEM_HOME, { recursive: true });
  await writeFile(path.join(env.GEM_HOME, 'json.rb'), 'raise "external json.rb was loaded"\n');
  env.RUBYOPT = '-ride_external_startup_library';
  env.RUBYLIB = env.GEM_HOME;
  env.BUNDLE_GEMFILE = path.join(env.GEM_HOME, 'missing-Gemfile');
  env.ATCODER_IDE_TEST_PORT = String(port);
  const atcoder = await startAtCoder();
  env.ATCODER_IDE_TEST_ORIGIN = atcoder.origin;
  env.NO_PROXY = '127.0.0.1'; // Tests that block the proxy still reach the local AtCoder server.
  env.WEBVIEW2_USER_DATA_FOLDER = path.join(root, 'webview-profile');
  await assert.rejects(execute(system('where.exe'), ['ruby'], { env }), error => error.code === 1);
  const child = spawn(executable, [], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  child.on('error', error => { log += error.message; });
  let browser;
  let page;
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`App exited: ${child.exitCode}\n${log}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch {}
      await pause(200);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    // Child webviews show AtCoder pages; the app is the page served from tauri.localhost.
    const isApp = candidate => candidate.url().includes('tauri.localhost');
    page = context.pages().find(isApp) || await context.waitForEvent('page', { predicate: isApp });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => console.error('WebView error:', error));
    await page.getByTestId('ruby-version').filter({ hasText: /ruby \d+\.\d+\.\d+\b/i }).waitFor();
    const ruby = await page.evaluate(() => window.__TAURI__.core.invoke('ruby_info'));
    assert.equal(ruby.version.match(/^ruby (\d+\.\d+\.\d+)\b/i)?.[1], require('../../config/ruby-windows.json').rubyVersion);
    const rubyExecutable = await page.evaluate(async () => {
      const { ide } = await import('./bridge.mjs');
      const result = await ide.run('require "rbconfig"; puts File.realpath(RbConfig.ruby)', '');
      if (result.status !== 'completed') throw new Error(`Bundled Ruby probe failed: ${result.stderr}`);
      return result.stdout.trim();
    });
    const canonical = value => path.toNamespacedPath(path.resolve(value)).toLowerCase();
    assert.equal(canonical(await realpath(rubyExecutable)), canonical(await realpath(path.join(path.dirname(executable), 'ruby', 'bin', 'ruby.exe'))));
    console.log(JSON.stringify({ executable, ruby, rubyExecutable, systemRubyAvailable: false }));
    return { child, browser, page, root, atcoder, dataDir: path.join(process.env.LOCALAPPDATA, require('../../src-tauri/tauri.conf.json').identifier) };
  } catch (error) {
    if (page) {
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/startup-failure.png' }).catch(() => {});
      log += await page.locator('body').textContent().catch(() => '');
    }
    await execute(system('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
    await browser?.close().catch(() => {});
    await new Promise(resolve => atcoder.server.close(resolve));
    throw new Error(`${error.message}\n${log}`, { cause: error });
  }
}

async function close(app) {
  if (app.child.exitCode === null) await execute(system('taskkill.exe'), ['/PID', String(app.child.pid), '/T', '/F']).catch(() => {});
  await app.browser.close().catch(() => {});
  await new Promise(resolve => app.atcoder.server.close(resolve));
}
async function requestClose(app) {
  await execute(system('WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    `$appProcess = [System.Diagnostics.Process]::GetProcessById(${app.child.pid}); if (!$appProcess.CloseMainWindow()) { throw 'Cannot close the app window' }`
  ]);
}

// Sums the memory of the app and its descendants, which include the WebView2 processes.
async function memoryUse(app) {
  const script = `$all = Get-CimInstance Win32_Process; $ids = @(${app.child.pid}); do { $count = $ids.Count; $ids = @($ids + @($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object ProcessId) | Select-Object -Unique) } while ($ids.Count -gt $count); $tree = @($all | Where-Object { $ids -contains $_.ProcessId }); @{ processes = $tree.Count; workingSetMiB = [math]::Round(($tree | Measure-Object WorkingSetSize -Sum).Sum / 1MB); privateMiB = [math]::Round(($tree | Measure-Object PrivatePageCount -Sum).Sum / 1MB) } | ConvertTo-Json -Compress`;
  const { stdout } = await execute(system('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script]);
  return JSON.parse(stdout);
}

module.exports = { requestClose, launch, close, pause, memoryUse };
