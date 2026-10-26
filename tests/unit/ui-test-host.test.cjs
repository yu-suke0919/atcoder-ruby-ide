const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const { access } = require('node:fs/promises');
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

async function startHost(t, largeOutput = false) {
  const binary = await ensureUiTestHostBinary();
  const host = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  const ready = new Promise(resolve => lines.on('line', line => {
    const message = JSON.parse(line);
    messages.push(message);
    const event = message.event;
    if (event?.type === 'output') {
      output += Buffer.from(event.bytes).toString('utf8');
      if (output.includes(largeOutput ? 'payload-ready\n' : '\n')) resolve(output.split('\n')[0].trim());
    }
  }));
  host.stdin.write(`${JSON.stringify({ id: 1, command: 'run_ruby', args: {
    code: `puts __dir__; ${largeOutput ? 'print "x" * 262144; puts "payload-ready";' : ''} sleep 30`, stdin: '', onEvent: 1,
  } })}\n`);
  const directory = await Promise.race([ready, exited.then(() => { throw new Error(`UI test host exited before Ruby output: ${stderr}`); })]);
  await access(directory);
  return { host, exited, directory, messages, stderr: () => stderr };
}

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
