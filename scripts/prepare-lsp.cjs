const { cp, mkdir, mkdtemp, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepareGems } = require('./prepare-gems.cjs');
const profile = require('../config/ruby-lsp.json');
const execute = promisify(execFile);
const repository = path.resolve(__dirname, '..');

async function prepareLsp({ root = repository, ruby = process.platform === 'win32' ? path.join(root, 'vendor/ruby/bin/ruby.exe') : process.env.RUBY_PATH || 'ruby', cache = path.join(root, '.cache/gems') } = {}) {
  const vendor = path.join(root, 'vendor');
  await mkdir(vendor, { recursive: true });
  const staging = await mkdtemp(path.join(vendor, '.ruby-lsp-'));
  try {
    await prepareGems({ ruby, directory: path.join(staging, 'gems'), cache, gems: profile.gems });
    // RubyGems creates absolute executable links; the app loads the original gem executable.
    await rm(path.join(staging, 'gems/bin'), { recursive: true, force: true });
    await cp(path.join(repository, 'config/ruby-lsp'), staging, { recursive: true });
    const dependencies = [...profile.gems, ...profile.bundledGems.filter(g => g.name !== 'bundler')];
    await writeFile(path.join(staging, 'Gemfile'), `source 'https://rubygems.org'\n${dependencies.map(g => `gem '${g.name}', '= ${g.version}'`).join('\n')}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|BUNDLE_.*)$/i.test(key)));
    const { stdout } = await execute(ruby, ['-EUTF-8:UTF-8', path.join(staging, 'server.rb'), '--probe'], { env, timeout: 30000 });
    const versions = JSON.parse(stdout);
    for (const gem of [...profile.gems, ...profile.bundledGems]) {
      if (versions[gem.name] !== gem.version) throw new Error(`LSP依存gem ${gem.name} が固定バージョン ${gem.version} と一致しません`);
    }
    await writeFile(path.join(staging, '.lsp-source.json'), JSON.stringify(profile, null, 2));
    const destination = path.join(vendor, 'ruby-lsp');
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    console.log('Prepared isolated Ruby LSP bundle');
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (require.main === module) prepareLsp().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareLsp };
