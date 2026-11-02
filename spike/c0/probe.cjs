// C0 spike (not for merge): drives agent.rb through wsl.exe from Windows and prints a JSON report.
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const report = {};
const time = (label, fn) => { const start = performance.now(); const value = fn(); report[label] = Math.round(performance.now() - start); return value; };
const wsl = args => execFileSync('wsl.exe', args, { encoding: 'utf8' });

(async () => {
  report.version = wsl(['--version']).replace(/\0/g, '').trim().split('\n').slice(0, 3);
  time('firstTrueMs', () => wsl(['-e', 'true']));
  time('secondTrueMs', () => wsl(['-e', 'true']));
  report.distributions = wsl(['-l', '-v']).replace(/\0/g, '').trim().split('\n').map(line => line.trim());
  const ruby = '/root/.atcoder-ruby/ruby/bin/ruby';
  report.ruby = wsl(['-e', ruby, '-v']).trim();
  // Three short runs of the moved Ruby in a row: the first one after extracting it reads the files cold.
  report.rubyRunsMs = [0, 1, 2].map(() => { const start = performance.now(); wsl(['-e', ruby, '-e', '0']); return Math.round(performance.now() - start); });
  const agentPath = wsl(['-e', 'wslpath', '-a', path.join(__dirname, 'agent.rb').replaceAll('\\', '/')]).trim();
  const started = performance.now();
  const agent = spawn('wsl.exe', ['-e', ruby, agentPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: agent.stdout });
  const waiting = [];
  const chunks = [];
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'chunk') { chunks.push(message); return; }
    waiting.shift()(message);
  });
  const ask = request => new Promise(resolve => { waiting.push(resolve); agent.stdin.write(JSON.stringify(request) + '\n'); });
  const first = await ask({ type: 'echo', id: 0, text: '起動' });
  report.agentStartMs = Math.round(performance.now() - started);
  report.firstEcho = first.text;
  // Many small requests, including Japanese, emoji and control characters.
  const texts = Array.from({ length: 1000 }, (_, i) => `日本語 ${i} 😀\t"quote"\\`);
  const echoStart = performance.now();
  let mismatched = 0;
  for (const [i, text] of texts.entries()) if ((await ask({ type: 'echo', id: i, text })).text !== text) mismatched++;
  report.echo = { count: texts.length, mismatched, ms: Math.round(performance.now() - echoStart) };
  const floodStart = performance.now();
  await ask({ type: 'flood', id: 1, lines: 20000 });
  report.flood = { lines: chunks.length, inOrder: chunks.every((c, i) => c.i === i), bytes: chunks.reduce((n, c) => n + Buffer.byteLength(c.text), 0), ms: Math.round(performance.now() - floodStart) };
  const spawned = await ask({ type: 'spawn', id: 2 });
  report.sleepingBeforeKill = Number(wsl(['-e', 'bash', '-c', 'pgrep -x sleep | wc -l']).trim());
  report.killed = await ask({ type: 'kill', id: 3, pid: spawned.pid });
  report.limits = await ask({ type: 'limits', id: 4 });
  const count = pattern => Number(wsl(['-e', 'bash', '-c', `pgrep -f '${pattern}' | wc -l`]).trim());
  const sleeping = () => Number(wsl(['-e', 'bash', '-c', 'pgrep -x sleep | wc -l']).trim());
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  // 1. Closing the agent's stdin (the app quits normally): does the agent stop its groups?
  await ask({ type: 'spawn', id: 5 });
  const exited = new Promise(resolve => agent.on('exit', code => resolve(code)));
  agent.stdin.end();
  report.afterEof = { exitCode: await Promise.race([exited, pause(5000).then(() => 'still running')]) };
  await pause(500);
  Object.assign(report.afterEof, { agent: count('[a]gent.rb'), sleeping: sleeping() });
  wsl(['-e', 'bash', '-c', 'pkill -x sleep; rm -f /tmp/c0-agent-signal; true']);
  // 2. Killing wsl.exe from Windows (the app crashed): which signal arrives, and what is left?
  const second = spawn('wsl.exe', ['-e', ruby, agentPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const secondLines = readline.createInterface({ input: second.stdout });
  const secondAsk = request => new Promise(resolve => { secondLines.once('line', line => resolve(JSON.parse(line))); second.stdin.write(JSON.stringify(request) + '\n'); });
  await secondAsk({ type: 'spawn', id: 6 });
  await secondAsk({ type: 'spawn', id: 7, timeout: 8 });
  execFileSync('taskkill.exe', ['/PID', String(second.pid), '/T', '/F']);
  await pause(3000);
  const signal = () => wsl(['-e', 'bash', '-c', 'cat /tmp/c0-agent-signal 2>/dev/null || echo none']).trim();
  report.afterTaskkill = { agent: count('[a]gent.rb'), signal: signal(), sleeping: sleeping(), timeoutGroups: count('[t]imeout -s KILL') };
  // The group under timeout should be gone once its 8 seconds are over; the plain group stays.
  await pause(7000);
  report.afterTimeout = { sleeping: sleeping(), timeoutGroups: count('[t]imeout -s KILL') };
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); console.log(JSON.stringify(report, null, 2)); process.exit(1); });
