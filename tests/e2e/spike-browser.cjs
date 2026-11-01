// U0 spike (not merged): run on Windows CI against the built app.
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdir, mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright');
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {};
const out = path.resolve('test-results', 'u0-spike');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function powershell(script) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-Command', script]);
  return stdout.trim();
}

async function denied(page, label) {
  return page.evaluate(async () => {
    const result = { internals: typeof window.__TAURI_INTERNALS__, tauri: typeof window.__TAURI__ };
    const attempt = async (cmd, args) => {
      try {
        const value = await window.__TAURI_INTERNALS__.invoke(cmd, args);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }
    };
    if (window.__TAURI_INTERNALS__) {
      result.ruby_info = await attempt('ruby_info');
      result.spike_fetch = await attempt('spike_fetch', { url: 'https://atcoder.jp/' });
      result.spike_read_dom = await attempt('spike_read_dom', { script: '1' });
      result.notify = await attempt('plugin:notification|notify', { options: { title: 'x', body: 'x' } });
      result.set_title = await attempt('plugin:window|set_title', { label: 'main', value: 'pwned' });
    }
    try {
      const response = await fetch('http://ipc.localhost/ruby_info', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Tauri-Callback': '1', 'Tauri-Error': '2' } });
      result.rawIpc = { status: response.status, body: (await response.text()).slice(0, 200) };
    } catch (error) {
      result.rawIpc = { error: String(error) };
    }
    return result;
  }).then(value => ({ label, ...value }));
}

(async () => {
  assert.equal(process.platform, 'win32');
  await mkdir(out, { recursive: true });
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-u0-'));
  const port = await freePort();
  const env = { ...process.env, ATCODER_IDE_TEST_PORT: String(port), WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'profile') };
  const child = spawn(path.resolve(process.env.APP_EXE), [], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  let browser;
  try {
    const deadline = Date.now() + 60000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`App exited ${child.exitCode}\n${log}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`No CDP\n${log}`);
      await pause(300);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const find = async predicate => {
      const end = Date.now() + 30000;
      for (;;) {
        const page = context.pages().find(p => predicate(p.url()));
        if (page) return page;
        if (Date.now() > end) throw new Error(`page not found: ${context.pages().map(p => p.url())}`);
        await pause(300);
      }
    };
    const main = await find(url => url.includes('tauri.localhost'));
    const atcoder = await find(url => url.startsWith('https://atcoder.jp/'));
    await atcoder.waitForLoadState('load');
    report.targets = context.pages().map(p => p.url());

    report.fromAtCoder = await denied(atcoder, 'atcoder');
    assert.notEqual(report.fromAtCoder.ruby_info?.ok, true, 'AtCoder page must not run app commands');
    assert.notEqual(report.fromAtCoder.spike_fetch?.ok, true, 'AtCoder page must not read cookies');
    assert.notEqual(report.fromAtCoder.notify?.ok, true, 'AtCoder page must not use plugins');
    assert.notEqual(report.fromAtCoder.set_title?.ok, true, 'AtCoder page must not use core commands');

    const invoke = (cmd, args) => main.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
    report.mainRubyInfo = await invoke('ruby_info').then(() => 'ok', e => `error: ${e.message}`);
    report.task = await invoke('spike_fetch', { url: 'https://atcoder.jp/contests/abc400/tasks/abc400_a' });
    assert.equal(report.task.status, 200);
    assert.ok(report.task.samples > 0);
    report.submissionsMe = await invoke('spike_fetch', { url: 'https://atcoder.jp/contests/abc400/submissions/me' });
    report.home = await invoke('spike_fetch', { url: 'https://atcoder.jp/home' });

    await invoke('spike_navigate', { url: 'https://atcoder.jp/contests/abc400' });
    await pause(5000);
    report.loads = await invoke('spike_loads');
    assert.ok(report.loads.some(entry => entry.includes('/contests/abc400') && entry.startsWith('Finished')));

    // Escaping the AtCoder page: a top-level navigation to the app origin from the page itself.
    await atcoder.evaluate(() => { location.href = 'http://tauri.localhost/'; }).catch(() => {});
    await pause(3000);
    report.afterEscape = await invoke('spike_loads').then(loads => loads.slice(-2));
    const escaped = context.pages().filter(p => p !== main && p.url().includes('tauri.localhost'));
    report.escapedPages = escaped.map(p => p.url());
    if (escaped.length) report.fromEscaped = await denied(escaped[0], 'escaped');
    assert.ok(atcoder.url().startsWith('https://atcoder.jp/'), `AtCoder webview left atcoder.jp: ${atcoder.url()}`);

    // An app-origin iframe inside the AtCoder page must not reach app commands either.
    await atcoder.evaluate(() => new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.src = 'http://tauri.localhost/';
      frame.onload = frame.onerror = () => resolve();
      document.body.append(frame);
      setTimeout(resolve, 5000);
    }));
    const appFrame = atcoder.frames().find(frame => frame.url().includes('tauri.localhost'));
    report.iframe = appFrame ? await denied(appFrame, 'iframe') : { loaded: false, frames: atcoder.frames().map(f => f.url()) };
    assert.notEqual(report.iframe.ruby_info?.ok, true, 'App-origin iframe in AtCoder must not run app commands');

    assert.notEqual(report.fromAtCoder.spike_read_dom?.ok, true, 'AtCoder page must not read the DOM through the app');

    // Read the loaded page from Rust instead of fetching it again.
    await invoke('spike_navigate', { url: 'https://atcoder.jp/contests/abc400/tasks/abc400_a' });
    await pause(5000);
    const html = JSON.parse(await invoke('spike_read_dom', { script: 'document.documentElement.outerHTML' }));
    report.dom = { length: html.length, samples: (html.match(/<h3>入力例/g) || []).length, userScreenName: html.match(/userScreenName = "([^"]*)"/)?.[1] };
    assert.ok(report.dom.samples > 0, 'DOM read must contain samples');
    const loadsBefore = (await invoke('spike_loads')).length;

    // Do timers keep running while the child webview is hidden?
    await invoke('spike_read_dom', { script: 'window.__u0Count = 0; window.__u0Timer = setInterval(() => window.__u0Count++, 1000); 0' });
    await invoke('spike_set_visible', { visible: false });
    await pause(15000);
    report.hidden = JSON.parse(await invoke('spike_read_dom', { script: 'JSON.stringify({ count: window.__u0Count, visibility: document.visibilityState, hidden: document.hidden })' }));
    report.hidden = JSON.parse(report.hidden);
    await invoke('spike_set_visible', { visible: true });
    report.loadsDuringRead = (await invoke('spike_loads')).length - loadsBefore;

    await main.bringToFront();
    report.clipboardWrite = await main.evaluate(() => navigator.clipboard.writeText('u0-clipboard-check').then(() => 'ok', e => `error: ${e}`));
    report.clipboardRead = await powershell('Get-Clipboard');
    report.notify = await invoke('plugin:notification|notify', { options: { title: 'U0', body: 'toast check' } }).then(() => 'ok', e => `error: ${e.message ?? e}`);
    report.notifyPermission = await invoke('plugin:notification|is_permission_granted').catch(e => `error: ${e.message ?? e}`);

    await main.screenshot({ path: path.join(out, 'main.png') });
    await atcoder.screenshot({ path: path.join(out, 'atcoder.png') });
    await powershell(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${path.join(out, 'desktop.png')}')`).catch(e => { report.desktopShot = String(e); });
  } finally {
    await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (browser) await browser.close().catch(() => {});
    child.kill();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
