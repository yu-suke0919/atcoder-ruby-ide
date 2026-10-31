const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ruby = process.env.RUBY_PATH || (process.platform === 'win32' ? path.join(root, 'vendor/ruby/bin/ruby.exe') : 'ruby');
const report = path.resolve(process.argv[2] || path.join(root, 'artifacts/reports/ruby-recursion.json'));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|RUBYGEMS_GEMDEPS|BUNDLE_.*|BUNDLER_ORIG_.*|RUBY_THREAD_VM_STACK_SIZE|RUBY_THREAD_MACHINE_STACK_SIZE)$/i.test(key)) delete env[key];
}
env.RUBY_THREAD_VM_STACK_SIZE = String(32 * 1024 * 1024);
const probe = `
require 'json'
Gem.use_paths(Gem.default_dir)
def completes?(method, depth)
  result = send(method, depth)
  raise 'Unexpected recursion result' unless result == depth
  true
rescue SystemStackError
  false
end
method = ARGV.fetch(0)
low = 0
high = 100_000
raise 'Expected a passing lower and failing upper bound' unless completes?(method, low) && !completes?(method, high)
probes = []
while high - low > 1
  depth = (low + high) / 2
  completed = completes?(method, depth)
  probes << { depth: depth, completed: completed }
  completed ? low = depth : high = depth
end
raise 'Unstable boundary within one process' unless completes?(method, low) && !completes?(method, high)
native_limit = begin
  Process.getrlimit(:STACK).first
rescue NotImplementedError
  nil
end
puts JSON.generate({ method: method, ruby: RUBY_DESCRIPTION,
  vmStackBytes: RubyVM::DEFAULT_PARAMS.fetch(:thread_vm_stack_size), nativeStackLimitBytes: native_limit,
  maxSuccessfulDepth: low, firstFailingDepth: high, probes: probes })
`;
const measurements = [];
for (const method of ['count_down_with_each', 'count_down_with_block']) {
  for (let trial = 1; trial <= 3; trial++) {
    const output = execFileSync(ruby, ['--disable=rubyopt', '-EUTF-8:UTF-8', '-r', path.join(root, 'tests/fixtures/deep-recursion.rb'), '-e', probe, method], {
      env, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    const row = { trial, ...JSON.parse(output) };
    if (row.vmStackBytes !== Number(env.RUBY_THREAD_VM_STACK_SIZE)) throw new Error('Ruby ignored the requested VM stack size');
    measurements.push(row);
    console.log(`RUBY_RECURSION ${JSON.stringify(row)}`);
  }
}
mkdirSync(path.dirname(report), { recursive: true });
writeFileSync(report, `${JSON.stringify({ platform: process.platform, release: os.release(), arch: process.arch, measurements }, null, 2)}\n`);
