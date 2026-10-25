import { ide } from './bridge.js';

const $ = (id) => document.getElementById(id);
const editor = $('code-editor');
const input = $('stdin');
const expectedOutput = $('expected-output');
const compareOutput = $('compare-output');
const sample = 'a = gets.to_i\nb, c = gets.split.map(&:to_i)\ns = gets.chomp\n\nputs "#{a + b + c} #{s}"\n';
editor.value = sample;
input.value = '1\n2 3\ntest\n';
expectedOutput.value = '6 test\n';
let savedCode = sample;
let filePath = null;
let running = false;
let fileBusy = false;
let rubyAvailable = false;
let comparisonRevision = 0;
let currentRun = null;
let closing = false;

async function confirmDiscard() {
  return editor.value === savedCode || await ide.confirmDiscard();
}

function showComparison(state) {
  const labels = { none: '比較なし', pending: '未比較', running: '比較中…', matched: '一致', mismatched: '不一致', unavailable: '判定なし' };
  $('comparison-status').textContent = labels[state];
  $('comparison-status').dataset.state = state;
}

function resetComparison() {
  comparisonRevision++;
  expectedOutput.disabled = !compareOutput.checked;
  showComparison(compareOutput.checked ? 'pending' : 'none');
}

function message(text, error = false) {
  $('message').textContent = text;
  $('message').dataset.error = String(error);
}

function updateEditor() {
  const dirty = editor.value !== savedCode;
  const name = filePath ? filePath.split(/[\\/]/).at(-1) : '無題.rb';
  ide.setTitle(`${dirty ? '● ' : ''}${name} — AtCoder Ruby IDE`).catch(() => {});
  $('save-state').textContent = dirty ? '● 未保存の変更' : filePath ? '保存済み' : '未保存のファイル';
  $('file-path').textContent = filePath || '無題.rb';
  $('file-path').title = filePath || '未保存のファイル';
  $('line-numbers').textContent = Array.from({ length: editor.value.split('\n').length }, (_, i) => i + 1).join('\n');
  updateCursor();
}

function updateCursor() {
  const beforeCursor = editor.value.slice(0, editor.selectionStart).split('\n');
  $('cursor-position').textContent = `Ln ${beforeCursor.length}, Col ${beforeCursor.at(-1).length + 1}`;
}

function updateButtons() {
  $('run').disabled = running || !rubyAvailable || fileBusy || closing;
  $('stop').disabled = !running;
  $('clear-output').disabled = running;
  for (const id of ['new', 'open', 'save', 'save-as']) $(id).disabled = fileBusy || closing;
  editor.readOnly = fileBusy || closing;
}

async function fileAction(action) {
  if (fileBusy || closing) return;
  fileBusy = true;
  updateButtons();
  try { await action(); }
  catch (error) { message(`ファイル操作に失敗しました：${error.message}`, true); }
  finally { fileBusy = false; updateButtons(); }
}

function openFile() {
  return fileAction(async () => {
    if (!await confirmDiscard()) return;
    const result = await ide.openFile();
    if (result.canceled) return;
    editor.value = result.code;
    savedCode = editor.value;
    filePath = result.filePath;
    resetComparison();
    updateEditor();
    message('ファイルを開きました。');
  });
}

function saveFile(saveAs = false) {
  return fileAction(async () => {
    const code = editor.value;
    const result = await ide.saveFile(code, saveAs);
    if (result.canceled) return;
    if (filePath !== result.filePath) resetComparison();
    savedCode = code;
    filePath = result.filePath;
    updateEditor();
    message('ファイルを保存しました。');
  });
}

