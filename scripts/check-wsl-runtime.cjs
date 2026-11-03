// Loads the app's WSL distribution (vendor/wsl-image/atcoder-linux.tar.gz) into Docker and checks it:
// that vendor/wsl/runtime.json describes it, its version and default user, the shared libraries,
// and through the agent running as that user,
// the Ruby version and YJIT, the AtCoder gems with the standard libraries, and Ruby LSP.
// Linux with Docker (the CI job that builds it). See docs/architecture.md#wslのエージェント.
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

async function checkRuntime(image = path.join(root, 'vendor/wsl-image/atcoder-linux.tar.gz'), manifest = path.join(root, 'vendor/wsl/runtime.json')) {
  const runtime = JSON.parse(readFileSync(manifest, 'utf8'));
  const bytes = readFileSync(image);
  assert.equal(require('node:crypto').createHash('sha256').update(bytes).digest('hex'), runtime.sha256, 'runtime.json has another SHA-256');
  assert.equal(bytes.length, runtime.bytes);
  assert.ok(runtime.url.endsWith(`/releases/download/wsl-images/atcoder-linux-${runtime.sha256}.tar.gz`), runtime.url);
  const tag = `atcoder-ruby-ide-check:${runtime.version.slice(0, 12)}`;
  const container = `atcoder-ruby-ide-check-${process.pid}`;
  execFileSync('docker', ['import', image, tag], { stdio: 'inherit' });
  let agent;
  try {
    const inside = (user, ...command) => execFileSync('docker', ['run', '--rm', '--user', user, tag, ...command], { encoding: 'utf8' });
    assert.equal(inside('root', 'cat', '/etc/atcoder-ruby-ide-version').trim(), runtime.version, 'the distribution and runtime.json disagree on the version');
    assert.match(inside('root', 'cat', '/etc/wsl.conf'), /^default=atcoder$/m);
    // find fails on a folder it cannot enter, and lists files atcoder cannot read.
    assert.equal(inside('atcoder', 'find', '/opt/atcoder-ruby-ide', '!', '-readable'), '', 'atcoderが読めないファイルがあります');
    const missing = inside('atcoder', 'sh', '-c', 'find /opt/atcoder-ruby-ide -name "*.so" -exec ldd {} \\; ; ldd /opt/atcoder-ruby-ide/ruby/bin/ruby')
      .split('\n').filter(line => line.includes('not found'));
    assert.deepEqual(missing, [], '足りない共有ライブラリがあります');
    const home = '/opt/atcoder-ruby-ide';
    agent = spawn('docker', ['run', '--rm', '-i', '--name', container, '--user', 'atcoder', tag, `${home}/atcoder-ruby-agent`, `${home}/ruby/bin/ruby`, `${home}/ruby-lsp`], { stdio: ['pipe', 'pipe', 'inherit'] });
    const waiting = new Map();
    const runs = new Map();
    createInterface({ input: agent.stdout }).on('line', line => {
      const message = JSON.parse(line);
      if (message.run !== undefined) {
        if (['completed', 'failed'].includes(message.event.type)) runs.get(message.run)(message.event);
      } else waiting.get(message.id)(message);
    });
    let id = 0;
    const ask = (command, args = null) => new Promise(resolve => {
      id += 1;
      waiting.set(id, resolve);
      agent.stdin.write(`${JSON.stringify({ id, command, args })}\n`);
    });
    const run = async (code, stdin = '') => {
      const done = new Promise(resolve => runs.set(id + 1, resolve));
      const accepted = await ask('run_ruby', { code, stdin });
      assert.equal(accepted.error, undefined, accepted.error);
      const event = await done;
      assert.equal(event.type, 'completed', event.message);
      assert.equal(event.result.status, 'completed', event.result.stderr);
      return event.result.stdout;
    };
    const info = await ask('ruby_info');
    assert.match(info.value.version, new RegExp(`^ruby ${require('../config/ruby-wsl.json').rubyVersion.replaceAll('.', '\\.')} `));
    assert.equal(await run('RubyVM::YJIT.enable; p RubyVM::YJIT.enabled?'), 'true\n');
    assert.equal(await run(readFileSync(path.join(root, 'tests/fixtures/runtime-gems.rb'), 'utf8'), '日本語\n'), readFileSync(path.join(root, 'tests/fixtures/runtime-gems.txt'), 'utf8'));
    const started = await ask('lsp_start');
    assert.equal(started.error, undefined, started.error);
    const code = 'class RuntimeCheck; def runtime_only_method; end; end\nRuntimeCheck.new.runtime_only_';
    const completion = await ask('lsp_complete', { code, line: 1, character: code.split('\n')[1].length });
    const items = completion.value?.items ?? completion.value;
    assert.ok(items?.some(item => item.label === 'runtime_only_method'), JSON.stringify(completion));
    const gem = await ask('lsp_complete', { code: 'AcLibraryRb::Fenwick', line: 0, character: 20 });
    assert.ok((gem.value?.items ?? gem.value)?.some(item => item.label === 'AcLibraryRb::FenwickTree'), JSON.stringify(gem));
    await ask('shutdown');
    console.log(`WSL distribution ${runtime.version} works as atcoder: ${info.value.version}, YJIT, AtCoder gems and Ruby LSP with their APIs`);
  } finally {
    // After a failed check the agent still runs and would keep Node waiting.
    agent?.kill('SIGKILL');
    spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    spawnSync('docker', ['rmi', '-f', tag], { stdio: 'ignore' });
  }
}
if (require.main === module) checkRuntime(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { checkRuntime };
