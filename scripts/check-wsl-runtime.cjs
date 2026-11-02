// Extracts vendor/wsl/atcoder-runtime.tar.gz into a new folder and checks it through its agent:
// the Ruby version and YJIT, the AtCoder gems with the standard libraries, and Ruby LSP.
// Linux only (the CI job that builds the runtime). See docs/architecture.md#wslのエージェント.
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

async function checkRuntime(archive = path.join(root, 'vendor/wsl/atcoder-runtime.tar.gz')) {
  const runtime = JSON.parse(readFileSync(path.join(path.dirname(archive), 'runtime.json'), 'utf8'));
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), runtime.sha256, 'runtime.json の SHA-256 がアーカイブと一致しません');
  const folder = mkdtempSync(path.join(tmpdir(), 'atcoder-runtime-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', folder]);
    const missing = execFileSync('sh', ['-c', 'find "$1" -name "*.so" -exec ldd {} \\; ; ldd "$1/ruby/bin/ruby"', 'sh', folder], { encoding: 'utf8' })
      .split('\n').filter(line => line.includes('not found'));
    assert.deepEqual(missing, [], '足りない共有ライブラリがあります');
    const agent = spawn(path.join(folder, 'atcoder-ruby-agent'), [path.join(folder, 'ruby/bin/ruby'), path.join(folder, 'ruby-lsp')], { stdio: ['pipe', 'pipe', 'inherit'] });
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
    await ask('shutdown');
    console.log(`WSL runtime ${runtime.sha256} works: ${info.value.version}, YJIT, AtCoder gems and Ruby LSP`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
if (require.main === module) checkRuntime(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { checkRuntime };
