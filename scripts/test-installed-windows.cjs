const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readFile, access, rm, writeFile, copyFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { launch, close } = require('../tests/e2e/native.cjs');
const execute = promisify(execFile);

async function main() {
  const root = path.resolve(__dirname, '..');
  const { version } = require('../package.json');
  const directory = await mkdtemp(path.join(tmpdir(), 'AtCoder Installed '));
  const profile = await mkdtemp(path.join(tmpdir(), 'AtCoder Smoke '));
  const installer = path.join(root, 'artifacts', `AtCoder-Ruby-IDE-${version}-x64-setup.exe`);
  await execute(installer, ['/S', `/D=${directory}`], { timeout: 120000, windowsVerbatimArguments: true });
  const executable = path.join(directory, 'atcoder-ruby-ide.exe');
  const expected = JSON.parse(await readFile(path.join(root, 'artifacts/reports/app-manifest.json'), 'utf8'));
  const installed = await readFile(executable);
  const installedHash = createHash('sha256').update(installed).digest('hex');
  if (installedHash !== expected.sha256) {
    const portable = await readFile(path.join(root, 'artifacts/portable/atcoder-ruby-ide.exe'));
    const differences = [];
    for (let i = 0; i < Math.min(installed.length, portable.length) && differences.length < 24; i++) {
      if (installed[i] !== portable[i]) differences.push({ offset: i, installed: installed[i], portable: portable[i] });
    }
    console.log(JSON.stringify({ installedBytes: installed.length, expectedBytes: expected.bytes, differences }));
    await writeFile(path.join(root, 'artifacts/reports/installed-debug.exe'), installed);
    await writeFile(path.join(root, 'artifacts/reports/portable-debug.exe'), portable);
    await copyFile(installer, path.join(root, 'artifacts/reports/setup-debug.exe'));
  }
  assert.equal(installedHash, expected.sha256, 'Installed exe must equal the tested portable exe');
  const runtime = JSON.parse(await readFile(path.join(root, 'artifacts/reports/ruby-manifest.json'), 'utf8'));
  const required = ['bin/ruby.exe', 'lib/ruby', 'LICENSE.txt', 'licenses/ruby/COPYING.html', 'licenses/ruby/LEGAL.html', ...Object.keys(runtime).filter(name => name.startsWith('bin/') && name.endsWith('.dll'))];
  for (const name of required) await access(path.join(directory, 'ruby', name));
  let app;
  try {
    process.env.APP_EXE = executable;
    app = await launch(profile); // Removes Ruby from PATH and verifies the app's actual Ruby path.
    const page = app.page;
    await page.getByRole('button', { name: '実行', exact: true }).click();
    await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
    assert.equal(await page.getByTestId('stdout').textContent(), '6 test\n');
    await page.getByTestId('code-editor').fill('require "json"; require "bigdecimal"; require "openssl"; puts JSON.generate(value: BigDecimal("1.5").to_s("F"))');
    await page.getByRole('button', { name: '実行', exact: true }).click();
    await page.getByTestId('run-status').filter({ hasText: '正常終了' }).waitFor();
    assert.equal(await page.getByTestId('stdout').textContent(), '{"value":"1.5"}\n');
    console.log('NSIS smoke passed: installed exe, runtime files, sample and bundled extensions without system Ruby');
  } finally {
    if (app) await close(app);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
