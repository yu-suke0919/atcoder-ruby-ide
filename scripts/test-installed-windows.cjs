const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, access, rm } = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { launch, close } = require('../tests/e2e/native.cjs');
const { verifyLsp } = require('../tests/e2e/lsp.cjs');
const { seedProblem, openProblem, removeContest, waitInitialized } = require('../tests/e2e/workspace.cjs');
const contest = `nsis-smoke-${Date.now()}`;
const execute = promisify(execFile);

async function main() {
  const root = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  const directory = await mkdtemp(path.join(tmpdir(), 'AtCoder Installed '));
  const profile = await mkdtemp(path.join(tmpdir(), 'AtCoder Smoke '));
  const installer = path.join(root, 'artifacts', `AtCoder-Ruby-IDE-${version}-x64-setup.exe`);
  await execute(installer, ['/S', `/D=${directory}`], { timeout: 120000, windowsVerbatimArguments: true });
  const executable = path.join(directory, 'atcoder-ruby-ide.exe');
  await access(executable);
  const runtime = JSON.parse(await readFile(path.join(root, 'artifacts/reports/wsl-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(runtime).sort(), ['atcoder-linux.tar.gz', 'runtime.json']);
  for (const name of Object.keys(runtime)) await access(path.join(directory, 'wsl', name));
  let app;
  try {
    process.env.APP_EXE = executable;
    app = await launch(profile, { hostEnv: { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' } }); // Removes Ruby from PATH and verifies that Ruby runs in WSL.
    const page = app.page;
    await page.context().setOffline(true);
    await waitInitialized(page);
    await openProblem(page, await seedProblem(app, contest, 'smoke'));
    await verifyLsp(page);
    await page.getByRole('button', { name: '実行', exact: true }).click();
    await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
    assert.equal(await page.getByTestId('stdout').textContent(), '6 test\n');
    await page.getByTestId('code-editor').fill('require "json"; require "bigdecimal"; require "openssl"; puts JSON.generate(value: BigDecimal("1.5").to_s("F"))');
    await page.getByRole('button', { name: '実行', exact: true }).click();
    await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
    assert.equal(await page.getByTestId('stdout').textContent(), '{"value":"1.5"}\n');
    await page.getByTestId('code-editor').fill(await readFile(path.join(root, 'tests/fixtures/runtime-gems.rb'), 'utf8'));
    await page.locator('#stdin').fill('日本語\n');
    await page.getByRole('button', { name: '実行', exact: true }).click();
    await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
    assert.equal(await page.getByTestId('stdout').textContent(), await readFile(path.join(root, 'tests/fixtures/runtime-gems.txt'), 'utf8'));
  } finally {
    if (app) await close(app);
    if (app) await removeContest(app, contest);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  // Uninstalling removes the app's WSL distribution (docs/architecture.md#wslのエージェント).
  const registered = async () => (await execute('wsl.exe', ['-l', '-q'], { env: { ...process.env, WSL_UTF8: '1' } }).catch(error => error)).stdout?.includes('AtCoderRubyIDE');
  assert.equal(await registered(), true, 'the app registers its WSL distribution');
  await execute(path.join(directory, 'uninstall.exe'), ['/S'], { timeout: 120000 });
  const deadline = Date.now() + 60000;
  while (await registered()) {
    assert.ok(Date.now() < deadline, 'the uninstaller leaves the WSL distribution registered');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log('NSIS smoke passed: installed exe, WSL distribution, offline LSP, sample, bundled extensions and AtCoder gems in WSL without Windows Ruby, and the uninstaller unregisters the distribution');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
