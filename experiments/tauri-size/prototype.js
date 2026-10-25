const $ = id => document.getElementById(id);
const { invoke } = window.__TAURI__.core;
const editor = $('code-editor');
const input = $('stdin');
let running = false;
let decoders;
editor.value = 'a = gets.to_i\nb, c = gets.split.map(&:to_i)\ns = gets.chomp\n\nputs "#{a + b + c} #{s}"\n';
input.value = '1\n2 3\ntest\n';
for (const id of ['new', 'open', 'save', 'save-as']) { $(id).disabled = true; $(id).title = '容量検証版は実行・停止のみ対応'; }
$('save-state').textContent = '容量検証版';
$('message').textContent = 'Ruby の実行・停止と配布容量を検証します。';
$('run').disabled = true;
function updateLines() { $('line-numbers').textContent = editor.value.split('\n').map((_, i) => i + 1).join('\n'); }
editor.addEventListener('input', updateLines);
editor.addEventListener('scroll', () => { $('line-numbers').scrollTop = editor.scrollTop; });
updateLines();
function append(stream, text) { $(stream).append(document.createTextNode(text)); $(stream).scrollTop = $(stream).scrollHeight; }
function buttons() { $('run').disabled = running; $('stop').disabled = !running; $('clear-output').disabled = running; }
async function run() {
  if (running || $('run').disabled) return;
  running = true;
  buttons();
  $('stdout').textContent = $('stderr').textContent = '';
  decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  $('run-status').textContent = '実行中…';
  try {
    const result = await invoke('run_ruby', { code: editor.value, stdin: input.value });
    if (result.status !== 'output-limit') for (const stream of ['stdout', 'stderr']) append(stream, decoders[stream].decode());
    $('run-status').textContent = { completed: '正常終了', failed: 'エラー終了', stopped: '停止しました', timeout: '時間制限で停止（5 秒）', 'output-limit': '出力上限で停止（1 MiB）' }[result.status];
    $('run-duration').textContent = `${result.duration_ms} ms`;
  } catch (error) { $('run-status').textContent = '実行できませんでした'; $('message').textContent = String(error); }
  finally { running = false; buttons(); }
}
$('run').addEventListener('click', run);
$('stop').addEventListener('click', () => invoke('stop_ruby'));
$('clear-output').addEventListener('click', () => { $('stdout').textContent = $('stderr').textContent = ''; });
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); run(); } });
(async () => {
  await window.__TAURI__.event.listen('ruby-output', ({ payload }) => {
    if (decoders) append(payload.stream, decoders[payload.stream].decode(new Uint8Array(payload.bytes), { stream: true }));
  });
  const info = await invoke('ruby_info');
  $('ruby-version').textContent = info.version;
  $('run').disabled = false;
})().catch(error => { $('message').textContent = String(error); });
