const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { prepareGems } = require('../../scripts/prepare-gems.cjs');
const execute = promisify(execFile);
const ruby = process.env.RUBY_PATH || 'ruby';

async function fixture(root, name, kind = 'pure') {
  const { stdout } = await execute(ruby, ['-EUTF-8:UTF-8', '-rrubygems/package', '-e', `
    name = ARGV[0]
    Dir.mkdir(name)
    Dir.chdir(name) do
      Dir.mkdir('lib')
      File.write("lib/#{name}.rb", "module RuntimeFixture; VALUE = '日本語'; end")
      File.write('LICENSE', 'fixture license')
      Dir.mkdir('ext')
      File.write('ext/extconf.rb', 'raise "must not build"')
      spec = Gem::Specification.new do |s|
        s.name = name; s.version = '1.0.0'; s.summary = 'runtime fixture'
        s.authors = ['test']; s.license = 'MIT'; s.files = ["lib/#{name}.rb", 'LICENSE']
        s.extensions = ['ext/extconf.rb'] if ARGV[1] == 'native'
        s.platform = 'java' if ARGV[1] == 'java'
      end
      puts Gem::Package.build(spec)
    end
  `, name, kind], { cwd: root });
  const archive = `${name}-1.0.0.gem`;
  assert.ok(stdout.includes(name));
  const data = await readFile(path.join(root, name, stdout.trim().split('\n').at(-1)));
  await writeFile(path.join(root, 'cache', archive), data);
  return { name, version: '1.0.0', sha256: createHash('sha256').update(data).digest('hex') };
}

async function withRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'IDE-gems 日本語 '));
  try {
    await mkdir(path.join(root, 'cache'));
    await mkdir(path.join(root, 'installed'));
    await fn(root, { ruby, cache: path.join(root, 'cache'), directory: path.join(root, 'installed') });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('M19: verified local gems load offline from a Japanese path and preserve licenses', () => withRoot(async (root, options) => {
  const gem = await fixture(root, 'ide_fixture');
  await prepareGems({ ...options, gems: [gem] });
  const { stdout } = await execute(ruby, ['-EUTF-8:UTF-8', '-rrubygems', '-e', 'Gem.use_paths(ARGV[0]); require "ide_fixture"; puts RuntimeFixture::VALUE; puts Gem.loaded_specs["ide_fixture"].version', options.directory]);
  assert.equal(stdout.replaceAll('\r\n', '\n'), '日本語\n1.0.0\n');
  assert.equal(await readFile(path.join(options.directory, 'gems/ide_fixture-1.0.0/LICENSE'), 'utf8'), 'fixture license');
}));

test('M19: a corrupt cached gem is rejected before modifying the installation', () => withRoot(async (root, options) => {
  const gem = await fixture(root, 'ide_corrupt');
  await writeFile(path.join(options.cache, 'ide_corrupt-1.0.0.gem'), 'corrupt');
  await writeFile(path.join(options.directory, 'preserve'), 'keep');
  await assert.rejects(prepareGems({ ...options, gems: [gem] }), /SHA-256/);
  assert.equal(await readFile(path.join(options.directory, 'preserve'), 'utf8'), 'keep');
}));

test('M19: all packages are inspected before installing; native extensions and wrong identities are rejected', () => withRoot(async (root, options) => {
  const pure = await fixture(root, 'ide_pure');
  const native = await fixture(root, 'ide_native', 'native');
  await assert.rejects(prepareGems({ ...options, gems: [pure, native] }), /native|C拡張/);
  await assert.rejects(readFile(path.join(options.directory, 'specifications/ide_pure-1.0.0.gemspec')), { code: 'ENOENT' });
  const platform = await fixture(root, 'ide_platform', 'java');
  await assert.rejects(prepareGems({ ...options, gems: [platform] }), /native|platform/);
  const wrong = { ...pure, name: 'wrong_name' };
  await writeFile(path.join(options.cache, 'wrong_name-1.0.0.gem'), await readFile(path.join(options.cache, 'ide_pure-1.0.0.gem')));
  await assert.rejects(prepareGems({ ...options, gems: [wrong] }), /identity|一致/);
}));
