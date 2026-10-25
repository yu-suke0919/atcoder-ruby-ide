const { cp, mkdir, readdir, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const assert = require('node:assert/strict');
const { version } = require('../package.json');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const portable = path.join(artifacts, 'portable');
const baseName = `AtCoder-Ruby-IDE-${version}-x64`;

async function manifest(directory) {
  const files = {};
  async function walk(relative = '') {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else {
        const data = await readFile(path.join(directory, name));
        files[name] = { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
      }
    }
  }
  await walk();
  return files;
}
const bytes = files => Object.values(files).reduce((total, file) => total + file.bytes, 0);

async function main() {
  assert.equal(process.platform, 'win32', 'Windows packaging requires Windows');
  if (process.argv.includes('--stage')) {
    await rm(artifacts, { recursive: true, force: true });
    await mkdir(portable, { recursive: true });
    await cp(path.join(root, 'target/release/atcoder-ruby-ide.exe'), path.join(portable, 'atcoder-ruby-ide.exe'));
    await cp(path.join(root, 'vendor/ruby'), path.join(portable, 'ruby'), { recursive: true });
    const source = await manifest(path.join(root, 'vendor/ruby'));
    assert.deepEqual(await manifest(path.join(portable, 'ruby')), source, 'Portable Ruby must include the complete original payload');
    const installers = await readdir(path.join(root, 'target/release/bundle/nsis'));
    const installer = installers.find(name => name.endsWith('-setup.exe'));
    assert.ok(installer, 'NSIS installer is missing');
    await cp(path.join(root, 'target/release/bundle/nsis', installer), path.join(artifacts, `${baseName}-setup.exe`));
    await mkdir(path.join(artifacts, 'reports'), { recursive: true });
    await writeFile(path.join(artifacts, 'reports/ruby-manifest.json'), JSON.stringify(source, null, 2));
    return;
  }
  const files = await manifest(portable);
  const source = await manifest(path.join(root, 'vendor/ruby'));
  assert.deepEqual(await manifest(path.join(portable, 'ruby')), source);
  const zip = path.join(artifacts, `${baseName}-portable.zip`);
  await rm(zip, { force: true });
  await execute(require('7zip-bin').path7za, ['a', '-tzip', '-mx9', '-mmt2', '-bd', '-bsp0', zip, '.'], { cwd: portable, maxBuffer: 1024 * 1024 });
  const report = {
    version,
    ruby: require('../config/ruby-windows.json'),
    rubyFileCount: Object.keys(source).length,
    rubyBytes: bytes(source),
    expandedBytes: bytes(files),
    executableBytes: (await stat(path.join(portable, 'atcoder-ruby-ide.exe'))).size,
    portableZipBytes: (await stat(zip)).size,
    installerBytes: (await stat(path.join(artifacts, `${baseName}-setup.exe`))).size
  };
  await writeFile(path.join(artifacts, 'reports/package.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
