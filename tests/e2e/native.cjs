const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { writeFile, mkdir, realpath } = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright');
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const system = name => path.join(process.env.SystemRoot, 'System32', name);

async function launch(root) {
  assert.equal(process.platform, 'win32', 'Native GUI tests require Windows');
  const executable = path.resolve(process.env.APP_EXE);
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const env = { ...process.env };
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
    page = context.pages()[0] || await context.waitForEvent('page');
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => console.error('WebView error:', error));
    await page.getByTestId('ruby-version').filter({ hasText: /ruby \d+\.\d+\.\d+\b/i }).waitFor();
    const ruby = await page.evaluate(() => window.__TAURI__.core.invoke('ruby_info'));
    assert.equal(ruby.version.match(/^ruby (\d+\.\d+\.\d+)\b/i)?.[1], require('../../config/ruby-windows.json').rubyVersion);
    const canonical = value => path.toNamespacedPath(path.resolve(value)).toLowerCase();
    assert.equal(canonical(await realpath(ruby.path)), canonical(await realpath(path.join(path.dirname(executable), 'ruby', 'bin', 'ruby.exe'))));
    console.log(JSON.stringify({ executable, ruby, systemRubyAvailable: false }));
    return { child, browser, page, root, dataDir: path.join(process.env.LOCALAPPDATA, require('../../src-tauri/tauri.conf.json').identifier), dialogSequence: 0 };
  } catch (error) {
    if (page) {
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/startup-failure.png' }).catch(() => {});
      log += await page.locator('body').textContent().catch(() => '');
    }
    await execute(system('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F']).catch(() => {});
    await browser?.close().catch(() => {});
    throw new Error(`${error.message}\n${log}`, { cause: error });
  }
}

async function dialogs(app, trigger, steps, closesApp = false) {
  const request = path.join(app.root, `dialog-${++app.dialogSequence}.json`);
  await writeFile(request, JSON.stringify({ processId: app.child.pid, steps }), 'utf8');
  const automation = execute(system('WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native-dialog.ps1'), '-RequestFile', request
  ], { timeout: 60000, maxBuffer: 1024 * 1024 });
  try {
    await Promise.all([automation, trigger()]);
    if (!closesApp) await app.page.waitForFunction(() => !document.getElementById('open').disabled);
  } catch (error) {
    await mkdir('test-results', { recursive: true });
    await app.page.screenshot({ path: `test-results/dialog-failure-${app.dialogSequence}.png` }).catch(() => {});
    throw error;
  }
}

const discard = accept => ({ title: '未保存の変更', buttonName: accept ? '破棄して続ける' : 'キャンセル' });
const open = file => ({ title: 'Ruby ファイルを開く', path: file, buttonId: '1' });
const save = file => ({ title: 'Ruby ファイルを保存', path: file, buttonId: '1' });
const cancelSave = () => ({ title: 'Ruby ファイルを保存', buttonId: '2' });
const overwrite = () => ({ title: 'Confirm Save As', keys: '%y' });

async function close(app) {
  if (app.child.exitCode === null) await execute(system('taskkill.exe'), ['/PID', String(app.child.pid), '/T', '/F']).catch(() => {});
  await app.browser.close().catch(() => {});
}
async function requestClose(app) {
  await execute(system('WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-Command',
    `$appProcess = [System.Diagnostics.Process]::GetProcessById(${app.child.pid}); if (!$appProcess.CloseMainWindow()) { throw 'Cannot close the app window' }`
  ]);
}

module.exports = { requestClose, launch, dialogs, discard, open, save, cancelSave, overwrite, close, pause };
