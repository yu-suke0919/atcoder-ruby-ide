const { readdir, readFile, stat, mkdir, cp, writeFile, appendFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

async function inventory(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(directory, relative));
    else if (entry.isFile()) {
      const data = await readFile(path.join(directory, relative));
      files.push({ path: relative.replaceAll('\\', '/'), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function measure(options) {
  const [electron, tauri] = await Promise.all([inventory(options.electronDir), inventory(options.tauriDir)]);
  const electronRuby = electron.filter(f => f.path.startsWith('resources/ruby/')).map(f => ({ ...f, path: f.path.slice('resources/ruby/'.length) }));
  const tauriRuby = tauri.filter(f => f.path.startsWith('ruby/')).map(f => ({ ...f, path: f.path.slice('ruby/'.length) }));
  if (!electronRuby.length || JSON.stringify(electronRuby) !== JSON.stringify(tauriRuby)) throw new Error('Ruby のファイル一覧・SHA-256 が一致しません。');
  const total = files => files.reduce((sum, f) => sum + f.bytes, 0);
  const pair = async (left, right) => {
    const electronBytes = (await stat(left)).size;
    const tauriBytes = (await stat(right)).size;
    return { electronBytes, tauriBytes, reductionPercent: (1 - tauriBytes / electronBytes) * 100 };
  };
  return {
    commit: process.env.GITHUB_SHA || null,
    ruby: { bytes: total(electronRuby), files: electronRuby.length, identical: true },
    electron: { expandedBytes: total(electron), executableBytes: (await stat(path.join(options.electronDir, 'AtCoder Ruby IDE.exe'))).size },
    tauri: { expandedBytes: total(tauri), executableBytes: (await stat(path.join(options.tauriDir, 'tauri-size-probe.exe'))).size },
    packages: await pair(options.electronPackage, options.tauriPackage),
    zip: await pair(options.electronZip, options.tauriZip)
  };
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  const artifacts = path.join(__dirname, 'artifacts');
  const tauriDir = path.join(artifacts, 'portable');
  const electronDir = path.join(root, 'dist/win-unpacked');
  await mkdir(tauriDir, { recursive: true });
  await cp(path.join(__dirname, 'src-tauri/target/release/tauri-size-probe.exe'), path.join(tauriDir, 'tauri-size-probe.exe'));
  await cp(path.join(root, 'vendor/ruby'), path.join(tauriDir, 'ruby'), { recursive: true });
  const zip = (directory, filename) => {
    execFileSync(require('../../node_modules/7zip-bin').path7za, ['a', '-tzip', '-mx=9', '-mmt=2', '-bso0', '-bsp0', filename, '.'], { cwd: directory, stdio: 'inherit' });
  };
  const electronZip = path.join(artifacts, 'electron-same-compression.zip');
  const tauriZip = path.join(artifacts, 'tauri-portable.zip');
  zip(electronDir, electronZip);
  zip(tauriDir, tauriZip);
  const nsis = path.join(__dirname, 'src-tauri/target/release/bundle/nsis');
  const installer = (await readdir(nsis)).find(name => name.endsWith('-setup.exe'));
  if (!installer) throw new Error('Tauri NSIS installer is missing');
  const tauriPackage = path.join(artifacts, 'tauri-setup.exe');
  await cp(path.join(nsis, installer), tauriPackage);
  const portable = (await readdir(path.join(root, 'dist'))).find(name => /^AtCoder-Ruby-IDE-.*-x64\.exe$/.test(name));
  const result = await measure({ electronDir, tauriDir, electronPackage: path.join(root, 'dist', portable), tauriPackage, electronZip, tauriZip });
  const mib = bytes => (bytes / 1048576).toFixed(2);
  const markdown = `# Windows x64 配布容量の実測\n\nCommit: ${result.commit}\n\n| 比較 | Electron MiB | Tauri MiB | 削減率 |\n| --- | ---: | ---: | ---: |\n| 配布用ディレクトリ | ${mib(result.electron.expandedBytes)} | ${mib(result.tauri.expandedBytes)} | — |\n| 同一設定の ZIP | ${mib(result.zip.electronBytes)} | ${mib(result.zip.tauriBytes)} | ${result.zip.reductionPercent.toFixed(1)}% |\n| 製品別パッケージ（portable exe / NSIS setup） | ${mib(result.packages.electronBytes)} | ${mib(result.packages.tauriBytes)} | ${result.packages.reductionPercent.toFixed(1)}% |\n\n同梱 Ruby: ${mib(result.ruby.bytes)} MiB、${result.ruby.files} ファイル。全ファイルの SHA-256 が一致。\n\nTauri は実行・停止だけの検証版。WebView2 は同梱せず、未導入時に別途取得。パッケージ形式の差と全機能移植前である点を考慮する。\n`;
  await writeFile(path.join(artifacts, 'size-report.json'), JSON.stringify(result, null, 2) + '\n');
  await writeFile(path.join(artifacts, 'size-report.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { measure };
