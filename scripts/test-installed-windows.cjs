const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, readdir, readFile } = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const execute = promisify(execFile);

async function main() {
  const root = path.resolve(__dirname, '..');
  const directory = await mkdtemp(path.join(tmpdir(), 'AtCoder Installed '));
  const installers = await readdir(path.join(root, 'artifacts'));
  const installer = path.join(root, 'artifacts', installers.find(name => name.endsWith('-setup.exe')));
  await execute(installer, ['/S', `/D=${directory}`], { timeout: 120000 });
  const executable = path.join(directory, 'atcoder-ruby-ide.exe');
  await readFile(executable);
  // Verify the installed stdlib, native libraries and licenses against the original payload.
  const manifest = JSON.parse(await readFile(path.join(root, 'artifacts/reports/ruby-manifest.json'), 'utf8'));
  const { createHash } = require('node:crypto');
  for (const [name, expected] of Object.entries(manifest)) {
    const data = await readFile(path.join(directory, 'ruby', name));
    assert.equal(createHash('sha256').update(data).digest('hex'), expected.sha256, name);
  }
  const { spawn } = require('node:child_process');
  const tests = spawn(process.execPath, ['--test', '--test-isolation=none', 'tests/e2e/app.test.cjs'], {
    cwd: root, env: { ...process.env, APP_EXE: executable }, stdio: 'inherit'
  });
  const [code] = await require('node:events').once(tests, 'exit');
  process.exitCode = code;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
