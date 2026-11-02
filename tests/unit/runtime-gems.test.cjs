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

async function fixture(root, name, kind = 'pure', dependency = null) {
  const { stdout } = await execute(ruby, ['-EUTF-8:UTF-8', '-rrubygems/package', '-e', `
    name, kind, dependency = ARGV
    Dir.mkdir(name)
    Dir.chdir(name) do
      Dir.mkdir('lib')
      File.write("lib/#{name}.rb", kind == 'native' ? "require '#{name}/#{name}'" : "module RuntimeFixture; VALUE = '日本語'; end")
      File.write('LICENSE', 'fixture license')
      files = ["lib/#{name}.rb", 'LICENSE']
      if kind == 'native'
        Dir.mkdir('ext')
        File.write('ext/extconf.rb', ["require 'mkmf'", "create_makefile('#{name}/#{name}')", ''].join(10.chr))
        File.write("ext/#{name}.c", ['#include <ruby.h>', "void Init_#{name}(void) { rb_define_const(rb_cObject, #{'NativeFixture'.dump}, INT2FIX(42)); }", ''].join(10.chr))
        files += ['ext/extconf.rb', "ext/#{name}.c"]
      end
      spec = Gem::Specification.new do |s|
        s.name = name; s.version = '1.0.0'; s.summary = 'runtime fixture'
        s.authors = ['test']; s.license = 'MIT'; s.files = files
        s.extensions = ['ext/extconf.rb'] if kind == 'native'
        s.platform = 'java' if kind == 'java'
        s.add_dependency(dependency) unless dependency.to_s.empty?
      end
      puts Gem::Package.build(spec)
    end
  `, name, kind, dependency ?? ''], { cwd: root });
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

test('M19: C extensions are built for the Ruby that installs them', () => withRoot(async (root, options) => {
  const native = await fixture(root, 'ide_native', 'native');
  await prepareGems({ ...options, gems: [native] });
  const { stdout } = await execute(ruby, ['-rrubygems', '-e', 'Gem.use_paths(ARGV[0]); require "ide_native"; p NativeFixture', options.directory]);
  assert.equal(stdout.trim(), '42');
}));

test('M19: all packages are inspected before installing; other platforms, wrong identities and dependencies listed later are rejected', () => withRoot(async (root, options) => {
  const pure = await fixture(root, 'ide_pure');
  const platform = await fixture(root, 'ide_platform', 'java');
  await assert.rejects(prepareGems({ ...options, gems: [pure, platform] }), /platform/);
  await assert.rejects(readFile(path.join(options.directory, 'specifications/ide_pure-1.0.0.gemspec')), { code: 'ENOENT' });
  // A C extension may need its dependency's headers, so the dependency is installed first.
  const dependent = await fixture(root, 'ide_dependent', 'pure', 'ide_pure');
  await assert.rejects(prepareGems({ ...options, gems: [dependent, pure] }), /ide_pure.*先/);
  await assert.rejects(readFile(path.join(options.directory, 'specifications/ide_dependent-1.0.0.gemspec')), { code: 'ENOENT' });
  await prepareGems({ ...options, gems: [pure, dependent] });
  const wrong = { ...pure, name: 'wrong_name' };
  await writeFile(path.join(options.cache, 'wrong_name-1.0.0.gem'), await readFile(path.join(options.cache, 'ide_pure-1.0.0.gem')));
  await assert.rejects(prepareGems({ ...options, gems: [wrong] }), /identity|一致/);
}));
