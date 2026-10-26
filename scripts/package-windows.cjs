const { cp, mkdir, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const assert = require('node:assert/strict');
const { version } = require('../package.json');
const execute = promisify(execFile);
const { createManifest, verifyRuntime } = require('./runtime-files.cjs');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
const portable = path.join(artifacts, 'portable');
const baseName = `AtCoder-Ruby-IDE-${version}-x64`;

const bytes = files => Object.values(files).reduce((total, file) => total + file.bytes, 0);

async function main() {
  assert.equal(process.platform, 'win32', 'Windows packaging requires Windows');
  if (process.argv.includes('--stage')) {
    await rm(artifacts, { recursive: true, force: true });
    await mkdir(portable, { recursive: true });
    await cp(path.join(root, 'target/release/atcoder-ruby-ide.exe'), path.join(portable, 'atcoder-ruby-ide.exe'));
    await cp(path.join(root, 'vendor/ruby'), path.join(portable, 'ruby'), { recursive: true });
    const source = await createManifest(path.join(root, 'vendor/ruby'));
    const { productName } = require('../src-tauri/tauri.conf.json');
    const installer = `${productName}_${version}_x64-setup.exe`;
    await cp(path.join(root, 'target/release/bundle/nsis', installer), path.join(artifacts, `${baseName}-setup.exe`));
    await mkdir(path.join(artifacts, 'reports'), { recursive: true });
    await writeFile(path.join(artifacts, 'reports/ruby-manifest.json'), JSON.stringify(source, null, 2));
    const executable = await readFile(path.join(portable, 'atcoder-ruby-ide.exe'));
    await writeFile(path.join(artifacts, 'reports/app-manifest.json'), JSON.stringify({ bytes: executable.length, sha256: createHash('sha256').update(executable).digest('hex') }));
    return;
  }
  const source = JSON.parse(await readFile(path.join(artifacts, 'reports/ruby-manifest.json'), 'utf8'));
  await verifyRuntime(path.join(portable, 'ruby'), source);
  const zip = path.join(artifacts, `${baseName}-portable.zip`);
  await rm(zip, { force: true });
  await execute(require('7zip-bin').path7za, ['a', '-tzip', '-mx9', '-mmt2', '-bd', '-bsp0', zip, '.'], { cwd: portable, maxBuffer: 1024 * 1024 });
  const report = {
    version,
    ruby: require('../config/ruby-windows.json'),
    rubyFileCount: Object.keys(source).length,
    rubyBytes: bytes(source),
    expandedBytes: bytes(source) + (await stat(path.join(portable, 'atcoder-ruby-ide.exe'))).size,
    executableBytes: (await stat(path.join(portable, 'atcoder-ruby-ide.exe'))).size,
    portableZipBytes: (await stat(zip)).size,
    installerBytes: (await stat(path.join(artifacts, `${baseName}-setup.exe`))).size
  };
  await writeFile(path.join(artifacts, 'reports/package.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
