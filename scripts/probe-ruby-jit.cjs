const { spawnSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ruby = process.env.RUBY_PATH || (process.platform === 'win32' ? path.join(root, 'vendor/ruby/bin/ruby.exe') : 'ruby');
const destination = path.resolve(process.argv[2] || path.join(root, 'test-results/ruby-jit.json'));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|RUBYGEMS_GEMDEPS|BUNDLE_.*|BUNDLER_ORIG_.*|RUBY_YJIT_ENABLE|RUBY_THREAD_VM_STACK_SIZE|RUBY_THREAD_MACHINE_STACK_SIZE)$/i.test(key)) delete env[key];
}
env.RUBY_THREAD_VM_STACK_SIZE = String(32 * 1024 * 1024);
const probe = `
require 'rbconfig'
require 'json'
Gem.use_paths(Gem.default_dir)
puts JSON.generate({
  rubyVersion: RUBY_VERSION, rubyDescription: RUBY_DESCRIPTION, rubyPlatform: RUBY_PLATFORM,
  executable: RbConfig.ruby, vmStackBytes: RubyVM::DEFAULT_PARAMS.fetch(:thread_vm_stack_size),
  yjitSupport: RbConfig::CONFIG['YJIT_SUPPORT'], rjitSupport: RbConfig::CONFIG['RJIT_SUPPORT'],
  yjitAvailable: !!defined?(RubyVM::YJIT), rjitAvailable: !!defined?(RubyVM::RJIT),
  yjitEnabled: defined?(RubyVM::YJIT) ? RubyVM::YJIT.enabled? : false,
  rjitEnabled: defined?(RubyVM::RJIT) ? RubyVM::RJIT.enabled? : false,
  checksum: (1..100).sum
})
`;
const measurements = [];
for (const option of ['default', '--jit', '--yjit', '--rjit']) {
  const result = spawnSync(ruby, ['--disable=rubyopt', '-EUTF-8:UTF-8', ...(option === 'default' ? [] : [option]), '-e', probe], {
    env, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.error) throw result.error;
  const row = {
    option, exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
    runtime: result.status === 0 ? JSON.parse(result.stdout) : null,
  };
  measurements.push(row);
  console.log(`RUBY_JIT ${JSON.stringify(row)}`);
}
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify({ platform: process.platform, arch: process.arch, release: os.release(), measurements }, null, 2)}\n`);
