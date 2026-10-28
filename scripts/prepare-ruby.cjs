const { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify, isDeepStrictEqual } = require('node:util');
const path = require('node:path');
const manifest = require('../config/ruby-windows.json');
const profile = require('../config/atcoder-runtime.json');
const { downloadVerified } = require('./download-verified.cjs');
const { prepareGems } = require('./prepare-gems.cjs');
const execute = promisify(execFile);

async function exists(file) {
  try { await access(file); return true; }
  catch { return false; }
}

async function trimRuntime(runtime) {
  const licenses = path.join(runtime, 'licenses/ruby');
  await mkdir(licenses, { recursive: true });
  for (const name of ['COPYING.html', 'COPYING_ja.html', 'LEGAL.html']) {
    const original = path.join(runtime, 'share/doc/ruby/html', name);
    const preserved = path.join(licenses, name);
    if (await exists(original)) await copyFile(original, preserved);
    await access(preserved); // Fail before removal if a required notice is missing.
  }
  for (const directory of ['share', 'include']) await rm(path.join(runtime, directory), { recursive: true, force: true });
}

async function prepareRuby({ root = path.resolve(__dirname, '..'), source = manifest, gems = profile.gems } = {}) {
  const destination = path.join(root, 'vendor', 'ruby');
  const marker = path.join(destination, '.runtime-source.json');
  if (await exists(destination) && !await exists(marker)) {
    throw new Error('既存の vendor/ruby はこのスクリプトの管理対象ではありません。内容を確認してください。');
  }
  const cache = path.join(root, '.cache');
  const archive = await downloadVerified(source, cache);
  console.log(`Ruby archive SHA-256 verified: ${source.sha256}`);
  if (await exists(marker)) {
    const previous = JSON.parse(await readFile(marker, 'utf8'));
    if (previous.sha256 === source.sha256 && isDeepStrictEqual(previous.gems, gems) && await exists(path.join(destination, 'bin', 'ruby.exe'))) {
      await trimRuntime(destination);
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
    await prepareGems({
      ruby: process.platform === 'win32' ? path.join(runtime, 'bin/ruby.exe') : process.env.RUBY_PATH || 'ruby',
      directory: path.join(runtime, 'lib/ruby/gems', profile.rubyApiVersion),
      cache: path.join(cache, 'gems'), gems
    });
    await trimRuntime(runtime);
    await writeFile(path.join(runtime, '.runtime-source.json'), `${JSON.stringify({ ...source, gems }, null, 2)}\n`);
    if (await exists(destination)) await rm(destination, { recursive: true });
    await rename(runtime, destination);
    console.log(`Prepared Windows Ruby ${source.version}: ${destination}`);
    return destination;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (require.main === module) {
  prepareRuby().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { prepareRuby, trimRuntime };
