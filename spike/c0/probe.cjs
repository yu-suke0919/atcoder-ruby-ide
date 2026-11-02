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
  report.ruby = wsl(['-e', 'ruby', '-v']).trim();
  const agentPath = wsl(['-e', 'wslpath', '-a', path.join(__dirname, 'agent.rb').replaceAll('\\', '/')]).trim();
  const started = performance.now();
  const agent = spawn('wsl.exe', ['-e', 'ruby', agentPath], { stdio: ['pipe', 'pipe', 'inherit'] });
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
  // Killing wsl.exe from Windows: do the agent and its children stop?
  await ask({ type: 'spawn', id: 5 });
  execFileSync('taskkill.exe', ['/PID', String(agent.pid), '/T', '/F']);
  await new Promise(resolve => setTimeout(resolve, 3000));
  report.afterTaskkill = {
    agent: Number(wsl(['-e', 'bash', '-c', `pgrep -f '${agentPath}' | wc -l`]).trim()),
    sleeping: Number(wsl(['-e', 'bash', '-c', 'pgrep -x sleep | wc -l']).trim())
  };
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); console.log(JSON.stringify(report, null, 2)); process.exit(1); });
