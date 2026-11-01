const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { once } = require('node:events');
const { chromium } = require('playwright');
const native = require('./native.cjs');
const { startAtCoder } = require('./atcoder-fixture.cjs');
const execute = promisify(execFile);
const repo = path.resolve(__dirname, '../..');
let hostBinary;

function ensureUiTestHostBinary() {
  hostBinary ??= execute('cargo', ['build', '--locked', '--example', 'ui-test-host'], { cwd: repo }).then(() => {
    const target = path.resolve(repo, process.env.CARGO_TARGET_DIR || 'target');
    return path.join(target, 'debug', 'examples', process.platform === 'win32' ? 'ui-test-host.exe' : 'ui-test-host');
  });
  return hostBinary;
}

async function launch(root, { hostEnv = {} } = {}) {
  const started = performance.now();
  const binary = await ensureUiTestHostBinary();
  const prepared = performance.now();
  const atcoder = await startAtCoder();
  const child = spawn(binary, [], { cwd: root, env: { ...process.env, ...hostEnv, ATCODER_IDE_TEST_ORIGIN: atcoder.origin, NO_PROXY: '127.0.0.1', ATCODER_IDE_UI_TIMEOUT_MS: process.env.ATCODER_IDE_UI_TIMEOUT_MS || '4000' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0;
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {});
  const app = { child, root, dataDir: path.join(root, 'user-data'), atcoder, browser: null, page: null, server: null, delivery: Promise.resolve() };
  app.request = (command, args = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, command, args })}\n`);
  });
  child.on('close', () => {
    for (const request of pending.values()) request.reject(new Error(`UI test host exited: ${stderr}`));
    pending.clear();
  });
  const events = [];
  let pumping = false;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if ('channel' in message || 'appEvent' in message) {
      events.push(message);
      if (!pumping) {
        pumping = true;
        app.delivery = (async () => {
          while (events.length) {
            const batch = events.splice(0);
            await app.page.evaluate(batch => {
              for (const message of batch) {
                if ('appEvent' in message) window.__testEvent(message.appEvent, message.payload);
                else window.__testDispatch(message.channel, message.event);
              }
            }, batch);
          }
        })().finally(() => { pumping = false; });
        app.delivery.catch(() => {}); // Awaited on teardown.
      }
    } else {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.value);
    }
  });
  try {
    const assets = new Map([['/', 'index.html'], ...['index.html', 'renderer.js', 'bridge.mjs', 'sample-cases.mjs', 'editor.mjs', 'ruby-completion.mjs', 'lsp-completion.mjs', 'ruby-methods.mjs', 'ruby-receivers.mjs', 'layout.mjs', 'vendor/editor/codemirror.mjs', 'styles.css'].map(name => [`/${name}`, name])]);
    app.server = http.createServer(async (req, res) => {
      const name = assets.get(new URL(req.url, 'http://localhost').pathname);
      if (!name) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', /\.m?js$/.test(name) ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'text/html');
      res.setHeader('Content-Security-Policy', require('../../src-tauri/tauri.conf.json').app.security.csp);
      res.end(await readFile(path.join(repo, 'src', name)));
    });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const executablePath = process.env.CHROMIUM_PATH || (!existsSync(chromium.executablePath()) && existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    app.browser = await chromium.launch({ headless: true, executablePath, timeout: 15000 });
    app.page = await app.browser.newPage({ viewport: { width: 1280, height: 850 } });
    app.page.setDefaultTimeout(15000);
    app.page.on('pageerror', error => console.error('Browser UI error:', error));
    await app.page.exposeBinding('__testInvoke', async (_, command, args) => app.request(command, args));
    await app.page.exposeBinding('__testDestroy', async () => {
      await app.request('shutdown');
      setTimeout(() => app.page.close().catch(() => {}), 10);
    });
    await app.page.addInitScript(() => {
      const channels = new Map();
      const handlers = new Set();
      let id = 0;
      class Channel { constructor() { this.id = ++id; channels.set(this.id, this); } }
      window.__testDispatch = (id, event) => {
        const channel = channels.get(id);
        if (!channel) return; // A reload discards channels from the previous page.
        channel.onmessage(event);
        if (event.type === 'completed' || event.type === 'failed') channels.delete(id);
      };
      const appWindow = {
        setTitle: async title => { document.title = title; },
        onCloseRequested: async handler => { handlers.add(handler); return () => handlers.delete(handler); },
        destroy: () => window.__testDestroy(),
        close: async () => {
          queueMicrotask(async () => {
            let prevented = false;
            const event = { preventDefault() { prevented = true; } };
            for (const handler of handlers) await handler(event);
            if (!prevented) await appWindow.destroy();
          });
        }
      };
      const listeners = new Map();
      window.__testEvent = (name, payload) => { for (const handler of listeners.get(name) || []) handler({ payload }); };
      window.__TAURI__ = {
        core: { Channel, invoke: (command, args = {}) => window.__testInvoke(command, { ...args, ...(args.onEvent ? { onEvent: args.onEvent.id } : {}) }) },
        event: { listen: async (name, handler) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); return () => listeners.get(name).delete(handler); } },
        window: { getCurrentWindow: () => appWindow }
      };
    });
    await app.page.goto(`http://127.0.0.1:${app.server.address().port}/`);
    await app.page.getByTestId('ruby-version').filter({ hasText: /ruby 3\./i }).waitFor();
    console.log(JSON.stringify({ uiHostBuildMs: Math.round(prepared - started), browserSetupMs: Math.round(performance.now() - prepared), browserVersion: app.browser.version() }));
    return app;
  } catch (error) {
    if (app.page) console.error(await app.page.locator('body').textContent().catch(() => ''));
    await close(app).catch(() => {});
    throw error;
  }
}

async function close(app) {
  if (app.child.exitCode === null) {
    const exited = once(app.child, 'close', { signal: AbortSignal.timeout(5000) });
    app.child.stdin.end();
    await exited.catch(() => app.child.kill());
  }
  await app.delivery;
  await app.browser?.close();
  if (app.server) await new Promise(resolve => app.server.close(resolve));
  if (app.atcoder) await new Promise(resolve => app.atcoder.server.close(resolve));
}
const requestClose = app => app.page.evaluate(() => window.__TAURI__.window.getCurrentWindow().close());

module.exports = { ...native, requestClose, ensureUiTestHostBinary, launch, close };
