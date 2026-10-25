const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const INPUT_LIMIT = 1024 * 1024;

class RubyRunner extends EventEmitter {
  constructor({ rubyPath = 'ruby', timeoutMs = 5000, outputLimit = INPUT_LIMIT } = {}) {
    super();
    this.rubyPath = rubyPath;
    this.timeoutMs = timeoutMs;
    this.outputLimit = outputLimit;
    this.active = null;
  }

  get busy() { return this.active !== null; }

  stop(reason = 'stopped') {
    const state = this.active;
    if (!state) return false;
    state.reason ||= reason;
    const child = state.child;
    if (!child?.pid || state.killRequested) return true;
    state.killRequested = true;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    }
    return true;
  }

  async run({ code, stdin, cwd } = {}) {
    if (this.busy) throw new Error('すでに実行中です。停止または終了後に実行してください。');
    for (const [name, value] of [['コード', code], ['標準入力', stdin]]) {
      if (typeof value !== 'string') throw new Error(`${name}は文字列で指定してください。`);
      if (Buffer.byteLength(value, 'utf8') > INPUT_LIMIT) throw new Error(`${name}は 1 MiB 以下にしてください。`);
    }
    const state = { child: null, reason: null, killRequested: false };
    this.active = state;
    const started = performance.now();
    const result = { status: 'failed', stdout: '', stderr: '', exitCode: null, signal: null, durationMs: 0 };
    let directory;
    let timer;
    try {
      directory = await mkdtemp(path.join(tmpdir(), 'atcoder-ruby-'));
      const source = path.join(directory, 'solution.rb');
      const bootstrap = path.join(directory, 'stdio.rb');
      await writeFile(source, code, 'utf8');
      await writeFile(bootstrap, '[STDIN, STDOUT, STDERR].each { |io| io.binmode; io.set_encoding(Encoding::UTF_8) }; STDOUT.sync = true; STDERR.sync = true\n', 'utf8');
      if (state.reason) {
        result.status = state.reason;
        return result;
      }
      const child = spawn(this.rubyPath, ['-EUTF-8:UTF-8', '-r', bootstrap, source], {
        cwd: cwd || directory,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });
      state.child = child;
      let byteCount = 0;
      const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      const publish = (stream, text) => {
        if (!text) return;
        result[stream] += text;
        this.emit('output', { stream, text });
      };
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', (chunk) => {
          if (state.reason === 'output-limit') return;
          const remaining = this.outputLimit - byteCount;
          const bytes = chunk.subarray(0, remaining);
          byteCount += bytes.length;
          publish(stream, decoders[stream].write(bytes));
          if (byteCount >= this.outputLimit) this.stop('output-limit');
        });
      }
      // Ruby may exit without reading stdin, which legitimately closes this pipe.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin, 'utf8');
      timer = setTimeout(() => this.stop('timeout'), this.timeoutMs);
      await new Promise((resolve) => {
        child.on('error', (error) => {
          publish('stderr', `Ruby を起動できませんでした: ${error.message}\n`);
        });
        child.on('close', (exitCode, signal) => {
          if (state.reason !== 'output-limit') {
            for (const stream of ['stdout', 'stderr']) publish(stream, decoders[stream].end());
          }
          result.exitCode = exitCode;
          result.signal = signal;
          result.status = state.reason || (exitCode === 0 ? 'completed' : 'failed');
          resolve();
        });
      });
      return result;
    } finally {
      clearTimeout(timer);
      if (directory) await rm(directory, { recursive: true, force: true });
      result.durationMs = Math.round(performance.now() - started);
      this.active = null;
    }
  }
}

module.exports = { RubyRunner };
