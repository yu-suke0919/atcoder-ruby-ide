const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { RubyRunner } = require('../../src/ruby-runner.cjs');
const rubyPath = process.env.RUBY_PATH || 'ruby';

test('M04: stdin reaches Ruby through EOF and stdout is streamed', async () => {
  const runner = new RubyRunner({ rubyPath });
  const events = [];
  runner.on('output', (event) => events.push(event));
  const result = await runner.run({ code: 'a = gets.to_i; b, c = gets.split.map(&:to_i); s = gets.chomp; puts "#{a+b+c} #{s}"; puts STDIN.read.empty?', stdin: '1\n2 3\ntest\n' });
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '6 test\ntrue\n');
  assert.equal(result.stderr, '');
  assert.equal(events.filter((e) => e.stream === 'stdout').map((e) => e.text).join(''), result.stdout);
  assert.ok(result.durationMs >= 0);
});

test('M05: Japanese output and stderr stay separate', async () => {
  const runner = new RubyRunner({ rubyPath });
  const result = await runner.run({ code: 'puts STDIN.read; warn "標準エラー"', stdin: 'こんにちは\n' });
  assert.equal(result.stdout, 'こんにちは\n');
  assert.equal(result.stderr, '標準エラー\n');
});

test('M05: ordinary puts streams before exit and input newlines remain unchanged', async () => {
  const runner = new RubyRunner({ rubyPath });
  const ready = once(runner, 'output', { signal: AbortSignal.timeout(2000) });
  const pending = runner.run({ code: 'puts STDIN.read.bytes.join(","); sleep 10', stdin: '\r\n' });
  try {
    const [event] = await ready;
    assert.equal(event.text, '13,10\n');
  } finally {
    runner.stop();
    await pending;
  }
});

test('M05: a Ruby syntax error is reported and a later run succeeds', async () => {
  const runner = new RubyRunner({ rubyPath });
  const failed = await runner.run({ code: 'puts(', stdin: '' });
  assert.equal(failed.status, 'failed');
  assert.notEqual(failed.exitCode, 0);
  assert.match(failed.stderr, /syntax|Syntax|unexpected/i);
  const next = await runner.run({ code: 'puts 42', stdin: '' });
  assert.equal(next.stdout, '42\n');
  assert.equal(next.status, 'completed');
});

test('M05: a missing Ruby executable produces a useful result', async () => {
  const runner = new RubyRunner({ rubyPath: path.join(tmpdir(), 'missing-atcoder-ruby-executable') });
  const result = await runner.run({ code: 'puts 1', stdin: '' });
  assert.equal(result.status, 'failed');
  assert.match(result.stderr, /Ruby|ENOENT/);
  assert.equal(runner.busy, false);
});

test('M06: infinite execution times out and can be run again', async () => {
  const runner = new RubyRunner({ rubyPath, timeoutMs: 400 });
  const result = await runner.run({ code: 'loop {}', stdin: '' });
  assert.equal(result.status, 'timeout');
  assert.equal(runner.busy, false);
  assert.equal((await runner.run({ code: 'puts 7', stdin: '' })).stdout, '7\n');
});

test('M06/M07: stop an active run and reject simultaneous execution', async () => {
  const runner = new RubyRunner({ rubyPath });
  const ready = once(runner, 'output');
  const pending = runner.run({ code: '$stdout.sync = true; puts "ready"; loop { sleep 0.01 }', stdin: '' });
  await ready;
  await assert.rejects(runner.run({ code: 'puts 2', stdin: '' }), /実行中/);
  assert.equal(runner.stop(), true);
  assert.equal((await pending).status, 'stopped');
  assert.equal(runner.stop(), false);
});

test('M06: stopping immediately before spawn is safe', async () => {
  const runner = new RubyRunner({ rubyPath });
  const pending = runner.run({ code: 'loop {}', stdin: '' });
  runner.stop();
  assert.equal((await pending).status, 'stopped');
  assert.equal(runner.busy, false);
});

