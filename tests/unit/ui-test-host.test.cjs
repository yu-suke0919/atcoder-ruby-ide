const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { access, mkdtemp, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { ensureUiTestHostBinary } = require('../e2e/browser.cjs');

test('UI runner selection preserves OS defaults, supports overrides and rejects typos', () => {
  const source = `const support = require('./tests/e2e/support.cjs');
    process.stdout.write(support.launch === require('./tests/e2e/native.cjs').launch ? 'native' : 'browser');`;
  const select = runner => {
    const env = { ...process.env };
    delete env.E2E_RUNNER;
    delete env.NODE_TEST_CONTEXT;
    if (runner !== undefined) env.E2E_RUNNER = runner;
    return execFileSync(process.execPath, ['-e', source], {
      cwd: path.resolve(__dirname, '../..'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  };
  assert.equal(select(), process.platform === 'win32' ? 'native' : 'browser');
  assert.equal(select('native'), 'native');
  assert.equal(select('browser'), 'browser');
  assert.throws(() => select('brower'), error => /E2E_RUNNER/.test(error.stderr));
});

async function startHost(t, largeOutput = false, env = {}, code = 'sleep 30', stdin = '') {
  const binary = await ensureUiTestHostBinary();
  const host = spawn(binary, [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(host, 'close');
  const messages = [];
  let stderr = '';
  host.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill();
    await exited;
  });
  const lines = createInterface({ input: host.stdout });
  let output = '';
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const ready = new Promise(resolve => lines.on('line', line => {
    const message = JSON.parse(line);
    messages.push(message);
    const event = message.event;
    if (event?.type === 'completed') finish(event.result);
    if (event?.type === 'output' && event.stream === 'stdout') {
      output += Buffer.from(event.bytes).toString('utf8');
      if (output.includes(largeOutput ? 'payload-ready\n' : '\n')) resolve(output.split('\n')[0].trim());
    }
  }));
  host.stdin.write(`${JSON.stringify({ id: 1, command: 'run_ruby', args: {
    code: `puts __dir__; ${largeOutput ? 'print "x" * 262144; puts "payload-ready";' : ''} ${code}`, stdin, onEvent: 1,
  } })}\n`);
  const directory = await Promise.race([
    ready,
    completed.then(result => { throw new Error(`Ruby completed before startup output: ${result.stderr}`); }),
    exited.then(() => { throw new Error(`UI test host exited before Ruby output: ${stderr}`); }),
  ]);
  await access(directory);
  return { host, exited, directory, messages, completed, stderr: () => stderr };
}

test('M19: external gem settings cannot hide or replace the selected Ruby gems', { timeout: 15000 }, async t => {
  const external = await mkdtemp(path.join(tmpdir(), 'IDE-external-gems-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const code = await readFile(path.join(__dirname, '../fixtures/runtime-gems.rb'), 'utf8');
  const expected = await readFile(path.join(__dirname, '../fixtures/runtime-gems.txt'), 'utf8');
  const { host, completed } = await startHost(t, false, { GEM_HOME: external, GEM_PATH: external }, `${code}\nputs(Gem.path == [Gem.default_dir])`, '日本語\n');
  const result = await completed;
  assert.equal(result.status, 'completed', result.stderr);
  assert.equal(result.stdout.slice(result.stdout.indexOf('\n') + 1), `${expected}true\n`);
  host.stdin.end();
});

test('M19: Ruby startup excludes inherited options, libraries and Bundler context', { timeout: 30000 }, async t => {
  const external = await mkdtemp(path.join(tmpdir(), 'IDE-external Ruby 日本語 '));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'json.rb'), 'raise "external json.rb was loaded"\n');
  const inherited = {
    RUBYOPT: '-rbundler/setup', RUBYLIB: external,
    BUNDLE_GEMFILE: path.join(external, 'missing-Gemfile'), GEM_HOME: external, GEM_PATH: external,
    RUBYGEMS_GEMDEPS: '-', BUNDLE_PATH: external, BUNDLE_WITHOUT: 'default', BUNDLER_ORIG_RUBYOPT: '-rbundler/setup',
    bundle_custom: 'remove-me',
  };
  const fixture = await readFile(path.join(__dirname, '../fixtures/runtime-gems.rb'), 'utf8');
  const expected = await readFile(path.join(__dirname, '../fixtures/runtime-gems.txt'), 'utf8');
  const checkEnvironment = 'puts ENV.keys.none? { |name| name.match?(/\\A(?:RUBYOPT|RUBYLIB|GEM_HOME|GEM_PATH|RUBYGEMS_GEMDEPS|BUNDLE_.*|BUNDLER_ORIG_.*)\\z/i) }; puts(Gem.path == [Gem.default_dir])';
  for (const [name, env] of [
    ['preload', { RUBYOPT: '-ride_missing_startup_library' }],
    ['disable RubyGems', { RUBYOPT: '--disable-gems' }],
    ['library shadowing', { RUBYLIB: external }],
    ['Gemfile', { BUNDLE_GEMFILE: inherited.BUNDLE_GEMFILE }],
    ['combined Bundler context', inherited],
  ]) {
    await t.test(name, async t => {
      const { host, completed } = await startHost(t, false, env, `${fixture}\n${checkEnvironment}`, '日本語\n');
      const result = await completed;
      assert.equal(result.status, 'completed', result.stderr);
      assert.equal(result.stdout.slice(result.stdout.indexOf('\n') + 1), `${expected}true\ntrue\n`);
      assert.equal(result.stderr, '');
      host.stdin.end();
    });
  }
});

test('stdio host stops Ruby and removes its temp directory when stdin closes or panics', { timeout: 15000 }, async t => {
  for (const [name, malformed, largeOutput] of [['EOF', false, false], ['EOF with a large final event', false, true], ['malformed input', true, false]]) {
    await t.test(name, async t => {
      const { host, exited, directory, messages } = await startHost(t, largeOutput);
      host.stdin.end(malformed ? 'invalid JSON\n' : undefined);
      const [code, signal] = await exited;
      assert.equal(signal, null);
      assert.equal(code, malformed ? 101 : 0);
      await assert.rejects(access(directory), { code: 'ENOENT' });
      assert.ok(messages.some(message => message.event?.type === 'completed'), 'The final event must finish before the host exits');
    });
  }
});

test('a disconnected stdout does not panic or prevent host shutdown', { timeout: 15000 }, async t => {
  const { host, exited, directory, stderr } = await startHost(t);
  host.stdout.destroy();
  host.stdin.end(`${JSON.stringify({ id: 2, command: 'shutdown' })}\n`);
  const [code, signal] = await exited;
  assert.equal(signal, null);
  assert.equal(code, 0, stderr());
  assert.doesNotMatch(stderr(), /panicked/);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});


test('only the UI test host can shorten its Ruby execution timeout', { timeout: 10000 }, async t => {
  const { host, completed } = await startHost(t, false, { ATCODER_IDE_UI_TIMEOUT_MS: '1000' });
  const result = await completed;
  assert.equal(result.status, 'timeout');
  assert.ok(result.durationMs >= 1000 && result.durationMs < 4000, `duration: ${result.durationMs}`);
  host.stdin.end();
});
