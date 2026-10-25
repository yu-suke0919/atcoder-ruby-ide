const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const path = require('node:path');
const manifest = require('../config/ruby-windows.json');
const execute = promisify(execFile);

async function exists(file) {
  try { await access(file); return true; }
  catch { return false; }
}

async function prepareRuby({ root = path.resolve(__dirname, '..') } = {}) {
  const destination = path.join(root, 'vendor', 'ruby');
  const marker = path.join(destination, '.runtime-source.json');
  if (await exists(destination) && !await exists(marker)) {
    throw new Error('既存の vendor/ruby はこのスクリプトの管理対象ではありません。内容を確認してください。');
  }
  const cache = path.join(root, '.cache');
  await mkdir(cache, { recursive: true });
  const archive = path.join(cache, manifest.archive);
  if (!await exists(archive)) {
    console.log(`Downloading official RubyInstaller ${manifest.version}…`);
    const response = await fetch(manifest.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Ruby のダウンロードに失敗しました: HTTP ${response.status}`);
    const partial = `${archive}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      await rename(partial, archive);
    } finally { await rm(partial, { force: true }); }
  }
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (hash !== manifest.sha256) throw new Error(`Ruby アーカイブの SHA-256 が一致しません。キャッシュを確認してください: ${archive}`);
  console.log(`Ruby archive SHA-256 verified: ${hash}`);
  if (await exists(marker)) {
    const previous = JSON.parse(await readFile(marker, 'utf8'));
    if (previous.sha256 === hash && await exists(path.join(destination, 'bin', 'ruby.exe'))) {
      console.log('Windows Ruby is already prepared.');
      return destination;
    }
  }

  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, '.ruby-'));
  try {
    const { path7za } = require('7zip-bin');
    if (process.platform !== 'win32') await chmod(path7za, 0o755);
    await execute(path7za, ['x', '-y', '-bd', '-bso0', '-bsp0', archive, `-o${staging}`], { maxBuffer: 8 * 1024 * 1024 });
    const entries = await readdir(staging, { withFileTypes: true });
    let runtime;
    for (const directory of [staging, ...entries.filter((e) => e.isDirectory()).map((e) => path.join(staging, e.name))]) {
      if (await exists(path.join(directory, 'bin', 'ruby.exe'))) { runtime = directory; break; }
    }
    if (!runtime) throw new Error('公式アーカイブ内に bin/ruby.exe がありません。');
    await writeFile(path.join(runtime, '.runtime-source.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (await exists(destination)) await rm(destination, { recursive: true });
    await rename(runtime, destination);
    console.log(`Prepared Windows Ruby ${manifest.version}: ${destination}`);
    return destination;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (require.main === module) {
  prepareRuby().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { prepareRuby };