test('M07: execute the current buffer in the selected file directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'Ruby IDE 日本語 '));
  try {
    await writeFile(path.join(directory, 'input.txt'), '作業ディレクトリ', 'utf8');
    const runner = new RubyRunner({ rubyPath });
    const result = await runner.run({ code: 'puts File.read("input.txt", encoding: "UTF-8")', stdin: '', cwd: directory });
    assert.equal(result.stdout, '作業ディレクトリ\n');
    assert.equal(result.status, 'completed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('M08: reject malformed and oversized input before starting Ruby', async () => {
  const runner = new RubyRunner({ rubyPath });
  await assert.rejects(runner.run({ code: 1, stdin: '' }), /コード/);
  await assert.rejects(runner.run({ code: '', stdin: null }), /標準入力/);
  await assert.rejects(runner.run({ code: 'あ'.repeat(400000), stdin: '' }), /1 MiB/);
  await assert.rejects(runner.run({ code: '', stdin: 'x'.repeat(1048577) }), /1 MiB/);
  assert.equal(runner.busy, false);
});

test('M08: stop excessive output at the shared byte limit', async () => {
  const runner = new RubyRunner({ rubyPath, outputLimit: 1024 });
  const result = await runner.run({ code: '$stdout.sync = true; loop { print "あいうえお" }', stdin: '' });
  assert.equal(result.status, 'output-limit');
  assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 1024);
  assert.ok(result.stdout.length > 0);
  assert.ok(!result.stdout.includes('\uFFFD'));
});

for (const reason of ['stopped', 'timeout']) {
  test(`R04: output limit discards incomplete UTF-8 after a ${reason} request`, async () => {
    const runner = new RubyRunner({ rubyPath, outputLimit: 10 });
    const events = [];
    runner.on('output', (event) => events.push(event));
    const ready = once(runner, 'output', { signal: AbortSignal.timeout(5000) });
    const pending = runner.run({ code: 'puts "ready"; sleep 10', stdin: '' });
    try {
      const [event] = await ready;
      assert.equal(event.text, 'ready\n');
      const child = runner.active.child;
      runner.stop(reason);
      // Deliver buffered pipe data before close, without relying on OS timing.
      // Each stream has an incomplete UTF-8 character when the shared cap is hit.
      for (const stream of ['stdout', 'stderr']) {
        child[stream].emit('data', Buffer.from([0xe3, 0x81]));
      }
      for (const stream of ['stdout', 'stderr']) {
        child[stream].emit('data', Buffer.from([0x82, 0x78]));
      }
      const result = await pending;
      assert.equal(result.status, reason);
      assert.equal(result.stdout, 'ready\n');
      assert.equal(result.stderr, '');
      assert.deepEqual(events, [{ stream: 'stdout', text: 'ready\n' }]);
      assert.equal(runner.busy, false);
    } finally {
      runner.stop();
      await pending;
    }
  });
}

test('M06: stop descendants as well as their Ruby parent on either OS', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'IDE-process-tree-'));
  const runner = new RubyRunner({ rubyPath });
  try {
    const ready = once(runner, 'output');
    const pending = runner.run({
      code: 'require "rbconfig"; $stdout.sync = true; pid = spawn(RbConfig.ruby, "-e", "sleep 0.8; File.write(\'orphan.txt\', \'survived\')", out: File::NULL, err: File::NULL); puts "ready"; Process.wait(pid)',
      stdin: '', cwd: directory
    });
    await ready;
    runner.stop();
    assert.equal((await pending).status, 'stopped');
    await require('node:timers/promises').setTimeout(1200);
    const { readFile } = require('node:fs/promises');
    await assert.rejects(readFile(path.join(directory, 'orphan.txt')), { code: 'ENOENT' });
  } finally {
    runner.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('temporary source files are removed after execution', async () => {
  const runner = new RubyRunner({ rubyPath });
  const result = await runner.run({ code: 'puts __FILE__', stdin: '' });
  const { access } = require('node:fs/promises');
  assert.equal(result.status, 'completed');
  await assert.rejects(access(result.stdout.trim()), { code: 'ENOENT' });
});

test('R02: a cleanup failure does not leave the runner busy', { skip: process.platform === 'win32' }, async () => {
  const runner = new RubyRunner({ rubyPath });
  let directory;
  runner.on('output', (event) => { if (event.stream === 'stdout' && !directory) directory = event.text.trim(); });
  const { chmod } = require('node:fs/promises');
  try {
    await assert.rejects(runner.run({ code: 'puts __dir__; File.chmod(0, __dir__)', stdin: '' }), { code: 'EACCES' });
    assert.equal(runner.busy, false);
    assert.equal((await runner.run({ code: 'puts 42', stdin: '' })).stdout, '42\n');
  } finally {
    if (directory) {
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  }
});
