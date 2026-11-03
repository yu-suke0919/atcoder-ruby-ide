const { cp, mkdir, mkdtemp, rename, rm, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { prepareGems } = require('./prepare-gems.cjs');
const profile = require('../config/ruby-lsp.json');
const competition = require('../config/atcoder-runtime.json');
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
    // Ruby LSP indexes the default group: the competition gems, already in the Ruby's own gem folder.
    // The LSP gems are only in the development group, which it does not index (docs/ruby-lsp.md).
    const lsp = [...profile.gems, ...profile.bundledGems.filter(g => g.name !== 'bundler')];
    const line = g => `gem '${g.name}', '= ${g.version}'`;
    await writeFile(path.join(staging, 'Gemfile'), `source 'https://rubygems.org'\n${competition.gems.map(line).join('\n')}\ngroup :development do\n${lsp.map(g => `  ${line(g)}`).join('\n')}\nend\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|RUBYGEMS_GEMDEPS|BUNDLE_.*|BUNDLER_ORIG_.*)$/i.test(key)));
    // Every gem is pinned and installed, so the lock is resolved from them without the network.
    const lock = "gems = ARGV.shift; Gem.use_paths(gems, [gems, Gem.default_dir]); load Gem.bin_path('bundler', 'bundle')";
    const gems = path.join(staging, 'gems');
    await execute(ruby, ['-EUTF-8:UTF-8', '-e', lock, gems, 'lock', '--local'], { cwd: staging, env: { ...env, BUNDLE_GEMFILE: path.join(staging, 'Gemfile'), BUNDLE_IGNORE_CONFIG: 'true' }, timeout: 60000 });
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
