const { mkdir, cp, readdir } = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const artifacts = path.join(__dirname, 'artifacts');
  const portable = path.join(artifacts, 'portable');
  await mkdir(portable, { recursive: true });
  await cp(path.join(__dirname, 'src-tauri/target/release/tauri-size-probe.exe'), path.join(portable, 'tauri-size-probe.exe'));
  await cp(path.resolve(__dirname, '../../vendor/ruby'), path.join(portable, 'ruby'), { recursive: true });
  const nsis = path.join(__dirname, 'src-tauri/target/release/bundle/nsis');
  const installer = (await readdir(nsis)).find(name => name.endsWith('-setup.exe'));
  if (!installer) throw new Error('Tauri NSIS installer is missing');
  await cp(path.join(nsis, installer), path.join(artifacts, 'tauri-setup.exe'));
})().catch(error => { console.error(error); process.exitCode = 1; });