async function run() {
  if (running || fileBusy || closing || !rubyAvailable) return;
  const revision = comparisonRevision;
  const expected = compareOutput.checked ? expectedOutput.value : null;
  running = true;
  updateButtons();
  $('stdout').textContent = '';
  $('stderr').textContent = '';
  $('run-status').textContent = '実行中…';
  $('run-duration').textContent = '— ms';
  showComparison(expected === null ? 'none' : 'running');
  message('Ruby を実行しています。');
  try {
    const pending = ide.run(editor.value, input.value, expected, appendOutput);
    currentRun = pending;
    const result = await pending;
    $('stdout').textContent = result.stdout;
    $('stderr').textContent = result.stderr;
    const statuses = {
      completed: '正常終了', failed: `エラー終了${result.exitCode === null ? '' : ` (${result.exitCode})`}`,
      stopped: '停止しました', timeout: '時間制限で停止（5 秒）', 'output-limit': '出力上限で停止（1 MiB）'
    };
    $('run-status').textContent = statuses[result.status];
    $('run-duration').textContent = `${result.durationMs} ms`;
    if (revision === comparisonRevision && expected !== null) {
      showComparison(result.comparison === null ? 'unavailable' : result.comparison ? 'matched' : 'mismatched');
    }
    message(result.status === 'completed' ? '実行が完了しました。' : statuses[result.status], ['failed', 'timeout', 'output-limit'].includes(result.status));
  } catch (error) {
    $('run-status').textContent = '実行できませんでした';
    if (revision === comparisonRevision && expected !== null) showComparison('unavailable');
    message(error.message, true);
  } finally { currentRun = null; running = false; updateButtons(); }
}

function appendOutput({ stream, text }) {
  const output = stream === 'stderr' ? $('stderr') : $('stdout');
  output.append(document.createTextNode(text));
  output.scrollTop = output.scrollHeight;
}
$('run').addEventListener('click', run);
$('stop').addEventListener('click', async () => {
  try { await ide.stop(); }
  catch (error) { message(error.message, true); }
});
$('open').addEventListener('click', openFile);
$('save').addEventListener('click', () => saveFile());
$('save-as').addEventListener('click', () => saveFile(true));
$('new').addEventListener('click', () => fileAction(async () => {
  if (!await confirmDiscard()) return;
  await ide.newFile();
  editor.value = '';
  savedCode = '';
  filePath = null;
  resetComparison();
  updateEditor();
  message('新しいファイルを作成しました。');
}));
$('clear-output').addEventListener('click', () => {
  resetComparison();
  $('stdout').textContent = '';
  $('stderr').textContent = '';
  $('run-status').textContent = '実行する準備ができています';
  $('run-duration').textContent = '— ms';
});
input.addEventListener('input', resetComparison);
expectedOutput.addEventListener('input', resetComparison);
compareOutput.addEventListener('change', resetComparison);
editor.addEventListener('input', () => { resetComparison(); updateEditor(); });
editor.addEventListener('click', updateCursor);
editor.addEventListener('keyup', updateCursor);
editor.addEventListener('scroll', () => { $('line-numbers').scrollTop = editor.scrollTop; });
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && !editor.readOnly) {
    event.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
    resetComparison();
    updateEditor();
  }
});
document.addEventListener('keydown', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  const key = event.key.toLowerCase();
  if (['s', 'o', 'enter'].includes(key)) event.preventDefault();
  if (key === 's') saveFile(event.shiftKey);
  if (key === 'o') openFile();
  if (key === 'enter') run();
});

resetComparison();
updateEditor();
updateButtons();
ide.onCloseRequested(async event => {
  event.preventDefault();
  if (closing) return;
  closing = true;
  updateButtons();
  try {
    if (!await confirmDiscard()) return;
    await ide.stop();
    await currentRun?.catch(() => {});
    await ide.destroy();
  } finally { closing = false; updateButtons(); }
}).catch(error => message(String(error), true));

ide.rubyInfo().then((info) => {
  rubyAvailable = info.available;
  $('ruby-version').textContent = info.version;
  $('ruby-version').title = info.version;
  if (!info.available) message('Ruby を起動できません。インストール状態を確認してください。', true);
  updateButtons();
}).catch((error) => { $('ruby-version').textContent = 'Ruby を起動できません'; message(String(error), true); });
